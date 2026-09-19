/**
 * L1 回放 CLI：
 *   pnpm --filter @eight/api replay -- --input <云商导出.csv|.json> --out <目录> [--labels <标签.csv>] [--limit <会话数>] [--turns <每会话最多访客轮次>]
 * 默认在内存库（DATA_DIR=:memory:）中重建种子知识/白名单后回放，不写入正式库；设 REPLAY_USE_DB=1 使用当前 DATA_DIR 的知识与白名单。
 * 产物：records.json、report.json、report.md、blind-stage1.csv、blind-stage2.csv
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
// 路径相对于调用 pnpm 的目录（仓库根），而不是 apps/api
const base = process.env.INIT_CWD ?? process.cwd();
const opt = (name: string, def?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const input = opt('input');
const out = opt('out', `docs/eval/replays/${new Date().toISOString().slice(0, 10)}`);
if (!input) {
  console.error('用法：replay --input <csv|json> --out <dir> [--labels <csv>] [--limit n] [--turns n]');
  process.exit(2);
}
if (process.env.REPLAY_USE_DB !== '1') process.env.DATA_DIR = ':memory:';

const { initDb, closeDb } = await import('../db.ts');
const { seed } = await import('../seed.ts');
const { refreshIndex, embedDoc } = await import('../services/chain.ts');
const { parseReplayCsv, parseReplayJson, parseLabelsCsv, replayConversation, buildReport, reportMarkdown, blindStage1Csv, blindStage2Csv, frozenVersions, replayRecordsJson } = await import('./replay.ts');

await initDb();
if (process.env.REPLAY_USE_DB !== '1') await seed(true);
await refreshIndex();
await embedDoc(null);

const raw = readFileSync(resolve(base, input!), 'utf8');
let convs = input!.endsWith('.json') ? parseReplayJson(raw) : parseReplayCsv(raw);
const limit = Number(opt('limit', '0'));
if (limit > 0) convs = convs.slice(0, limit);
const turns = Number(opt('turns', '0')) || undefined;
const labels = opt('labels') ? parseLabelsCsv(readFileSync(resolve(base, opt('labels')!), 'utf8')) : [];

console.log(`回放 ${convs.length} 个会话（LLM_MOCK=${process.env.LLM_MOCK === '1' ? '1' : '0'}）…`);
const records = [];
let done = 0;
for (const c of convs) {
  records.push(...(await replayConversation(c, { limitTurns: turns })));
  done++;
  if (done % 10 === 0 || done === convs.length) console.log(`  ${done}/${convs.length} 会话，${records.length} 轮`);
}
const versions = await frozenVersions();
const report = buildReport(records, convs, labels, versions);
const dir = resolve(base, out!);
mkdirSync(dir, { recursive: true });
writeFileSync(resolve(dir, 'records.json'), replayRecordsJson(records));
writeFileSync(resolve(dir, 'report.json'), JSON.stringify(report, null, 2));
writeFileSync(resolve(dir, 'report.md'), reportMarkdown(report, records));
writeFileSync(resolve(dir, 'blind-stage1.csv'), '\uFEFF' + blindStage1Csv(records));
writeFileSync(resolve(dir, 'blind-stage2.csv'), '\uFEFF' + blindStage2Csv(records));
console.log(`完成：${dir}\n  决策分布 ${JSON.stringify(report.decisions)}\n  护栏 ${JSON.stringify(report.guards)}\n  建议可用率 ${report.usability.status}${report.usability.rate != null ? ` ${(report.usability.rate * 100).toFixed(1)}%` : ''}`);
await closeDb();
