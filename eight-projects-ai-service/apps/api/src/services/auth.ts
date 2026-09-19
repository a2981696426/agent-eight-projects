import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { J, nowIso, openDb, uid } from '../db.ts';

/**
 * 登录与角色权限（借鉴 AI 修图项目的 JWT httpOnly Cookie + 路由守卫，这里用服务端会话 + 签名 Cookie）。
 * 三角色：admin 管理员（全部）、agent 坐席（接待/子案件与接续任务/知识只读/AIGC）、analyst 质检与运营（质检/报表/大屏/VoC/知识维护）。
 */
export type Role = 'admin' | 'agent' | 'analyst';
export interface SessionUser {
  id: string;
  username: string;
  name: string;
  role: Role;
}

const COOKIE = 'eight_session';
const SESSION_TTL_MS = 7 * 24 * 3600e3;
const db = () => openDb();

export function hashPassword(password: string, salt = randomBytes(16).toString('hex')) {
  return { salt, hash: scryptSync(password, salt, 32).toString('hex') };
}
function verifyPassword(password: string, salt: string, hash: string) {
  const h = scryptSync(password, salt, 32);
  const stored = Buffer.from(hash, 'hex');
  return stored.length === h.length && timingSafeEqual(stored, h);
}

export const DEMO_USERS: { username: string; password: string; name: string; role: Role }[] = [
  { username: 'admin', password: 'admin123', name: '管理员', role: 'admin' },
  { username: 'agent', password: 'agent123', name: '客服小欧', role: 'agent' },
  { username: 'analyst', password: 'analyst123', name: '质检员李明', role: 'analyst' },
];

export async function seedUsers() {
  const d = db();
  for (const u of DEMO_USERS) {
    if (await d.get('SELECT id FROM users WHERE username=?', u.username)) continue;
    const { salt, hash } = hashPassword(u.password);
    await d.run('INSERT INTO users VALUES (?,?,?,?,?,?,?,?,?)', uid('u-'), u.username, hash, salt, u.name, u.role, 0, nowIso(), null);
  }
}

/** 公开接口：健康检查、登录、访客端所需的最小集合 */
const PUBLIC: { method?: string; re: RegExp }[] = [
  { re: /^\/api\/health$/ },
  { re: /^\/api\/channels\/wechat\/webhook$/ },
  { re: /^\/api\/auth\/(login|logout|me)$/ },
  { method: 'POST', re: /^\/api\/conversations$/ },
  { method: 'GET', re: /^\/api\/conversations\/[^/]+$/ },
  { method: 'POST', re: /^\/api\/conversations\/[^/]+\/messages(\/stream)?$/ },
  { method: 'POST', re: /^\/api\/conversations\/[^/]+\/rate$/ },
  { method: 'GET', re: /^\/api\/customers$/ },
];

/** 需要特定角色的写操作；未列出的已认证请求默认放行（读为主） */
const RULES: { methods: string[]; re: RegExp; roles: Role[]; label: string }[] = [
  { methods: ['PUT', 'POST'], re: /^\/api\/agents\/[^/]+(\/publish|\/rollback)?$/, roles: ['admin'], label: 'Agent 配置与发布' },
  { methods: ['POST'], re: /^\/api\/llm\/simulate$/, roles: ['admin'], label: '故障演练' },
  { methods: ['POST'], re: /^\/api\/knowledge\/docs\/[^/]+\/publish$/, roles: ['admin'], label: '知识发布' },
  { methods: ['POST', 'PUT', 'DELETE'], re: /^\/api\/knowledge\//, roles: ['admin', 'analyst'], label: '知识维护' },
  { methods: ['PUT', 'POST', 'PATCH'], re: /^\/api\/quality\//, roles: ['admin', 'analyst'], label: '质检' },
  { methods: ['POST', 'DELETE'], re: /^\/api\/reports\//, roles: ['admin', 'analyst'], label: '报表' },
  { methods: ['POST'], re: /^\/api\/voc\/(analyze|ask)$/, roles: ['admin', 'analyst'], label: '客户之声分析' },
  { methods: ['POST'], re: /^\/api\/conversations\/[^/]+\/(control|assist|summary|classify|case)$/, roles: ['admin', 'agent'], label: '会话处理' },
  { methods: ['POST'], re: /^\/api\/dms\/(simulate|mock|retry-pending)/, roles: ['admin'], label: 'DMS 适配器管理' },
  { methods: ['GET'], re: /^\/api\/channels\/wechat\/mock\//, roles: ['admin'], label: '渠道模拟记录' },
  { methods: ['POST', 'PATCH'], re: /^\/api\/(cases|handoffs)/, roles: ['admin', 'agent'], label: '子案件与接续任务处理' },
  { methods: ['POST', 'PUT'], re: /^\/api\/(ivr|outbound)\//, roles: ['admin', 'agent'], label: '机器人与外呼配置' },
  { methods: ['POST'], re: /^\/api\/aigc\//, roles: ['admin', 'agent', 'analyst'], label: 'AIGC' },
  { methods: ['POST'], re: /^\/api\/employees\//, roles: ['admin', 'agent'], label: '数字员工试跑' },
];

export function isPublic(method: string, url: string) {
  const path = url.split('?')[0];
  return PUBLIC.some((p) => (!p.method || p.method === method) && p.re.test(path));
}
export function requiredRoles(method: string, url: string): { roles: Role[]; label: string } | null {
  const path = url.split('?')[0];
  const r = RULES.find((x) => x.methods.includes(method) && x.re.test(path));
  return r ? { roles: r.roles, label: r.label } : null;
}

export async function createSession(userId: string, userAgent: string | undefined) {
  const id = randomBytes(24).toString('base64url');
  const now = Date.now();
  await db().run('INSERT INTO sessions VALUES (?,?,?,?,?)', id, userId, new Date(now).toISOString(), new Date(now + SESSION_TTL_MS).toISOString(), userAgent ?? null);
  await db().run('UPDATE users SET last_login_at=? WHERE id=?', nowIso(), userId);
  return id;
}
export async function destroySession(id: string) {
  await db().run('DELETE FROM sessions WHERE id=?', id);
}
export async function userBySession(id: string | undefined): Promise<SessionUser | null> {
  if (!id) return null;
  const row = await db().get<{ user_id: string; expires_at: string }>('SELECT user_id, expires_at FROM sessions WHERE id=?', id);
  if (!row || new Date(row.expires_at).getTime() < Date.now()) return null;
  const u = await db().get<{ id: string; username: string; name: string; role: Role; disabled: number }>('SELECT id, username, name, role, disabled FROM users WHERE id=?', row.user_id);
  return u && !u.disabled ? { id: u.id, username: u.username, name: u.name, role: u.role } : null;
}
export async function authenticate(username: string, password: string): Promise<SessionUser | null> {
  const u = await db().get<{ id: string; username: string; name: string; role: Role; password_hash: string; salt: string; disabled: number }>('SELECT * FROM users WHERE username=?', username);
  if (!u || u.disabled || !verifyPassword(password, u.salt, u.password_hash)) return null;
  return { id: u.id, username: u.username, name: u.name, role: u.role };
}

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
  }
}

export function readSessionId(req: FastifyRequest): string | undefined {
  const raw = req.cookies?.[COOKIE];
  if (!raw) return undefined;
  const v = req.unsignCookie(raw);
  return v.valid ? v.value : undefined;
}

export function installAuth(app: FastifyInstance) {
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    req.user = await userBySession(readSessionId(req));
    if (isPublic(req.method, req.url)) return;
    if (!req.user) return reply.code(401).send({ error: '请先登录', code: 'UNAUTHENTICATED' });
    const need = requiredRoles(req.method, req.url);
    if (need && !need.roles.includes(req.user.role)) {
      await db().run('INSERT INTO audit_log VALUES (?,?,?,?,?,?)', uid('al-'), nowIso(), req.user.username, 'auth.forbidden', `${req.method} ${req.url.split('?')[0]}`, J.str({ role: req.user.role, need: need.roles }));
      return reply.code(403).send({ error: `当前角色（${req.user.role}）无权执行「${need.label}」，需要：${need.roles.join(' / ')}`, code: 'FORBIDDEN' });
    }
  });

  app.post('/api/auth/login', async (req, reply) => {
    const b = (req.body ?? {}) as { username?: string; password?: string };
    if (!b.username || !b.password) return reply.code(400).send({ error: '请输入用户名和密码' });
    const user = await authenticate(b.username, b.password);
    if (!user) {
      await db().run('INSERT INTO audit_log VALUES (?,?,?,?,?,?)', uid('al-'), nowIso(), b.username, 'auth.login_failed', 'password', null);
      return reply.code(401).send({ error: '用户名或密码错误' });
    }
    const sid = await createSession(user.id, req.headers['user-agent']);
    reply.setCookie(COOKIE, sid, { signed: true, httpOnly: true, sameSite: 'lax', path: '/', maxAge: SESSION_TTL_MS / 1000, secure: 'auto' });
    await db().run('INSERT INTO audit_log VALUES (?,?,?,?,?,?)', uid('al-'), nowIso(), user.username, 'auth.login', user.role, null);
    return { user };
  });
  app.post('/api/auth/logout', async (req, reply) => {
    const sid = readSessionId(req);
    if (sid) await destroySession(sid);
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });
  app.get('/api/auth/me', async (req) => ({ user: req.user, roles: { admin: '管理员', agent: '坐席', analyst: '质检与运营' }, demo: DEMO_USERS.map((u) => ({ username: u.username, password: u.password, name: u.name, role: u.role })) }));
}

export function actorOf(req: FastifyRequest, fallback = '坐席') {
  return req.user?.name ?? fallback;
}

export { COOKIE as SESSION_COOKIE };
export type { FastifyReply };
