import { useState } from 'react';
import { App, Button, Col, Drawer, Form, Input, Modal, Row, Select, Space, Table, Tag, Timeline, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import type { Ticket } from '@eight/shared';
import { api, fmtTime, useApi } from '../../api';

const statusMeta: Record<Ticket['status'], { text: string; color: string }> = { open: { text: '待处理', color: 'blue' }, processing: { text: '处理中', color: 'processing' }, pending: { text: '待审核', color: 'orange' }, resolved: { text: '已解决', color: 'green' }, closed: { text: '已关闭', color: 'default' } };
const prioColor: Record<string, string> = { P0: 'red', P1: 'orange', P2: 'default' };
const ASSIGNEES = ['客服小欧', '物流专员', '财务小周', '主管王琳', '售后二线'];

export default function Tickets() {
  const { message } = App.useApp();
  const [status, setStatus] = useState<string | undefined>();
  const [priority, setPriority] = useState<string | undefined>();
  const q = new URLSearchParams();
  if (status) q.set('status', status);
  if (priority) q.set('priority', priority);
  const { data: list, loading, reload } = useApi<Ticket[]>(`/api/tickets?${q.toString()}`, { pollMs: 10_000 });
  const { data: stats, reload: reloadStats } = useApi<{ byStatus: { status: string; n: number }[]; byPriority: { priority: string; n: number }[]; overdue: number; total: number }>('/api/tickets/stats', { pollMs: 10_000 });
  const [active, setActive] = useState<Ticket | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [form] = Form.useForm();
  const [note, setNote] = useState('');

  async function patch(id: string, body: Record<string, unknown>) {
    try {
      const t = await api<Ticket>(`/api/tickets/${id}`, { method: 'PATCH', body: { ...body, note, actor: '客服小欧' } });
      setActive(t);
      setNote('');
      await Promise.all([reload(), reloadStats()]);
      message.success('已更新');
    } catch (e) {
      message.error((e as Error).message);
    }
  }
  async function create() {
    const v = await form.validateFields();
    await api('/api/tickets', { method: 'POST', body: { ...v, actor: '客服小欧' } });
    setCreateOpen(false);
    form.resetFields();
    await Promise.all([reload(), reloadStats()]);
    message.success('工单已创建');
  }
  const overdue = (t: Ticket) => !['resolved', 'closed'].includes(t.status) && new Date(t.slaDueAt).getTime() < Date.now();

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>工单系统</h2>
          <div className="desc">跨部门协作闭环：会话一键建单、执行链自动建单、SLA 时限、流转记录完整可追溯。</div>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>新建工单</Button>
      </div>
      <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
        {[
          ['全部工单', stats?.total],
          ['待处理', stats?.byStatus.find((s) => s.status === 'open')?.n ?? 0],
          ['处理中', stats?.byStatus.find((s) => s.status === 'processing')?.n ?? 0],
          ['待审核', stats?.byStatus.find((s) => s.status === 'pending')?.n ?? 0],
          ['SLA 超时', stats?.overdue],
          ['P0/P1', (stats?.byPriority.filter((p) => p.priority !== 'P2').reduce((s, p) => s + p.n, 0)) ?? 0],
        ].map(([l, v]) => (
          <Col key={String(l)} xs={8} md={4}>
            <div className="kpi"><div className="label">{l}</div><div className="value" style={{ color: l === 'SLA 超时' && Number(v) > 0 ? '#cf1322' : undefined }}>{v ?? '—'}</div></div>
          </Col>
        ))}
      </Row>
      <Space style={{ marginBottom: 10 }}>
        <Select allowClear placeholder="状态" style={{ width: 130 }} value={status} onChange={setStatus} options={Object.entries(statusMeta).map(([k, v]) => ({ value: k, label: v.text }))} />
        <Select allowClear placeholder="优先级" style={{ width: 120 }} value={priority} onChange={setPriority} options={['P0', 'P1', 'P2'].map((v) => ({ value: v }))} />
      </Space>
      <Table<Ticket>
        rowKey="id"
        size="small"
        loading={loading && !list}
        dataSource={list ?? []}
        onRow={(t) => ({ onClick: () => setActive(t), style: { cursor: 'pointer' } })}
        pagination={{ pageSize: 12, size: 'small' }}
        columns={[
          { title: '工单号', dataIndex: 'id', render: (v) => <span className="mono">{v}</span>, width: 170 },
          { title: '标题', dataIndex: 'title', ellipsis: true },
          { title: '类型', dataIndex: 'type', width: 80 },
          { title: '客户', dataIndex: 'customerName', width: 90 },
          { title: '优先级', dataIndex: 'priority', width: 80, render: (v) => <Tag color={prioColor[v]}>{v}</Tag> },
          { title: '状态', dataIndex: 'status', width: 90, render: (v: Ticket['status']) => <Tag color={statusMeta[v].color}>{statusMeta[v].text}</Tag> },
          { title: '处理人', dataIndex: 'assignee', width: 100, render: (v) => v ?? <Typography.Text type="secondary">未分配</Typography.Text> },
          { title: '来源', dataIndex: 'source', width: 80, render: (v) => ({ manual: '手工', agent: '坐席', chain: '执行链' } as Record<string, string>)[v] },
          { title: 'SLA', dataIndex: 'slaDueAt', width: 160, render: (v, t) => <span style={{ color: overdue(t) ? '#cf1322' : undefined }}>{fmtTime(v)}{overdue(t) ? ' 超时' : ''}</span> },
          { title: '创建', dataIndex: 'createdAt', width: 160, render: fmtTime },
        ]}
      />
      <Drawer open={!!active} onClose={() => setActive(null)} width={560} title={active ? <span><span className="mono">{active.id}</span> · {active.title}</span> : ''}>
        {active && (
          <>
            <Space wrap style={{ marginBottom: 12 }}>
              <Tag color={prioColor[active.priority]}>{active.priority}</Tag>
              <Tag color={statusMeta[active.status].color}>{statusMeta[active.status].text}</Tag>
              <Tag>{active.type}</Tag>
              <Tag>客户 {active.customerName}</Tag>
              {active.conversationId && <Tag>会话 {active.conversationId}</Tag>}
            </Space>
            <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', background: '#fafafa', padding: 10, borderRadius: 6 }}>{active.description || '（无描述）'}</Typography.Paragraph>
            <Space wrap style={{ marginBottom: 12 }}>
              <Select value={active.assignee ?? undefined} placeholder="转派处理人" style={{ width: 150 }} onChange={(v) => patch(active.id, { assignee: v })} options={ASSIGNEES.map((a) => ({ value: a }))} />
              <Select value={active.priority} style={{ width: 100 }} onChange={(v) => patch(active.id, { priority: v })} options={['P0', 'P1', 'P2'].map((v) => ({ value: v }))} />
            </Space>
            <Input.TextArea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="处理备注（随状态变更一起记录）" style={{ marginBottom: 8 }} />
            <Space wrap>
              {active.status === 'open' && <Button type="primary" onClick={() => patch(active.id, { status: 'processing' })}>开始处理</Button>}
              {active.status === 'processing' && <Button onClick={() => patch(active.id, { status: 'pending' })}>提交审核</Button>}
              {['processing', 'pending'].includes(active.status) && <Button type="primary" onClick={() => patch(active.id, { status: 'resolved' })}>标记解决</Button>}
              {active.status === 'resolved' && <Button onClick={() => patch(active.id, { status: 'closed' })}>关闭</Button>}
              {['resolved', 'closed'].includes(active.status) && <Button onClick={() => patch(active.id, { status: 'open' })}>重新打开</Button>}
              <Button onClick={() => patch(active.id, {})} disabled={!note.trim()}>仅添加备注</Button>
            </Space>
            <Typography.Title level={5} style={{ marginTop: 18 }}>流转记录</Typography.Title>
            <Timeline items={active.history.map((h) => ({ children: <div><div style={{ fontSize: 12, color: '#6b7280' }}>{fmtTime(h.at)} · {h.by}</div><div>{h.action}</div>{h.note && <div style={{ color: '#4b5563' }}>备注：{h.note}</div>}</div> }))} />
          </>
        )}
      </Drawer>
      <Modal open={createOpen} onCancel={() => setCreateOpen(false)} onOk={create} title="新建工单" okText="创建">
        <Form form={form} layout="vertical" initialValues={{ type: '其他', priority: 'P2' }}>
          <Form.Item name="title" label="标题" rules={[{ required: true, message: '请输入标题' }]}><Input /></Form.Item>
          <Space>
            <Form.Item name="type" label="类型"><Select style={{ width: 140 }} options={['物流', '发票', '退款', '投诉', '售前', '其他'].map((v) => ({ value: v }))} /></Form.Item>
            <Form.Item name="priority" label="优先级"><Select style={{ width: 120 }} options={['P0', 'P1', 'P2'].map((v) => ({ value: v }))} /></Form.Item>
            <Form.Item name="assignee" label="处理人"><Select allowClear style={{ width: 150 }} options={ASSIGNEES.map((a) => ({ value: a }))} /></Form.Item>
          </Space>
          <Form.Item name="description" label="描述"><Input.TextArea rows={4} /></Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
