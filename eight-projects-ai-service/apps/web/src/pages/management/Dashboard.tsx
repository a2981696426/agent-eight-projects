import { Button, Col, Row, Tag } from 'antd';
import { ArrowLeftOutlined, ReloadOutlined } from '@ant-design/icons';
import ReactECharts from 'echarts-for-react';
import { Link } from 'react-router-dom';
import { fmtShort, fmtTime, pct, useApi } from '../../api';

interface Data {
  generatedAt: string;
  kpis: Record<string, number>;
  decisions: { decision: string; n: number }[];
  risks: { risk_level: string; n: number }[];
  scenarios: { scenario: string; name: string; n: number }[];
  hourly: { h: string; n: number }[];
  channels: { channel: string; n: number }[];
  agents: { assignee: string; n: number; sat: number }[];
  recentTraces: { id: string; created_at: string; scenario: string; intent: string; decision: string; risk_level: string; duration_ms: number }[];
  queue: { id: string; title: string; priority: string; last_message_at: string; channel: string }[];
}

const dark = { textStyle: { color: '#c7d2fe' }, tooltip: { trigger: 'item' }, animation: false };
const decisionLabel: Record<string, string> = { auto_reply: '自主回复', human_confirm: '人工确认', escalate: '升级人工' };

export default function Dashboard() {
  const { data, reload, loading } = useApi<Data>('/api/dashboard', { pollMs: 15_000 });
  const k = data?.kpis ?? {};
  const tile = (label: string, value: string | number | undefined, sub?: string) => (
    <div className="tile"><h4>{label}</h4><div className="big">{value ?? '—'}</div>{sub && <div className="sub">{sub}</div>}</div>
  );
  return (
    <div className="screen">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 700, color: '#fff', letterSpacing: 1 }}>欧态智能服务 · 实时运营大屏</div>
          <div className="sub">数据来源：本平台会话 / 执行链 / 工单 / 质检（15 秒自动刷新）· 更新 {fmtTime(data?.generatedAt)}</div>
        </div>
        <div>
          <Button ghost icon={<ReloadOutlined />} loading={loading} onClick={() => void reload()} style={{ marginRight: 8 }}>刷新</Button>
          <Link to="/"><Button ghost icon={<ArrowLeftOutlined />}>返回工作台</Button></Link>
        </div>
      </div>
      <Row gutter={[12, 12]}>
        <Col xs={12} md={6} xl={3}>{tile('会话总数', k.conversationsTotal, `今日 ${k.conversationsToday ?? 0}`)}</Col>
        <Col xs={12} md={6} xl={3}>{tile('待人工接续', k.waitingHuman, '按 P0 > P1 > P2 排队')}</Col>
        <Col xs={12} md={6} xl={3}>{tile('机器人自主解决率', pct(k.autoReplyRate), '执行链 auto_reply 占比')}</Col>
        <Col xs={12} md={6} xl={3}>{tile('执行链平均耗时', `${k.avgChainMs ?? 0} ms`, '含 2 次模型调用')}</Col>
        <Col xs={12} md={6} xl={3}>{tile('处理中工单', k.openTickets, `SLA 超时 ${k.overdueTickets ?? 0}`)}</Col>
        <Col xs={12} md={6} xl={3}>{tile('质检平均分', k.qualityAvg, '规则 + 语义')}</Col>
        <Col xs={12} md={6} xl={3}>{tile('满意度', k.avgSatisfaction, '5 分制')}</Col>
        <Col xs={12} md={6} xl={3}>{tile('近 200 次 tokens', k.tokensRecent, `在线坐席 ${k.agentsOnline ?? 0} · 机器人 ${k.botOnline ?? 0}`)}</Col>
      </Row>
      <Row gutter={[12, 12]} style={{ marginTop: 12 }}>
        <Col xs={24} lg={8}>
          <div className="tile"><h4>用户消息小时分布</h4>
            <ReactECharts style={{ height: 220 }} option={{ ...dark, grid: { left: 36, right: 10, top: 10, bottom: 24 }, xAxis: { type: 'category', data: data?.hourly.map((h) => `${h.h}时`) ?? [], axisLine: { lineStyle: { color: '#3b4f7a' } } }, yAxis: { type: 'value', splitLine: { lineStyle: { color: '#1e2f52' } } }, series: [{ type: 'line', smooth: true, areaStyle: { color: 'rgba(96,165,250,.25)' }, lineStyle: { color: '#60a5fa' }, data: data?.hourly.map((h) => h.n) ?? [] }] }} />
          </div>
        </Col>
        <Col xs={24} lg={8}>
          <div className="tile"><h4>自治决策分布</h4>
            <ReactECharts style={{ height: 220 }} option={{ ...dark, series: [{ type: 'pie', radius: ['40%', '70%'], label: { color: '#c7d2fe' }, data: data?.decisions.map((d) => ({ name: decisionLabel[d.decision] ?? d.decision, value: d.n })) ?? [], color: ['#34d399', '#fbbf24', '#f87171'] }] }} />
          </div>
        </Col>
        <Col xs={24} lg={8}>
          <div className="tile"><h4>风险等级 × 场景</h4>
            <ReactECharts style={{ height: 220 }} option={{ ...dark, grid: { left: 36, right: 10, top: 10, bottom: 44 }, xAxis: { type: 'category', data: data?.scenarios.map((s) => s.name) ?? [], axisLabel: { rotate: 25, fontSize: 11 }, axisLine: { lineStyle: { color: '#3b4f7a' } } }, yAxis: { type: 'value', splitLine: { lineStyle: { color: '#1e2f52' } } }, series: [{ type: 'bar', data: data?.scenarios.map((s) => s.n) ?? [], itemStyle: { color: '#a78bfa' } }] }} />
            <div className="sub">{data?.risks.map((r) => <Tag key={r.risk_level} color={{ L0: 'green', L1: 'cyan', L2: 'orange', L3: 'red' }[r.risk_level]}>{r.risk_level} × {r.n}</Tag>)}</div>
          </div>
        </Col>
      </Row>
      <Row gutter={[12, 12]} style={{ marginTop: 12 }}>
        <Col xs={24} lg={8}>
          <div className="tile"><h4>渠道分布</h4>
            <ReactECharts style={{ height: 200 }} option={{ ...dark, series: [{ type: 'pie', radius: '65%', label: { color: '#c7d2fe' }, data: data?.channels.map((c) => ({ name: c.channel, value: c.n })) ?? [] }] }} />
          </div>
        </Col>
        <Col xs={24} lg={8}>
          <div className="tile"><h4>人工接续队列</h4>
            {data?.queue.length ? data.queue.map((q) => <div key={q.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderBottom: '1px dashed #223558', fontSize: 13 }}><span><Tag color={q.priority === 'P0' ? 'red' : q.priority === 'P1' ? 'orange' : 'blue'}>{q.priority ?? 'P2'}</Tag>{q.title}</span><span className="sub">{q.channel} · {fmtShort(q.last_message_at)}</span></div>) : <div className="sub">队列为空</div>}
            <h4 style={{ marginTop: 12 }}>坐席榜</h4>
            {data?.agents.map((a) => <div key={a.assignee} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '3px 0' }}><span>{a.assignee}</span><span className="sub">{a.n} 会话 · 满意度 {a.sat ?? '—'}</span></div>)}
          </div>
        </Col>
        <Col xs={24} lg={8}>
          <div className="tile"><h4>最近执行链</h4>
            {data?.recentTraces.map((t) => <div key={t.id} style={{ fontSize: 12, padding: '4px 0', borderBottom: '1px dashed #223558' }}><span className="sub">{fmtShort(t.created_at)}</span> <Tag>{t.scenario}</Tag><Tag color={{ auto_reply: 'green', human_confirm: 'orange', escalate: 'red' }[t.decision] ?? 'default'}>{decisionLabel[t.decision] ?? t.decision}</Tag><Tag color={{ L0: 'green', L1: 'cyan', L2: 'orange', L3: 'red' }[t.risk_level] ?? 'default'}>{t.risk_level}</Tag><span>{t.intent}</span><span className="sub"> · {t.duration_ms} ms</span></div>)}
          </div>
        </Col>
      </Row>
    </div>
  );
}
