import { useCallback, useEffect, useRef, useState } from 'react';
import { App, Button, Input, Rate, Select, Space, Tag, Tooltip } from 'antd';
import { CustomerServiceOutlined, PlusOutlined, RobotOutlined, SendOutlined, UserOutlined } from '@ant-design/icons';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { Conversation, Customer, Message } from '@eight/shared';
import { api, fmtShort } from '../api';

const STORAGE_KEY = 'eight.visitor.conversationId';
const QUICK = ['我的快递到哪了', '发票什么时候开', '刚买就降价了能退差价吗', '这个传感器洗澡能戴吗', '转人工'];
const POLL_MS = 3000;

interface Detail {
  conversation: Conversation;
  messages: Message[];
  customer: Customer | null;
}

/**
 * 独立访客端：模拟客户在网页/H5 客服入口看到的界面。
 * 与管理端无关；会话 ID 记在浏览器本地，刷新不丢；轮询拉取机器人与人工客服的回复。
 */
export default function Visitor() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const { message } = App.useApp();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [channel, setChannel] = useState('web');
  const [detail, setDetail] = useState<Detail | null>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [rated, setRated] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  // 没有会话 ID 时尝试恢复上次会话
  useEffect(() => {
    if (!id) {
      const last = localStorage.getItem(STORAGE_KEY);
      if (last) nav(`/visitor/${last}`, { replace: true });
    }
  }, [id, nav]);
  useEffect(() => {
    api<Customer[]>('/api/customers').then(setCustomers).catch(() => setCustomers([]));
  }, []);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const d = await api<Detail>(`/api/conversations/${id}`);
      setDetail(d);
      localStorage.setItem(STORAGE_KEY, id);
    } catch (e) {
      if ((e as { status?: number }).status === 404) {
        localStorage.removeItem(STORAGE_KEY);
        nav('/visitor', { replace: true });
      }
    }
  }, [id, nav]);
  useEffect(() => {
    if (!id) {
      setDetail(null);
      return;
    }
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [id, load]);
  const visible = detail?.messages.filter((m) => m.role !== 'system') ?? [];
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
  }, [visible.length, sending]);

  async function start() {
    const c = await api<Conversation>('/api/conversations', { method: 'POST', body: { channel, customerId, title: '访客咨询', mode: 'bot' } });
    localStorage.setItem(STORAGE_KEY, c.id);
    nav(`/visitor/${c.id}`);
  }
  function fresh() {
    localStorage.removeItem(STORAGE_KEY);
    setDetail(null);
    setRated(false);
    nav('/visitor');
  }
  async function send(t?: string) {
    const value = (t ?? text).trim();
    if (!value || !id || sending) return;
    setSending(true);
    setText('');
    try {
      await api(`/api/conversations/${id}/messages`, { method: 'POST', body: { role: 'user', text: value } });
      await load();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSending(false);
    }
  }
  async function rate(score: number) {
    if (!id) return;
    await api(`/api/conversations/${id}/rate`, { method: 'POST', body: { score } });
    setRated(true);
    message.success('感谢您的评价');
  }

  const conv = detail?.conversation;
  const closed = conv?.status === 'closed';
  const human = conv?.controller === 'human';
  const status = !conv ? null : closed ? { text: '会话已结束', color: 'default' } : human ? (conv.status === 'waiting_human' ? { text: `排队等待人工客服${conv.priority ? ` · ${conv.priority}` : ''}`, color: 'orange' } : { text: `人工客服 ${conv.assignee ?? ''} 为您服务`, color: 'purple' }) : { text: '智能客服在线', color: 'green' };

  return (
    <div className="visitor-bg">
      <div className="visitor-widget">
        <div className="visitor-head">
          <div className="brand">
            <span className="dot" />
            <div>
              <div style={{ fontWeight: 600 }}>欧态官方客服</div>
              <div style={{ fontSize: 11, opacity: 0.85 }}>{status ? status.text : '7×24 小时在线'}</div>
            </div>
          </div>
          <Space size={4}>
            {status && <Tag color={status.color} style={{ marginRight: 0 }}>{human ? <CustomerServiceOutlined /> : <RobotOutlined />} {status.text}</Tag>}
            {conv && (
              <Tooltip title="开始新的咨询">
                <Button size="small" ghost icon={<PlusOutlined />} onClick={fresh} />
              </Tooltip>
            )}
          </Space>
        </div>

        {!id ? (
          <div className="visitor-start">
            <h3>欢迎咨询欧态</h3>
            <p>选择身份与来源渠道后开始。演示环境：选择已有客户可让机器人自动带出订单、物流、发票等资料。</p>
            <Select value={customerId} onChange={setCustomerId} allowClear placeholder="匿名访客" style={{ width: '100%' }} options={customers.map((c) => ({ value: c.id, label: `${c.name} · ${c.level} · ${c.phone}` }))} />
            <Select value={channel} onChange={setChannel} style={{ width: '100%', marginTop: 8 }} options={[['web', '官网网页'], ['app', '欧态健康 App'], ['wechat', '微信公众号'], ['taobao', '淘宝旗舰店'], ['douyin', '抖音小店'], ['jd', '京东旗舰店']].map(([v, l]) => ({ value: v, label: l }))} />
            <Button type="primary" block style={{ marginTop: 14 }} onClick={start}>开始咨询</Button>
            <div className="visitor-foot">管理端入口：<Link to="/reception/online">在线客服工作台</Link> · <Link to="/ai/online-robot">执行链透视</Link></div>
          </div>
        ) : (
          <>
            <div className="visitor-body" ref={scroller}>
              {!visible.length && <div className="visitor-hint">您好，我是欧态智能客服。可以直接描述问题，或点击下方常见问题。</div>}
              {visible.map((m) => (
                <div key={m.id} className={`vmsg ${m.role === 'user' ? 'me' : 'them'}`}>
                  {m.role !== 'user' && <div className={`avatar ${m.role}`}>{m.role === 'agent' ? <UserOutlined /> : <RobotOutlined />}</div>}
                  <div>
                    <div className="who">{{ user: '我', bot: '智能客服', agent: conv?.assignee ?? '人工客服', system: '' }[m.role]} · {fmtShort(m.at)}</div>
                    <div className={`vbubble ${m.role}`}><span className="txt">{m.text}</span></div>
                  </div>
                </div>
              ))}
              {sending && (
                <div className="vmsg them">
                  <div className="avatar bot"><RobotOutlined /></div>
                  <div><div className="who">智能客服</div><div className="vbubble bot typing"><span /><span /><span /></div></div>
                </div>
              )}
              {closed && (
                <div className="visitor-rate">
                  <div>本次服务已结束，请为我们的服务打分</div>
                  <Rate disabled={rated} defaultValue={conv?.satisfaction ?? 0} onChange={rate} />
                  <Button size="small" type="link" onClick={fresh}>开始新的咨询</Button>
                </div>
              )}
            </div>
            <div className="visitor-input">
              {!closed && (
                <div className="chips">
                  {QUICK.map((q) => (
                    <button key={q} type="button" onClick={() => send(q)} disabled={sending}>{q}</button>
                  ))}
                </div>
              )}
              <Space.Compact style={{ width: '100%' }}>
                <Input value={text} onChange={(e) => setText(e.target.value)} onPressEnter={() => send()} disabled={closed || sending} placeholder={closed ? '会话已结束' : human ? '人工客服在线，请输入…' : '请输入您的问题…'} />
                <Button type="primary" icon={<SendOutlined />} loading={sending} disabled={closed} onClick={() => send()}>发送</Button>
              </Space.Compact>
              <div className="visitor-foot">由 AI 客服与人工客服共同为您服务 · 会话 {conv?.id ?? id}</div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
