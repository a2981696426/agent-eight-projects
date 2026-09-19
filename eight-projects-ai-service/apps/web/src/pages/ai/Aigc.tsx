import { useState } from 'react';
import { App, Button, Card, Col, Input, Row, Select, Space, Table, Tag, Typography } from 'antd';
import type { Conversation } from '@eight/shared';
import { api, fmtTime, useApi } from '../../api';

interface Cap { id: string; name: string; desc: string; input: 'conversationId' | 'text' }

export default function Aigc() {
  const { message } = App.useApp();
  const { data: caps } = useApi<Cap[]>('/api/aigc/capabilities');
  const { data: convs } = useApi<Conversation[]>('/api/conversations');
  const { data: jobs, reload } = useApi<{ id: string; capability: string; created_at: string; input: unknown; output: unknown; usage: { durationMs: number; promptTokens: number; completionTokens: number }[] | null }[]>('/api/aigc/jobs');
  const [cap, setCap] = useState<string>('summary');
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [text, setText] = useState('您好，您的订单已经发出，请耐心等待。');
  const [style, setStyle] = useState('更亲切、更有同理心，分点说明');
  const [result, setResult] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const current = caps?.find((c) => c.id === cap);

  async function run() {
    setBusy(true);
    setResult(null);
    try {
      const body: Record<string, unknown> = current?.input === 'conversationId' ? { conversationId: conversationId ?? convs?.[0]?.id } : { text, question: text, style };
      const r = await api(`/api/aigc/${cap}`, { method: 'POST', body });
      setResult(r);
      await reload();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>AIGC 应用</h2>
          <div className="desc">把大模型能力融入知识构建、坐席服务与客户洞察：会话小记、五级分类、子案件生成、应答建议、话术润色、文档抽取问答、相似问生成。所有生成结果都是「候选」，需人工采纳。</div>
        </div>
      </div>
      <Row gutter={[12, 12]}>
        {caps?.map((c) => (
          <Col key={c.id} xs={12} md={8} xl={6}>
            <Card size="small" hoverable onClick={() => { setCap(c.id); setResult(null); }} style={{ borderColor: c.id === cap ? '#1f6feb' : undefined }}>
              <b>{c.name}</b> <Tag style={{ float: 'right' }}>{c.input === 'conversationId' ? '会话' : '文本'}</Tag>
              <div style={{ color: '#6b7280', fontSize: 12, marginTop: 4 }}>{c.desc}</div>
            </Card>
          </Col>
        ))}
      </Row>
      <Row gutter={12} style={{ marginTop: 12 }}>
        <Col xs={24} lg={10}>
          <Card size="small" title={`运行 · ${current?.name ?? ''}`}>
            {current?.input === 'conversationId' ? (
              <Select style={{ width: '100%' }} value={conversationId ?? convs?.[0]?.id} onChange={setConversationId} options={convs?.map((c) => ({ value: c.id, label: `${c.customerName} · ${c.title} · ${c.messageCount} 条` }))} />
            ) : (
              <>
                <Input.TextArea rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder={cap === 'faq-extract' ? '粘贴资料原文' : cap === 'similar-questions' ? '输入标准问' : '输入待润色话术'} />
                {cap === 'rewrite' && <Input style={{ marginTop: 8 }} value={style} onChange={(e) => setStyle(e.target.value)} placeholder="风格要求" />}
              </>
            )}
            <Button type="primary" block style={{ marginTop: 10 }} loading={busy} onClick={run}>生成</Button>
          </Card>
        </Col>
        <Col xs={24} lg={14}>
          <Card size="small" title="结果（候选，需人工采纳）">
            {result ? <pre className="mono" style={{ whiteSpace: 'pre-wrap', margin: 0, maxHeight: 420, overflow: 'auto' }}>{JSON.stringify(result, null, 2)}</pre> : <Typography.Text type="secondary">选择能力并点击生成</Typography.Text>}
          </Card>
        </Col>
      </Row>
      <Card size="small" title="生成记录（用量可追溯）" style={{ marginTop: 12 }}>
        <Table size="small" rowKey="id" dataSource={jobs ?? []} pagination={{ pageSize: 8, size: 'small' }} columns={[
          { title: '时间', dataIndex: 'created_at', width: 170, render: fmtTime },
          { title: '能力', dataIndex: 'capability', width: 140, render: (v) => <Tag>{v}</Tag> },
          { title: '输入', dataIndex: 'input', ellipsis: true, render: (v) => JSON.stringify(v) },
          { title: '输出', dataIndex: 'output', ellipsis: true, render: (v) => JSON.stringify(v) },
          { title: '用量', dataIndex: 'usage', width: 200, render: (u: { durationMs: number; promptTokens: number; completionTokens: number }[] | null) => u ? `${u.reduce((s, x) => s + x.durationMs, 0)} ms · ${u.reduce((s, x) => s + x.promptTokens + x.completionTokens, 0)} tokens` : '—' },
        ]} />
      </Card>
    </div>
  );
}
