import { useState } from 'react';
import { App, Button, Card, Col, Drawer, Input, Row, Space, Switch, Table, Tag, Typography } from 'antd';
import ReactECharts from 'echarts-for-react';
import type { QualityResult, QualityRule } from '@eight/shared';
import { api, fmtTime, useApi } from '../../api';

interface Report { total: number; avg: number; byAgent: { agent: string; n: number; avg: number; reviewed: number }[]; ruleHits: { id: string; name: string; n: number; total: number }[]; distribution: { range: string; n: number }[]; humanReviewed: number }
const KIND: Record<QualityRule['kind'], string> = { forbidden_word: '禁用词', required_word: '必备词', response_time: '响应时长', turns: '会话轮次', sentiment: '情绪', semantic: '大模型语义' };

export default function Quality() {
  const { message } = App.useApp();
  const { data: rules, reload: reloadRules } = useApi<QualityRule[]>('/api/quality/rules');
  const { data: results, reload: reloadResults } = useApi<QualityResult[]>('/api/quality/results');
  const { data: report, reload: reloadReport } = useApi<Report>('/api/quality/report');
  const [semantic, setSemantic] = useState(true);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState<QualityResult | null>(null);
  const [note, setNote] = useState('');

  async function run() {
    setBusy(true);
    try {
      const r = await api<{ count: number }>('/api/quality/run', { method: 'POST', body: { semantic, limit: 12 } });
      message.success(`已质检 ${r.count} 个会话`);
      await Promise.all([reloadResults(), reloadReport()]);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function toggleRule(r: QualityRule, enabled: boolean) {
    await api(`/api/quality/rules/${r.id}`, { method: 'PUT', body: { ...r, enabled } });
    await reloadRules();
  }
  async function review() {
    if (!active) return;
    await api(`/api/quality/results/${active.id}`, { method: 'PATCH', body: { reviewedBy: '质检员李明', reviewNote: note } });
    message.success('人工复核已记录');
    setActive(null);
    setNote('');
    await Promise.all([reloadResults(), reloadReport()]);
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>智能质检</h2>
          <div className="desc">全量规则质检（禁用词/必备词/响应时长/轮次，加减分）+ 大模型语义质检（同理心/完整性/准确性/合规性四维打分）；人机质检对比，人工复核留痕。</div>
        </div>
        <Space>
          <span>含语义质检 <Switch checked={semantic} onChange={setSemantic} /></span>
          <Button type="primary" loading={busy} onClick={run}>对最近 12 个会话运行质检</Button>
        </Space>
      </div>
      <Row gutter={[12, 12]}>
        <Col xs={24} lg={8}>
          <Card size="small" title="质检规则">
            {rules?.map((r) => (
              <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px dashed #f0f0f0' }}>
                <div>
                  <div style={{ fontWeight: 500 }}>{r.name} <Tag>{KIND[r.kind]}</Tag>{r.score !== 0 && <Tag color={r.score > 0 ? 'green' : 'red'}>{r.score > 0 ? '+' : ''}{r.score}</Tag>}</div>
                  <div className="mono" style={{ color: '#9ca3af', fontSize: 11 }}>{JSON.stringify(r.config)}</div>
                </div>
                <Switch size="small" checked={r.enabled} onChange={(v) => toggleRule(r, v)} />
              </div>
            ))}
          </Card>
        </Col>
        <Col xs={24} lg={16}>
          <Row gutter={[12, 12]}>
            {[['质检总数', report?.total], ['平均分', report?.avg], ['人工复核', report?.humanReviewed], ['规则命中种类', report?.ruleHits.length]].map(([l, v]) => (
              <Col key={String(l)} xs={12} md={6}><div className="kpi"><div className="label">{l}</div><div className="value">{v ?? '—'}</div></div></Col>
            ))}
            <Col xs={24} md={12}>
              <Card size="small" title="分数分布">
                <ReactECharts style={{ height: 200 }} option={{ grid: { left: 40, right: 10, top: 20, bottom: 30 }, xAxis: { type: 'category', data: report?.distribution.map((d) => d.range) ?? [] }, yAxis: { type: 'value' }, series: [{ type: 'bar', data: report?.distribution.map((d) => d.n) ?? [], itemStyle: { color: '#1f6feb' } }] }} />
              </Card>
            </Col>
            <Col xs={24} md={12}>
              <Card size="small" title="规则命中次数">
                <ReactECharts style={{ height: 200 }} option={{ grid: { left: 110, right: 20, top: 10, bottom: 20 }, xAxis: { type: 'value' }, yAxis: { type: 'category', data: report?.ruleHits.map((r) => r.name) ?? [] }, series: [{ type: 'bar', data: report?.ruleHits.map((r) => r.n) ?? [], itemStyle: { color: '#f59e0b' } }] }} />
              </Card>
            </Col>
            <Col xs={24}>
              <Card size="small" title="坐席维度（人机对比：机器人 vs 人工坐席）">
                <Table size="small" rowKey="agent" pagination={false} dataSource={report?.byAgent ?? []} columns={[{ title: '坐席/机器人', dataIndex: 'agent' }, { title: '会话数', dataIndex: 'n', width: 90 }, { title: '平均分', dataIndex: 'avg', width: 90 }, { title: '已人工复核', dataIndex: 'reviewed', width: 110 }]} />
              </Card>
            </Col>
          </Row>
        </Col>
      </Row>
      <Card size="small" title="质检结果" style={{ marginTop: 12 }}>
        <Table<QualityResult> size="small" rowKey="id" dataSource={results ?? []} pagination={{ pageSize: 10, size: 'small' }} onRow={(r) => ({ onClick: () => setActive(r), style: { cursor: 'pointer' } })} columns={[
          { title: '时间', dataIndex: 'createdAt', width: 160, render: fmtTime },
          { title: '会话', dataIndex: 'conversationId', width: 140, render: (v) => <span className="mono">{v}</span> },
          { title: '坐席', dataIndex: 'agent', width: 110, render: (v) => v ?? '—' },
          { title: '得分', dataIndex: 'score', width: 80, render: (v) => <Tag color={v >= 80 ? 'green' : v >= 60 ? 'orange' : 'red'}>{v}</Tag> },
          { title: '命中', dataIndex: 'hits', render: (h: QualityResult['hits']) => h.map((x) => <Tag key={x.ruleId} color={x.delta < 0 ? 'red' : 'green'}>{x.ruleName} {x.delta > 0 ? '+' : ''}{x.delta}</Tag>) },
          { title: '语义', dataIndex: 'semantic', width: 220, ellipsis: true, render: (s: QualityResult['semantic']) => s ? `${s.tone} · ${s.summary}` : '—' },
          { title: '复核', dataIndex: 'reviewedBy', width: 100, render: (v) => v ? <Tag color="blue">{v}</Tag> : <Tag>待复核</Tag> },
        ]} />
      </Card>
      <Drawer open={!!active} onClose={() => setActive(null)} width={560} title={`质检明细 · ${active?.conversationId ?? ''}`}>
        {active && (
          <>
            <Space wrap style={{ marginBottom: 10 }}><Tag color="blue">得分 {active.score}</Tag><Tag>{active.agent ?? '—'}</Tag>{active.reviewedBy && <Tag color="green">已复核 {active.reviewedBy}</Tag>}</Space>
            <Typography.Title level={5}>规则命中</Typography.Title>
            {active.hits.map((h) => <div key={h.ruleId} style={{ fontSize: 13, padding: '4px 0' }}><Tag color={h.delta < 0 ? 'red' : 'green'}>{h.delta > 0 ? '+' : ''}{h.delta}</Tag>{h.ruleName}：{h.evidence}</div>)}
            {active.semantic && (
              <>
                <Typography.Title level={5}>语义质检</Typography.Title>
                <div style={{ fontSize: 13 }}>语气：{active.semantic.tone}</div>
                <div style={{ fontSize: 13 }}>{active.semantic.summary}</div>
                <ul style={{ fontSize: 13 }}>{active.semantic.issues.map((i) => <li key={i}>{i}</li>)}</ul>
              </>
            )}
            <Typography.Title level={5}>人工复核</Typography.Title>
            {active.reviewNote && <div style={{ fontSize: 13, color: '#4b5563', marginBottom: 6 }}>已有备注：{active.reviewNote}</div>}
            <Input.TextArea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="复核意见（同意/修正机器判断）" />
            <Button type="primary" style={{ marginTop: 8 }} onClick={review}>提交复核</Button>
          </>
        )}
      </Drawer>
    </div>
  );
}
