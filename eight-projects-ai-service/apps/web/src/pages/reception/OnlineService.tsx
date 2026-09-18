import { useEffect, useMemo, useRef, useState } from 'react';
import { App, Badge, Button, Descriptions, Drawer, Empty, Form, Input, Modal, Segmented, Select, Space, Tabs, Tag, Tooltip, Typography } from 'antd';
import { BulbOutlined, EyeOutlined, FileTextOutlined, RobotOutlined, SendOutlined, SolutionOutlined, SwapOutlined, TagsOutlined, UserSwitchOutlined } from '@ant-design/icons';
import type { Conversation, Customer, Message, Trace } from '@eight/shared';
import { api, fmtShort, fmtTime, useApi } from '../../api';
import TraceViewer, { DecisionTag, RiskTag } from '../../components/TraceViewer';

interface Detail {
  conversation: Conversation;
  messages: Message[];
  customer: Customer | null;
  orders: { id: string; product: string; status: string; paid_amount: number; created_at: string }[];
  traces: { id: string; created_at: string; scenario: string; intent: string; decision: string; risk_level: string; duration_ms: number }[];
  tickets: { id: string; title: string; status: string; priority: string }[];
}

const statusMeta: Record<string, { text: string; color: string }> = { waiting_human: { text: '待接入', color: 'red' }, open: { text: '进行中', color: 'green' }, closed: { text: '已结束', color: 'default' } };

export default function OnlineService() {
  const { message, modal } = App.useApp();
  const [filter, setFilter] = useState<string>('all');
  const listPath = filter === 'all' ? '/api/conversations' : `/api/conversations?status=${filter}`;
  const { data: list, reload } = useApi<Conversation[]>(listPath, { pollMs: 8000 });
  const [activeId, setActiveId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [assist, setAssist] = useState<Trace | null>(null);
  const [assistLoading, setAssistLoading] = useState(false);
  const [traceOpen, setTraceOpen] = useState<Trace | null>(null);
  const [ticketOpen, setTicketOpen] = useState(false);
  const [ticketForm] = Form.useForm();
  const [summary, setSummary] = useState<{ problem: string; handling: string; outcome: string; followUp: string; tags: string[] } | null>(null);
  const [classification, setClassification] = useState<{ level1: string; level2: string; level3: string; emotion: string; urgency: string } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!activeId && list?.length) setActiveId(list[0].id);
  }, [list, activeId]);
  async function loadDetail(id: string) {
    const d = await api<Detail>(`/api/conversations/${id}`);
    setDetail(d);
  }
  useEffect(() => {
    if (!activeId) return;
    setAssist(null);
    setSummary(null);
    setClassification(null);
    void loadDetail(activeId);
    const t = setInterval(() => void loadDetail(activeId), 6000);
    return () => clearInterval(t);
  }, [activeId]);
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [detail?.messages.length]);

  const conv = detail?.conversation;
  const waitingCount = useMemo(() => list?.filter((c) => c.status === 'waiting_human').length ?? 0, [list]);

  async function control(action: 'takeover' | 'robot' | 'close' | 'reopen' | 'handoff') {
    if (!conv) return;
    try {
      await api(`/api/conversations/${conv.id}/control`, { method: 'POST', body: { action, actor: '客服小欧' } });
      await loadDetail(conv.id);
      await reload();
      message.success({ takeover: '已接管会话', robot: '已交回机器人', close: '会话已结束', reopen: '已重新打开', handoff: '已转入人工队列' }[action]);
    } catch (e) {
      message.error((e as Error).message);
    }
  }
  async function send(role: 'agent' | 'user') {
    if (!conv || !draft.trim()) return;
    setBusy(true);
    try {
      await api(`/api/conversations/${conv.id}/messages`, { method: 'POST', body: { role, text: draft.trim() } });
      setDraft('');
      await loadDetail(conv.id);
      await reload();
    } catch (e) {
      const err = e as Error & { body?: { code?: string } };
      if (err.body?.code === 'TAKEOVER_REQUIRED') {
        modal.confirm({ title: '当前由机器人接待', content: '需要先接管会话才能以人工身份回复。是否立即接管？', onOk: () => control('takeover') });
      } else message.error(err.message);
    } finally {
      setBusy(false);
    }
  }
  async function runAssist() {
    if (!conv) return;
    setAssistLoading(true);
    try {
      const r = await api<{ trace: Trace }>(`/api/conversations/${conv.id}/assist`, { method: 'POST' });
      setAssist(r.trace);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setAssistLoading(false);
    }
  }
  async function genSummary() {
    if (!conv) return;
    try {
      setSummary(await api(`/api/conversations/${conv.id}/summary`, { method: 'POST' }));
    } catch (e) {
      message.error((e as Error).message);
    }
  }
  async function genClassify() {
    if (!conv) return;
    try {
      setClassification(await api(`/api/conversations/${conv.id}/classify`, { method: 'POST' }));
    } catch (e) {
      message.error((e as Error).message);
    }
  }
  async function openTicketFromAi() {
    if (!conv) return;
    try {
      const t = await api<{ title: string; type: string; priority: string; description: string }>('/api/aigc/ticket-extract', { method: 'POST', body: { conversationId: conv.id } });
      ticketForm.setFieldsValue(t);
      setTicketOpen(true);
    } catch (e) {
      message.error((e as Error).message);
    }
  }
  async function createTicket() {
    if (!conv) return;
    const v = await ticketForm.validateFields();
    await api(`/api/conversations/${conv.id}/ticket`, { method: 'POST', body: { ...v, actor: '客服小欧' } });
    setTicketOpen(false);
    message.success('工单已创建');
    await loadDetail(conv.id);
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>在线客服 · 坐席工作台</h2>
          <div className="desc">会话列表 · 聊天主区 · 客户上下文三栏。机器人前置接待，触发风险或用户要求时转入人工队列；坐席可一键获取 AI 应答建议、会话小记、智能分类与工单。</div>
        </div>
        <Segmented value={filter} onChange={(v) => setFilter(v as string)} options={[{ label: '全部', value: 'all' }, { label: <Badge count={waitingCount} size="small" offset={[8, 0]}>待接入</Badge>, value: 'waiting_human' }, { label: '进行中', value: 'open' }, { label: '已结束', value: 'closed' }]} />
      </div>
      <div className="workbench">
        <div className="col">
          <div className="col-head">会话列表 <Tag>{list?.length ?? 0}</Tag></div>
          <div className="col-body" style={{ padding: 0 }}>
            {list?.map((c) => (
              <div key={c.id} className={`conv-item ${c.id === activeId ? 'active' : ''}`} onClick={() => setActiveId(c.id)}>
                <div className="t">
                  <span>{c.customerName}</span>
                  <span style={{ color: '#9ca3af', fontWeight: 400, fontSize: 12 }}>{fmtShort(c.lastMessageAt)}</span>
                </div>
                <div className="s">
                  <Tag color={statusMeta[c.status]?.color} style={{ marginRight: 0 }}>{statusMeta[c.status]?.text}</Tag>
                  {c.priority && <Tag color={c.priority === 'P0' ? 'red' : c.priority === 'P1' ? 'orange' : 'default'} style={{ marginRight: 0 }}>{c.priority}</Tag>}
                  <span>{c.channel}</span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.title}</span>
                </div>
              </div>
            ))}
            {!list?.length && <Empty style={{ marginTop: 40 }} description="暂无会话" />}
          </div>
        </div>
        <div className="col">
          <div className="col-head">
            <Space>
              {conv ? (
                <>
                  <span>{conv.customerName}</span>
                  <Tag color={statusMeta[conv.status]?.color}>{statusMeta[conv.status]?.text}</Tag>
                  <Tag color={conv.controller === 'bot' ? 'blue' : 'purple'}>{conv.controller === 'bot' ? '机器人接待' : `人工 · ${conv.assignee ?? '未分配'}`}</Tag>
                  {conv.scenario && <Tag>{conv.scenario}</Tag>}
                </>
              ) : (
                '请选择会话'
              )}
            </Space>
            {conv && (
              <Space size={4}>
                {conv.controller === 'bot' ? (
                  <Button size="small" icon={<UserSwitchOutlined />} onClick={() => control('takeover')}>接管</Button>
                ) : (
                  <Button size="small" icon={<RobotOutlined />} onClick={() => control('robot')}>交回机器人</Button>
                )}
                <Button size="small" icon={<SwapOutlined />} onClick={() => control('handoff')}>转接</Button>
                {conv.status === 'closed' ? <Button size="small" onClick={() => control('reopen')}>重开</Button> : <Button size="small" danger onClick={() => control('close')}>结束</Button>}
                <Tooltip title="以访客视角打开本会话（新标签页），可模拟客户继续提问"><Button size="small" icon={<EyeOutlined />} href={`/visitor/${conv.id}`} target="_blank">访客视角</Button></Tooltip>
              </Space>
            )}
          </div>
          <div className="col-body" ref={scroller} style={{ background: '#fafbfd' }}>
            <div className="chat">
              {detail?.messages.map((m) => (
                <div key={m.id} className={`bubble ${m.role}`}>
                  <span className="txt">{m.text}</span>
                  <span className="meta">
                    {{ user: conv?.customerName ?? '访客', bot: '机器人', agent: conv?.assignee ?? '人工客服', system: '系统' }[m.role]} · {fmtShort(m.at)}
                    {m.traceId && (
                      <a style={{ marginLeft: 8 }} onClick={() => api<Trace>(`/api/traces/${m.traceId}`).then(setTraceOpen)}>
                        查看执行链
                      </a>
                    )}
                  </span>
                </div>
              ))}
            </div>
          </div>
          <div style={{ borderTop: '1px solid #f0f0f0', padding: 10 }}>
            {assist && (
              <div style={{ background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 6, padding: '8px 10px', marginBottom: 8, fontSize: 13 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <Space size={4}>
                    <BulbOutlined /> AI 应答建议 <RiskTag level={assist.risk?.level} /> <DecisionTag decision={assist.autonomy?.decision} priority={assist.autonomy?.priority} />
                  </Space>
                  <Space size={4}>
                    <Button size="small" type="link" onClick={() => setTraceOpen(assist)}>依据</Button>
                    <Button size="small" type="primary" onClick={() => setDraft(assist.reply?.candidate || assist.reply?.text || '')}>采用到输入框</Button>
                  </Space>
                </div>
                {/* 坐席看到的是候选话术（待确认），不是访客端收到的等待提示 */}
                <div style={{ whiteSpace: 'pre-wrap' }}>{assist.reply?.candidate || assist.reply?.text}</div>
                {assist.autonomy?.decision !== 'auto_reply' && <div style={{ marginTop: 4, fontSize: 12, color: '#6b7280' }}>该建议未自动发送，需坐席核对后采用。</div>}
              </div>
            )}
            <Input.TextArea value={draft} onChange={(e) => setDraft(e.target.value)} rows={3} placeholder={conv?.controller === 'bot' ? '机器人接待中：以人工回复需先接管；也可用「模拟访客」测试机器人' : '输入回复，Ctrl+Enter 发送'} onKeyDown={(e) => e.ctrlKey && e.key === 'Enter' && send('agent')} />
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
              <Space size={4}>
                <Tooltip title="用执行链重新分析最后一条用户消息，生成带依据的建议"><Button size="small" icon={<BulbOutlined />} loading={assistLoading} onClick={runAssist}>AI 建议</Button></Tooltip>
                <Button size="small" icon={<FileTextOutlined />} onClick={genSummary}>会话小记</Button>
                <Button size="small" icon={<TagsOutlined />} onClick={genClassify}>智能分类</Button>
                <Button size="small" icon={<SolutionOutlined />} onClick={openTicketFromAi}>生成工单</Button>
              </Space>
              <Space size={4}>
                <Button size="small" onClick={() => send('user')} disabled={!draft.trim() || busy}>模拟访客发送</Button>
                <Button size="small" type="primary" icon={<SendOutlined />} onClick={() => send('agent')} loading={busy} disabled={!draft.trim()}>发送</Button>
              </Space>
            </div>
          </div>
        </div>
        <div className="col">
          <div className="col-head">客户上下文</div>
          <div className="col-body">
            {detail ? (
              <Tabs
                size="small"
                items={[
                  {
                    key: 'c',
                    label: '客户 360',
                    children: (
                      <>
                        <Descriptions size="small" column={1}>
                          <Descriptions.Item label="姓名">{detail.customer?.name ?? '匿名'} {detail.customer && <Tag color={detail.customer.level === 'normal' ? 'default' : 'gold'}>{detail.customer.level}</Tag>}</Descriptions.Item>
                          <Descriptions.Item label="手机">{detail.customer?.phone || '—'}</Descriptions.Item>
                          <Descriptions.Item label="标签">{detail.customer?.tags.map((t) => <Tag key={t}>{t}</Tag>)}</Descriptions.Item>
                          <Descriptions.Item label="备注">{detail.customer?.note || '—'}</Descriptions.Item>
                        </Descriptions>
                        <Typography.Text strong>历史订单</Typography.Text>
                        {detail.orders.map((o) => (
                          <div key={o.id} style={{ fontSize: 12, padding: '6px 0', borderBottom: '1px dashed #eee' }}>
                            <div className="mono">{o.id}</div>
                            <div>{o.product} · ¥{o.paid_amount} · <Tag style={{ marginRight: 0 }}>{o.status}</Tag></div>
                          </div>
                        ))}
                        {summary && (
                          <div style={{ marginTop: 10 }}>
                            <Typography.Text strong>会话小记</Typography.Text>
                            <div style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>问题：{summary.problem}
{'\n'}处理：{summary.handling}
{'\n'}结果：{summary.outcome}{summary.followUp ? `\n跟进：${summary.followUp}` : ''}</div>
                            <div>{summary.tags.map((t) => <Tag key={t}>{t}</Tag>)}</div>
                          </div>
                        )}
                        {classification && (
                          <div style={{ marginTop: 10 }}>
                            <Typography.Text strong>智能分类</Typography.Text>
                            <div style={{ fontSize: 12 }}>{classification.level1} / {classification.level2}{classification.level3 ? ` / ${classification.level3}` : ''} · 情绪 {classification.emotion} · 紧急 {classification.urgency}</div>
                          </div>
                        )}
                      </>
                    ),
                  },
                  {
                    key: 't',
                    label: `执行链 ${detail.traces.length}`,
                    children: detail.traces.length ? detail.traces.map((t) => (
                      <div key={t.id} style={{ fontSize: 12, padding: '6px 0', borderBottom: '1px dashed #eee', cursor: 'pointer' }} onClick={() => api<Trace>(`/api/traces/${t.id}`).then(setTraceOpen)}>
                        <div>{fmtTime(t.created_at)} · {t.duration_ms} ms</div>
                        <Space size={4}><Tag>{t.scenario}</Tag><RiskTag level={t.risk_level} /><DecisionTag decision={t.decision} /></Space>
                        <div style={{ color: '#6b7280' }}>{t.intent}</div>
                      </div>
                    )) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚无执行记录" />,
                  },
                  { key: 'k', label: `工单 ${detail.tickets.length}`, children: detail.tickets.length ? detail.tickets.map((t) => <div key={t.id} style={{ fontSize: 12, padding: '6px 0', borderBottom: '1px dashed #eee' }}><span className="mono">{t.id}</span> {t.title} <Tag>{t.status}</Tag><Tag>{t.priority}</Tag></div>) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无关联工单" /> },
                ]}
              />
            ) : (
              <Empty description="选择会话查看客户信息" />
            )}
          </div>
        </div>
      </div>
      <Drawer open={!!traceOpen} onClose={() => setTraceOpen(null)} width={720} title="执行链轨迹">
        <TraceViewer trace={traceOpen} />
      </Drawer>
      <Modal open={ticketOpen} onCancel={() => setTicketOpen(false)} onOk={createTicket} title="从会话创建工单（AI 已预填）" okText="创建">
        <Form form={ticketForm} layout="vertical">
          <Form.Item name="title" label="标题" rules={[{ required: true }]}><Input /></Form.Item>
          <Space>
            <Form.Item name="type" label="类型"><Select style={{ width: 140 }} options={['物流', '发票', '退款', '投诉', '售前', '其他'].map((v) => ({ value: v }))} /></Form.Item>
            <Form.Item name="priority" label="优先级"><Select style={{ width: 120 }} options={['P0', 'P1', 'P2'].map((v) => ({ value: v }))} /></Form.Item>
          </Space>
          <Form.Item name="description" label="描述"><Input.TextArea rows={4} /></Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
