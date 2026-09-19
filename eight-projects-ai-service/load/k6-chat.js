/*
 * k6 压测：访客对话主链路（切片 0 P1 门禁：200 并发访客 p95 ≤ 15 s、失败率 < 1%）
 *   k6 run -e SCENARIO=smoke load/k6-chat.js          # 5 VU × 30 s
 *   k6 run -e SCENARIO=peak  load/k6-chat.js          # 0→200 VU 60 s，持稳 120 s，降 30 s
 *   -e BASE_URL=http://127.0.0.1:8788（默认；建议对 LLM_MOCK=1 的独立实例施压，避免真实模型费用与限流）
 * 每次迭代：新建会话 → "你好"（规则应答）→ "订单 20260918000123 的快递三天没动了"（完整执行链）→ 读取会话
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://127.0.0.1:8788';
const SCENARIO = __ENV.SCENARIO || 'smoke';

const chainDuration = new Trend('chain_duration', true);
const greetDuration = new Trend('greet_duration', true);
const chatFailed = new Rate('chat_failed');

const scenarios = {
  smoke: { executor: 'constant-vus', vus: 5, duration: '30s' },
  peak: {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [
      { duration: '60s', target: 200 },
      { duration: '120s', target: 200 },
      { duration: '30s', target: 0 },
    ],
    gracefulRampDown: '20s',
  },
};

export const options = {
  scenarios: { [SCENARIO]: scenarios[SCENARIO] },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    chat_failed: ['rate<0.01'],
    'http_req_duration{name:create}': ['p(95)<1000'],
    greet_duration: ['p(95)<2000'],
    chain_duration: ['p(95)<15000'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

const json = { headers: { 'Content-Type': 'application/json' } };

export default function () {
  const create = http.post(`${BASE}/api/conversations`, JSON.stringify({ channel: 'web', title: 'k6 访客', mode: 'bot' }), { ...json, tags: { name: 'create' } });
  const okCreate = check(create, { 'create 201': (r) => r.status === 201 });
  if (!okCreate) {
    chatFailed.add(1);
    return;
  }
  const id = create.json('id');

  const t1 = Date.now();
  const greet = http.post(`${BASE}/api/conversations/${id}/messages`, JSON.stringify({ role: 'user', text: '你好' }), { ...json, tags: { name: 'greet' }, timeout: '30s' });
  greetDuration.add(Date.now() - t1);
  const okGreet = check(greet, { 'greet 200': (r) => r.status === 200, 'greet has bot': (r) => !!r.json('botMessage') });
  sleep(Math.random() * 2 + 1);

  const t2 = Date.now();
  const chain = http.post(`${BASE}/api/conversations/${id}/messages`, JSON.stringify({ role: 'user', text: '订单 20260918000123 的快递三天没动了' }), { ...json, tags: { name: 'chain' }, timeout: '60s' });
  chainDuration.add(Date.now() - t2);
  const okChain = check(chain, { 'chain 200': (r) => r.status === 200, 'chain has trace': (r) => !!r.json('trace') });

  const detail = http.get(`${BASE}/api/conversations/${id}`, { tags: { name: 'detail' } });
  const okDetail = check(detail, { 'detail 200': (r) => r.status === 200 });
  chatFailed.add(!(okGreet && okChain && okDetail));
  sleep(Math.random() * 2 + 1);
}

export function handleSummary(data) {
  const m = data.metrics;
  const pick = (name) => (m[name] ? m[name].values : {});
  const summary = {
    scenario: SCENARIO,
    baseUrl: BASE,
    finishedAt: new Date().toISOString(),
    vusMax: pick('vus_max').value,
    iterations: pick('iterations').count,
    httpReqs: pick('http_reqs').count,
    rps: pick('http_reqs').rate,
    httpFailedRate: pick('http_req_failed').rate,
    chatFailedRate: pick('chat_failed').rate,
    greet: pick('greet_duration'),
    chain: pick('chain_duration'),
    httpReqDuration: pick('http_req_duration'),
    thresholds: Object.fromEntries(Object.entries(m).filter(([, v]) => v.thresholds).map(([k, v]) => [k, Object.fromEntries(Object.entries(v.thresholds).map(([t, r]) => [t, r.ok]))])),
  };
  return { stdout: textSummary(summary), [`load/results/${SCENARIO}-${summary.finishedAt.replace(/[:.]/g, '-')}.json`]: JSON.stringify(summary, null, 2) };
}

function textSummary(s) {
  const f = (v) => (v == null ? '—' : Math.round(v));
  return [
    '',
    `k6 ${s.scenario} @ ${s.baseUrl}`,
    `  VUs max ${s.vusMax} · iterations ${s.iterations} · http reqs ${s.httpReqs} (${(s.rps || 0).toFixed(1)} rps)`,
    `  http_req_failed ${((s.httpFailedRate || 0) * 100).toFixed(2)}% · chat_failed ${((s.chatFailedRate || 0) * 100).toFixed(2)}%`,
    `  greet  p50 ${f(s.greet.med)} ms · p95 ${f(s.greet['p(95)'])} ms · p99 ${f(s.greet['p(99)'])} ms`,
    `  chain  p50 ${f(s.chain.med)} ms · p95 ${f(s.chain['p(95)'])} ms · p99 ${f(s.chain['p(99)'])} ms · max ${f(s.chain.max)} ms`,
    `  thresholds ${JSON.stringify(s.thresholds)}`,
    '',
  ].join('\n');
}
