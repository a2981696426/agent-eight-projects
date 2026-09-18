import { useState } from 'react';
import { Alert, App, Button, Card, Col, Input, Row, Space, Table, Tag, Typography } from 'antd';
import ReactECharts from 'echarts-for-react';
import type { VocItem } from '@eight/shared';
import { api, fmtTime, useApi } from '../../api';

interface Overview { total: number; pending: number; topics: { topic: string; n: number; neg: number }[]; sentiment: { sentiment: string; n: number }[]; keywords: { k: string; n: number }[]; trend: { day: string; n: number; neg: number }[]; alerts: { topic: string; negativeRatio: number; n: number }[] }
const SENT: Record<string, { text: string; color: string }> = { positive: { text: '正向', color: 'green' }, neutral: { text: '中立', color: 'default' }, negative: { text: '负向', color: 'red' } };

export default function Voc() {
  const { message } = App.useApp();
  const { data: ov, reload } = useApi<Overview>('/api/voc/overview');
  const [topic, setTopic] = useState<string | null>(null);
  const { data: items, reload: reloadItems } = useApi<(VocItem & { conversation_id: string; created_at: string })[]>(topic ? `/api/voc/items?topic=${encodeURIComponent(topic)}` : '/api/voc/items');
  const [busy, setBusy] = useState<string | null>(null);
  const [question, setQuestion] = useState('用户对物流最不满意的是什么？');
  const [answer, setAnswer] = useState<{ answer: string; evidence: string[]; caveats: string; sampleCount: number } | null>(null);

  async function analyze() {
    setBusy('analyze');
    try {
      const r = await api<{ analyzed: number; total: number }>('/api/voc/analyze', { method: 'POST', body: { limit: 60 } });
      message.success(`新分析 ${r.analyzed} 条，累计 ${r.total} 条`);
      await Promise.all([reload(), reloadItems()]);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  async function ask() {
    setBusy('ask');
    try {
      setAnswer(await api('/api/voc/ask', { method: 'POST', body: { question } }));
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>客户之声 · VoC</h2>
          <div className="desc">对全部用户原声做主题 / 情绪 / 关键词标注，形成热词与预警；支持用自然语言提问，回答只基于已统计数据与样本原声，并可下钻到具体会话。</div>
        </div>
        <Button type="primary" loading={busy === 'analyze'} onClick={analyze}>分析未标注的用户消息{ov?.pending ? `（${ov.pending}）` : ''}</Button>
      </div>
      {ov?.alerts.length ? <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={`预警：${ov.alerts.map((a) => `「${a.topic}」负向占比 ${Math.round(a.negativeRatio * 100)}%（${a.n} 条）`).join('；')}`} /> : null}
      <Row gutter={[12, 12]}>
        <Col xs={24} lg={8}>
          <Card size="small" title="主题分布（点击下钻）">
            <ReactECharts style={{ height: 260 }} option={{ tooltip: {}, grid: { left: 90, right: 20, top: 10, bottom: 20 }, xAxis: { type: 'value' }, yAxis: { type: 'category', data: ov?.topics.map((t) => t.topic).reverse() ?? [] }, series: [{ type: 'bar', stack: 'a', name: '负向', data: ov?.topics.map((t) => t.neg).reverse() ?? [], itemStyle: { color: '#f87171' } }, { type: 'bar', stack: 'a', name: '其他', data: ov?.topics.map((t) => t.n - t.neg).reverse() ?? [], itemStyle: { color: '#93c5fd' } }] }} onEvents={{ click: (p: { name: string }) => setTopic(p.name) }} />
          </Card>
        </Col>
        <Col xs={24} lg={8}>
          <Card size="small" title="情绪构成">
            <ReactECharts style={{ height: 260 }} option={{ tooltip: {}, series: [{ type: 'pie', radius: ['40%', '70%'], data: ov?.sentiment.map((s) => ({ name: SENT[s.sentiment]?.text ?? s.sentiment, value: s.n })) ?? [], color: ['#34d399', '#9ca3af', '#f87171'] }] }} />
          </Card>
        </Col>
        <Col xs={24} lg={8}>
          <Card size="small" title="热词">
            <Space wrap size={[6, 6]}>{ov?.keywords.map((k) => <Tag key={k.k} style={{ fontSize: 12 + Math.min(8, k.n * 2) }}>{k.k} {k.n}</Tag>)}</Space>
            {!ov?.keywords.length && <Typography.Text type="secondary">尚无数据，先运行分析</Typography.Text>}
          </Card>
        </Col>
      </Row>
      <Row gutter={[12, 12]} style={{ marginTop: 12 }}>
        <Col xs={24} lg={12}>
          <Card size="small" title="客户之声 AI 分析助手">
            <Space.Compact style={{ width: '100%' }}>
              <Input value={question} onChange={(e) => setQuestion(e.target.value)} onPressEnter={ask} placeholder="用日常语言提问，例如：用户对发票的主要诉求是什么？" />
              <Button type="primary" loading={busy === 'ask'} onClick={ask}>提问</Button>
            </Space.Compact>
            {answer && (
              <div style={{ marginTop: 10, fontSize: 13 }}>
                <div style={{ whiteSpace: 'pre-wrap' }}>{answer.answer}</div>
                {answer.evidence.length > 0 && <div style={{ marginTop: 8 }}><b>原声依据：</b><ul style={{ margin: '4px 0' }}>{answer.evidence.map((e) => <li key={e}>{e}</li>)}</ul></div>}
                <Typography.Text type="secondary">基于 {answer.sampleCount} 条样本 · {answer.caveats}</Typography.Text>
              </div>
            )}
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card size="small" title={<Space>原声明细{topic && <Tag closable onClose={() => setTopic(null)}>{topic}</Tag>}</Space>}>
            <Table size="small" rowKey="id" dataSource={items ?? []} pagination={{ pageSize: 6, size: 'small' }} columns={[
              { title: '原声', dataIndex: 'text', ellipsis: true },
              { title: '主题', dataIndex: 'topic', width: 90, render: (v) => <a onClick={() => setTopic(v)}>{v}</a> },
              { title: '情绪', dataIndex: 'sentiment', width: 70, render: (v) => <Tag color={SENT[v]?.color}>{SENT[v]?.text}</Tag> },
              { title: '关键词', dataIndex: 'keywords', width: 150, render: (k: string[]) => k.map((x) => <Tag key={x}>{x}</Tag>) },
              { title: '会话', dataIndex: 'conversation_id', width: 110, render: (v) => <a href={`/reception/online`} className="mono">{v}</a> },
              { title: '时间', dataIndex: 'created_at', width: 150, render: fmtTime },
            ]} />
          </Card>
        </Col>
      </Row>
    </div>
  );
}
