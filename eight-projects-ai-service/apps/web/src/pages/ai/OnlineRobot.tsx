import { useEffect, useRef, useState } from 'react';
import { Alert, App, Button, Card, Col, Input, Row, Select, Space, Tag, Typography } from 'antd';
import { ExportOutlined, SendOutlined, ThunderboltOutlined } from '@ant-design/icons';
import type { Conversation, Customer, Message, Trace } from '@eight/shared';
import { STAGE_LABELS } from '@eight/shared';
import { api, fmtShort, streamChat, type StageProgress } from '../../api';
import TraceViewer from '../../components/TraceViewer';

const STAGE_IDS = Object.keys(STAGE_LABELS) as (keyof typeof STAGE_LABELS)[];

const QUICK = ['订单 20260918000123 的快递三天没动了', '我的快递到哪了', '20260917000789 的专票开了吗', '发票抬头写错了想换开，订单 20260915000456', '20260910000321 刚买就降价了能退差价吗', '这个传感器洗澡能戴吗', 'OPPO 手机能激活吗', '你们态度太差了我要投诉', '转人工'];

export default function OnlineRobot() {
  const { message } = App.useApp();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customerId, setCustomerId] = useState<string | null>('cust-001');
  const [channel, setChannel] = useState('web');
  const [conv, setConv] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [trace, setTrace] = useState<Trace | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<StageProgress[]>([]);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api<Customer[]>('/api/customers').then(setCustomers).catch(() => setCustomers([]));
  }, []);
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);
  // 轮询：坐席在「在线客服」接管并回复后，这里的访客视图也能看到人工消息与状态变化
  useEffect(() => {
    if (!conv) return;
    const t = setInterval(async () => {
      if (busy) return;
      try {
        const d = await api<{ conversation: Conversation; messages: Message[] }>(`/api/conversations/${conv.id}`);
        setConv(d.conversation);
        setMessages(d.messages);
      } catch {
        /* 轮询失败忽略，下一轮再试 */
      }
    }, 4000);
    return () => clearInterval(t);
  }, [conv?.id, busy]);

  async function ensureConv() {
    if (conv) return conv;
    const c = await api<Conversation>('/api/conversations', { method: 'POST', body: { channel, customerId, title: '机器人体验会话', mode: 'bot' } });
    setConv(c);
    return c;
  }
  async function send(t?: string) {
    const value = (t ?? text).trim();
    if (!value || busy) return;
    setBusy(true);
    setProgress([]);
    setText('');
    try {
      const c = await ensureConv();
      const optimistic: Message = { id: `tmp-${Date.now()}`, conversationId: c.id, role: 'user', text: value, at: new Date().toISOString() };
      setMessages((m) => [...m, optimistic]);
      // SSE 流式：逐阶段推送进度，结束时返回与非流式接口相同的结果
      const r = await streamChat<{ message: Message; botMessage: Message | null; trace: Trace | null; conversation: Conversation }>(c.id, value, (s) => setProgress((p) => [...p.filter((x) => x.id !== s.id), s]));
      setConv(r.conversation);
      setTrace(r.trace);
      const detail = await api<{ messages: Message[] }>(`/api/conversations/${c.id}`);
      setMessages(detail.messages);
      if (r.conversation.controller === 'human') message.info(`会话已转人工（${r.conversation.priority ?? 'P2'}），在「在线客服」工作台可接续处理`);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
      setProgress([]);
    }
  }
  function reset() {
    setConv(null);
    setMessages([]);
    setTrace(null);
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>在线机器人 · 访客体验与执行链透视</h2>
          <div className="desc">左侧模拟访客端；每条用户消息触发一次完整的九阶段执行链，右侧实时展示每一环的输入、输出与决策依据。人工确认/升级时访客只收到等待或转接提示，候选话术留给坐席（见轨迹底部）。要像真实客户一样持续对话，请用「独立访客端」。</div>
        </div>
        <Space>
          <Select value={channel} onChange={setChannel} options={['web', 'app', 'wechat', 'taobao', 'douyin', 'jd'].map((c) => ({ value: c, label: `渠道：${c}` }))} style={{ width: 140 }} disabled={!!conv} />
          <Select value={customerId} onChange={setCustomerId} style={{ width: 220 }} disabled={!!conv} allowClear placeholder="匿名访客" options={customers.map((c) => ({ value: c.id, label: `${c.name} · ${c.level} · ${c.phone}` }))} />
          <Button icon={<ExportOutlined />} href={conv ? `/visitor/${conv.id}` : '/visitor'} target="_blank">独立访客端</Button>
          <Button onClick={reset}>新会话</Button>
        </Space>
      </div>
      <Row gutter={12}>
        <Col xs={24} lg={10}>
          <Card
            size="small"
            title={
              <Space>
                访客端
                {conv && (
                  <>
                    <Tag>{conv.id}</Tag>
                    <Tag color={conv.controller === 'bot' ? 'blue' : 'orange'}>{conv.controller === 'bot' ? '机器人接待' : `已转人工 ${conv.priority ?? ''}`}</Tag>
                  </>
                )}
              </Space>
            }
            styles={{ body: { padding: 0 } }}
          >
            <div ref={scroller} style={{ height: 420, overflow: 'auto', padding: 14, background: '#fafbfd' }}>
              {!messages.length && (
                <Alert type="info" showIcon message="试试下面的快捷问题，或直接输入。" description="示例数据：张伟(VIP)有一单停滞在武汉转运中心；王芳有专票待开；刘洋的订单在保价期内降价 20 元；赵敏正在退货退款。" />
              )}
              <div className="chat">
                {messages
                  .filter((m) => m.role !== 'system')
                  .map((m) => (
                    <div key={m.id} className={`bubble ${m.role}`}>
                      <span className="txt">{m.text}</span>
                      <span className="meta">
                        {{ user: '访客', bot: '机器人', agent: '人工客服', system: '系统' }[m.role]} · {fmtShort(m.at)}
                        {m.meta?.risk ? ` · 风险 ${m.meta.risk}` : ''}
                      </span>
                    </div>
                  ))}
                {busy && (
                  <div className="bubble bot">
                    正在处理（流式进度）
                    <div className="chain-progress">
                      {STAGE_IDS.map((id) => {
                        const done = progress.find((p) => p.id === id);
                        return (
                          <span key={id} className={done ? '' : 'pending'}>
                            {STAGE_LABELS[id]}
                            {done ? ` ${done.durationMs}ms` : ''}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            </div>
            <div style={{ padding: 10, borderTop: '1px solid #f0f0f0' }}>
              <Space wrap size={[6, 6]} style={{ marginBottom: 8 }}>
                {QUICK.map((q) => (
                  <Tag key={q} style={{ cursor: 'pointer' }} onClick={() => send(q)} icon={<ThunderboltOutlined />}>
                    {q}
                  </Tag>
                ))}
              </Space>
              <Space.Compact style={{ width: '100%' }}>
                <Input value={text} onChange={(e) => setText(e.target.value)} onPressEnter={() => send()} placeholder={conv?.controller === 'human' ? '会话已转人工，仍可继续留言' : '输入访客问题…'} disabled={busy} />
                <Button type="primary" icon={<SendOutlined />} onClick={() => send()} loading={busy}>
                  发送
                </Button>
              </Space.Compact>
            </div>
          </Card>
        </Col>
        <Col xs={24} lg={14}>
          <Card size="small" title="执行链轨迹（本轮）" extra={trace && <Typography.Text type="secondary">{trace.totalDurationMs} ms · {trace.usage.calls} 次模型调用</Typography.Text>}>
            <div style={{ maxHeight: 560, overflow: 'auto' }}>
              <TraceViewer trace={trace} />
            </div>
          </Card>
        </Col>
      </Row>
    </div>
  );
}
