import type { RiskLevel, Whitelist, WhitelistGate, WhitelistItem, WhitelistScope } from '@eight/shared';
import { J, nowIso, openDb, uid } from '../db.ts';
import { calendarFromEnv, isWorkTime } from './handoff.ts';

/**
 * 白名单签发（CS-015 / ADR-0042 / CS-007）：
 * - owned（自有渠道 web/app/wechat）：白名单内场景全时段自动回复
 * - platform（天猫等渠道平台）：只在非人工时段按白名单自动回复，工作时段一律辅助模式（CS-004/CS-008B）
 * - 版本化：draft → signed（售后负责人）→ published（平台管理员）→ disabled；同 scope 只有一个 published
 * - 默认拒绝：没有 published 版本时不允许任何自动回复
 */
const db = () => openDb();
const OWNED = new Set(['web', 'app', 'wechat']);
export const scopeOfChannel = (channel: string): WhitelistScope => (OWNED.has(channel) ? 'owned' : 'platform');
const RANK: Record<string, number> = { L0: 0, L1: 1, L2: 2, L3: 3 };

function toWhitelist(r: Record<string, unknown>): Whitelist {
  return {
    id: String(r.id),
    scope: r.scope as WhitelistScope,
    version: Number(r.version),
    status: r.status as Whitelist['status'],
    items: J.parse<WhitelistItem[]>(r.items, []),
    note: String(r.note ?? ''),
    createdBy: String(r.created_by ?? ''),
    createdAt: String(r.created_at),
    signedBy: (r.signed_by as string) ?? null,
    signedAt: (r.signed_at as string) ?? null,
    publishedBy: (r.published_by as string) ?? null,
    publishedAt: (r.published_at as string) ?? null,
    disabledBy: (r.disabled_by as string) ?? null,
    disabledAt: (r.disabled_at as string) ?? null,
    disabledReason: (r.disabled_reason as string) ?? null,
  };
}

const cache = new Map<WhitelistScope, { at: number; value: Whitelist | null }>();
const CACHE_MS = 5_000;
export function clearWhitelistCache() {
  cache.clear();
}

export async function loadWhitelist(id: string): Promise<Whitelist | null> {
  const r = await db().get('SELECT * FROM whitelists WHERE id=?', id);
  return r ? toWhitelist(r) : null;
}
export async function listWhitelists(scope?: WhitelistScope): Promise<Whitelist[]> {
  const rows = scope ? await db().all('SELECT * FROM whitelists WHERE scope=? ORDER BY version DESC', scope) : await db().all('SELECT * FROM whitelists ORDER BY scope, version DESC');
  return rows.map(toWhitelist);
}
export async function activeWhitelist(scope: WhitelistScope): Promise<Whitelist | null> {
  const c = cache.get(scope);
  if (c && Date.now() - c.at < CACHE_MS) return c.value;
  const r = await db().get("SELECT * FROM whitelists WHERE scope=? AND status='published' ORDER BY version DESC LIMIT 1", scope);
  const value = r ? toWhitelist(r) : null;
  cache.set(scope, { at: Date.now(), value });
  return value;
}

/** 生成执行链门禁钩子 */
export async function whitelistFor(channel: string, now = new Date()): Promise<WhitelistGate> {
  const scope = scopeOfChannel(channel);
  const wl = await activeWhitelist(scope);
  const version = wl ? `${scope}@${wl.version}` : null;
  const platformWorkTime = scope === 'platform' && isWorkTime(now, calendarFromEnv());
  return {
    version,
    allows(scenario: string, risk: RiskLevel) {
      if (!wl) return { allowed: false, reason: `${scope === 'owned' ? '自有渠道' : '渠道平台'}没有已发布的白名单，默认拒绝自动回复` };
      if (platformWorkTime) return { allowed: false, reason: '渠道平台工作时段为辅助模式，不自动回复（CS-004/CS-008B）' };
      const item = wl.items.find((i) => i.scenario === scenario);
      if (!item) return { allowed: false, reason: `场景 ${scenario} 不在白名单 ${version}` };
      if (RANK[risk] > RANK[item.maxRisk]) return { allowed: false, reason: `风险 ${risk} 超过白名单 ${version} 对 ${scenario} 的上限 ${item.maxRisk}` };
      return { allowed: true, reason: `白名单 ${version} 允许 ${scenario}（≤ ${item.maxRisk}）` };
    },
  };
}

const conflict = (msg: string) => Object.assign(new Error(msg), { status: 409 });

export async function createDraft(scope: WhitelistScope, items: WhitelistItem[], note: string, actor: string): Promise<Whitelist> {
  const max = (await db().get<{ v: number }>('SELECT COALESCE(MAX(version),0)::int v FROM whitelists WHERE scope=?', scope))?.v ?? 0;
  const id = uid('wl-');
  const now = nowIso();
  const dedup = [...new Map(items.map((i) => [i.scenario, { scenario: i.scenario, maxRisk: i.maxRisk === 'L1' ? 'L1' : 'L0', note: i.note }] as const)).values()] as WhitelistItem[];
  await db().run('INSERT INTO whitelists VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', id, scope, max + 1, 'draft', J.str(dedup), note, actor, now, null, null, null, null, null, null, null);
  return (await loadWhitelist(id))!;
}
export async function signWhitelist(id: string, actor: string): Promise<Whitelist> {
  const w = await loadWhitelist(id);
  if (!w) throw Object.assign(new Error('白名单不存在'), { status: 404 });
  if (w.status !== 'draft') throw conflict(`当前状态 ${w.status}，只有草稿可签发`);
  await db().run("UPDATE whitelists SET status='signed', signed_by=?, signed_at=? WHERE id=?", actor, nowIso(), id);
  return (await loadWhitelist(id))!;
}
export async function publishWhitelist(id: string, actor: string): Promise<Whitelist> {
  const w = await loadWhitelist(id);
  if (!w) throw Object.assign(new Error('白名单不存在'), { status: 404 });
  if (w.status !== 'signed') throw conflict(`当前状态 ${w.status}，必须先由售后负责人签发后才能发布`);
  const now = nowIso();
  await db().tx(async (t) => {
    await t.run("UPDATE whitelists SET status='disabled', disabled_by=?, disabled_at=?, disabled_reason=? WHERE scope=? AND status='published' AND id<>?", actor, now, `被新版本 v${w.version} 替代`, w.scope, id);
    await t.run("UPDATE whitelists SET status='published', published_by=?, published_at=? WHERE id=?", actor, now, id);
  });
  clearWhitelistCache();
  return (await loadWhitelist(id))!;
}
export async function disableWhitelist(id: string, actor: string, reason: string): Promise<Whitelist> {
  const w = await loadWhitelist(id);
  if (!w) throw Object.assign(new Error('白名单不存在'), { status: 404 });
  if (w.status === 'disabled') return w;
  await db().run("UPDATE whitelists SET status='disabled', disabled_by=?, disabled_at=?, disabled_reason=? WHERE id=?", actor, nowIso(), reason || '手动停用', id);
  clearWhitelistCache();
  return (await loadWhitelist(id))!;
}
