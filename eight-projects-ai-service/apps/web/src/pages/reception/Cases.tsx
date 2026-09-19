import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, App, Button, Col, Collapse, Drawer, Form, Input, Modal, Row, Select, Space, Table, Tabs, Tag, Timeline, Tooltip, Typography } from 'antd';
import { ApiOutlined, LinkOutlined, PlusOutlined, ReloadOutlined, UserSwitchOutlined } from '@ant-design/icons';
import type { CaseStatus, DmsMockMode, HandoffTask, SubCase } from '@eight/shared';
import { api, fmtTime, useApi } from '../../api';
import { useAuth } from '../../auth';

/**
 * 工单协作 = 子案件 + 人工接续任务 + DMS 关联（CS-003 / CS-008E-I / CS-016）。
 * 正式售后工单只在 DMS；本地状态只有 待人工 / 处理中 / 已关联 DMS / 已归档。
 */
const caseStatusMeta: Record<CaseStatus, { text: string; color: string }> = {
  pending_human: { text: '待人工', color: 'blue' },
  in_progress: { text: '处理中', color: 'processing' },
  linked_dms: { text: '已关联 DMS', color: 'green' },
  archived: { text: '已归档', color: 'default' },
};
const taskStatusMeta: Record<HandoffTask['status'], { text: string; color: string }> = {
  pending: { text: '待接续', color: 'red' },
  claimed: { text: '接续中', color: 'processing' },
  done: { text: '已完成', color: 'green' },
  cancelled: { text: '已取消', color: 'default' },
};
const prioColor: Record<string, string> = { P0: 'red', P1: 'orange', P2: 'default' };
const dmsStatusColor: Record<string, string> = { received: 'blue', processing: 'processing', resolved: 'green', closed: 'default' };
const ASSIGNEES = ['客服小欧', '物流专员', '财务小周', '主管王琳', '售后二线'];
const MODE_LABEL: Record<DmsMockMode, string> = { normal: '正常', unavailable: '不可用（连接超时）', reject: '拒绝建单', account_cancelled: '激活账号已注销', slow: '慢响应 1.5s' };

type TaskRow = HandoffTask & { conversation: { id: string; title: string; channel: string; controller: string; status: string } | null };
interface CaseStats { byStatus: { status: string; n: number }[]; byPriority: { priority: string; n: number }[]; dmsPending: number; total: number }
interface TaskStats { pendingByPriority: { priority: string; n: number }[]; pending: number; claimed: number; overdue: number }
interface DmsMockInfo { mode: DmsMockMode; tickets: { ticketNo: string; status: string; updatedAt: string; caseId: string; createdAt: string }[] }

export default function Cases() {
  const { message } = App.useApp();
  const nav = useNavigate();
  const { can } = useAuth();
  const isAdmin = can(['admin']);
  const [tab, setTab] = useState('handoffs');

  const { data: taskStats, reload: reloadTaskStats } = useApi<TaskStats>('/api/handoffs/stats', { pollMs: 10_000 });
  const { data: caseStats, reload: reloadCaseStats } = useApi<CaseStats>('/api/cases/stats', { pollMs: 10_000 });
  const [taskFilter, setTaskFilter] = useState<'active' | 'done' | 'cancelled'>('active');
  const { data: tasks, loading: tasksLoading, reload: reloadTasks } = useApi<TaskRow[]>(`/api/handoffs?status=${taskFilter === 'active' ? 'pending|claimed' : taskFilter}`, { pollMs: 8000 });
  const [caseStatus, setCaseStatus] = useState<string | undefined>();
  const [casePriority, setCasePriority] = useState<string | undefined>();
  const q = new URLSearchParams();
  if (caseStatus) q.set('status', caseStatus);
  if (casePriority) q.set('priority', casePriority);
  const { data: cases, loading: casesLoading, reload: reloadCases } = useApi<SubCase[]>(`/api/cases?${q.toString()}`, { pollMs: 10_000 });
  const { data: mock, reload: reloadMock } = useApi<DmsMockInfo>(isAdmin ? '/api/dms/mock' : null, { pollMs: 10_000 });
  const { data: health, reload: reloadHealth } = useApi<{ ok: boolean; kind: string; mode: string }>('/api/dms/health', { pollMs: 10_000 });

  const [active, setActive] = useState<SubCase | null>(null);
  const [note, setNote] = useState('');
  const [attachNo, setAttachNo] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [form] = Form.useForm();
  const [busy, setBusy] = useState<string | null>(null);

  const refreshAll = () => Promise.all([reloadTasks(), reloadTaskStats(), reloadCases(), reloadCaseStats(), reloadMock(), reloadHealth()]);
  const run = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    try {
      await fn();
      await refreshAll();
      if (ok) message.success(ok);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  async function patchCase(id: string, body: Record<string, unknown>) {
    await run('patch', async () => setActive(await api<SubCase>(`/api/cases/${id}`, { method: 'PATCH', body: { ...body, note } })), '已更新');
    setNote('');
  }
  async function dmsAction(id: string, path: 'link' | 'refresh' | 'attach', body?: Record<string, unknown>) {
    await run(`dms-${path}`, async () => {
      const c = await api<SubCase>(`/api/cases/${id}/dms/${path}`, { method: 'POST', body: body ?? {} });
      setActive(c);
      if (c.dms.pending) message.warning('DMS 不可用，已转为待同步案件；恢复后可在「DMS 模拟」Tab 重试');
      else if (!c.dms.ticketNo && c.dms.lastError) message.error(c.dms.lastError);
    }, undefined);
    setAttachNo('');
  }
  async function createCase() {
    const v = await form.validateFields();
    await run('create', () => api('/api/cases', { method: 'POST', body: v }), '子案件已创建');
    setCreateOpen(false);
    form.resetFields();
  }
  async function claim(t: TaskRow) {
    await run(`claim-${t.id}`, () => api(`/api/handoffs/${t.id}/claim`, { method: 'POST' }), '已认领并接管会话');
    nav(`/reception/online?conv=${t.conversationId}`);
  }

  const overdue = (t: HandoffTask) => t.status === 'pending' && new Date(t.dueAt).getTime() < Date.now();
  const kpi = (label: string, value: number | string | undefined, danger = false) => (
    <Col xs={8} md={4} key={label}>
      <div className="kpi"><div className="label">{label}</div><div className="value" style={{ color: danger && Number(value) > 0 ? '#cf1322' : undefined }}>{value ?? '—'}</div></div>
    </Col>
  );
  const byStatus = (s: string) => caseStats?.byStatus.find((x) => x.status === s)?.n ?? 0;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>工单协作 · 子案件与人工接续任务</h2>
          <div className="desc">正式售后工单在 DMS；本平台只持有子案件、证据、接续任务与关联轨迹（CS-003 / CS-016）。接续任务按工作日历与优先级档位给出预计人工响应时窗。</div>
        </div>
        <Space>
          <Tag color={health?.ok ? 'green' : 'red'} icon={<ApiOutlined />}>DMS · {health?.kind === 'mock' ? `模拟 · ${MODE_LABEL[(health?.mode as DmsMockMode) ?? 'normal'] ?? health?.mode}` : health?.mode ?? '连接中…'}</Tag>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>新建子案件</Button>
        </Space>
      </div>
      <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
        {kpi('待接续任务', taskStats?.pending, true)}
        {kpi('超时接续', taskStats?.overdue, true)}
        {kpi('待人工子案件', byStatus('pending_human'))}
        {kpi('处理中', byStatus('in_progress'))}
        {kpi('已关联 DMS', byStatus('linked_dms'))}
        {kpi('待同步案件', caseStats?.dmsPending, true)}
      </Row>

      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          {
            key: 'handoffs',
            label: '接续任务',
            children: (
              <>
                <Space style={{ marginBottom: 10 }}>
                  <Select value={taskFilter} style={{ width: 140 }} onChange={setTaskFilter} options={[{ value: 'active', label: '待接续 / 接续中' }, { value: 'done', label: '已完成' }, { value: 'cancelled', label: '已取消' }]} />
                  <Typography.Text type="secondary">认领 = 接管会话（单一响应者）；同一会话同一时刻只有一个活动任务，重复触发只追加进度。</Typography.Text>
                </Space>
                <Table<TaskRow>
                  rowKey="id"
                  size="small"
                  loading={tasksLoading && !tasks}
                  dataSource={tasks ?? []}
                  pagination={{ pageSize: 10, size: 'small' }}
                  onRow={() => ({ 'data-testid': 'handoff-row' } as Record<string, string>)}
                  expandable={{
                    expandedRowRender: (t) => (
                      <div style={{ fontSize: 12, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                        <div><b>已完成阶段</b>：{t.progress.doneStages.join(' → ') || '—'}</div>
                        <div><b>证据</b>：{t.progress.evidence.join('、') || '—'}</div>
                        <div><b>缺项</b>：{t.progress.missing.join('、') || '无'}</div>
                        <div><b>下一步</b>：{t.progress.nextAction}</div>
                        {t.progress.failure && <div style={{ color: '#cf1322' }}><b>失败原因</b>：{t.progress.failure}</div>}
                        {t.progress.candidate && <div style={{ gridColumn: '1 / span 2', whiteSpace: 'pre-wrap', background: '#fafafa', padding: 8, borderRadius: 6 }}><b>候选话术（未发送）</b>：{t.progress.candidate}</div>}
                        <div style={{ gridColumn: '1 / span 2' }}><b>轨迹</b>：{t.history.map((h) => `${fmtTime(h.at)} ${h.by} ${h.action}`).join('；')}</div>
                      </div>
                    ),
                  }}
                  columns={[
                    { title: '任务号', dataIndex: 'id', width: 130, render: (v) => <span className="mono">{v}</span> },
                    { title: '优先级', dataIndex: 'priority', width: 70, render: (v) => <Tag color={prioColor[v]}>{v}</Tag> },
                    { title: '会话', key: 'conv', ellipsis: true, render: (_, t) => <span>{t.conversation?.title ?? t.conversationId} <Tag style={{ marginLeft: 4 }}>{t.channel}</Tag></span> },
                    { title: '原因', dataIndex: 'reason', ellipsis: true },
                    { title: '预计响应', key: 'window', width: 220, render: (_, t) => <span style={{ color: overdue(t) ? '#cf1322' : undefined }}>{t.windowText}<br /><span style={{ fontSize: 12, color: overdue(t) ? '#cf1322' : '#6b7280' }}>{fmtTime(t.dueAt)}{overdue(t) ? ' · 超时' : ''}</span></span> },
                    { title: '状态', dataIndex: 'status', width: 90, render: (v: HandoffTask['status']) => <Tag color={taskStatusMeta[v].color}>{taskStatusMeta[v].text}</Tag> },
                    { title: '认领人', dataIndex: 'claimedBy', width: 100, render: (v) => v ?? <Typography.Text type="secondary">—</Typography.Text> },
                    { title: '创建', dataIndex: 'createdAt', width: 150, render: fmtTime },
                    {
                      title: '操作',
                      key: 'ops',
                      width: 260,
                      render: (_, t) => (
                        <Space size={4} wrap>
                          {t.status === 'pending' && <Button size="small" type="primary" icon={<UserSwitchOutlined />} loading={busy === `claim-${t.id}`} onClick={() => claim(t)}>认领并接管</Button>}
                          {t.status === 'claimed' && <Button size="small" onClick={() => nav(`/reception/online?conv=${t.conversationId}`)}>打开会话</Button>}
                          {t.status === 'claimed' && <Button size="small" onClick={() => run(`done-${t.id}`, () => api(`/api/handoffs/${t.id}/done`, { method: 'POST', body: { note: '' } }), '接续已完成')}>完成</Button>}
                          {!t.caseId && ['pending', 'claimed'].includes(t.status) && <Button size="small" onClick={() => run(`split-${t.id}`, () => api(`/api/handoffs/${t.id}/case`, { method: 'POST' }), '已拆出子案件')}>拆为子案件</Button>}
                          {t.caseId && <Button size="small" type="link" onClick={() => api<SubCase>(`/api/cases/${t.caseId}`).then((c) => { setActive(c); setTab('cases'); })}>子案件 {t.caseId}</Button>}
                        </Space>
                      ),
                    },
                  ]}
                />
              </>
            ),
          },
          {
            key: 'cases',
            label: '子案件',
            children: (
              <>
                <Space style={{ marginBottom: 10 }}>
                  <Select allowClear placeholder="状态" style={{ width: 140 }} value={caseStatus} onChange={setCaseStatus} options={Object.entries(caseStatusMeta).map(([k, v]) => ({ value: k, label: v.text }))} />
                  <Select allowClear placeholder="优先级" style={{ width: 110 }} value={casePriority} onChange={setCasePriority} options={['P0', 'P1', 'P2'].map((v) => ({ value: v }))} />
                </Space>
                <Table<SubCase>
                  rowKey="id"
                  size="small"
                  loading={casesLoading && !cases}
                  dataSource={cases ?? []}
                  onRow={(c) => ({ onClick: () => setActive(c), style: { cursor: 'pointer' }, 'data-testid': 'case-row' } as Record<string, unknown>)}
                  pagination={{ pageSize: 12, size: 'small' }}
                  columns={[
                    { title: '子案件号', dataIndex: 'id', width: 170, render: (v) => <span className="mono">{v}</span> },
                    { title: '标题', dataIndex: 'title', ellipsis: true },
                    { title: '类型', dataIndex: 'type', width: 70 },
                    { title: '客户', dataIndex: 'customerName', width: 90 },
                    { title: '优先级', dataIndex: 'priority', width: 70, render: (v) => <Tag color={prioColor[v]}>{v}</Tag> },
                    { title: '状态', dataIndex: 'status', width: 110, render: (v: CaseStatus, c) => <Space size={2}><Tag color={caseStatusMeta[v].color}>{caseStatusMeta[v].text}</Tag>{c.dms.pending && <Tag color="orange">待同步</Tag>}</Space> },
                    { title: 'DMS 工单', key: 'dms', width: 200, render: (_, c) => (c.dms.ticketNo ? <span><span className="mono dms-no">{c.dms.ticketNo}</span> <Tag color={dmsStatusColor[c.dms.status ?? ''] ?? 'default'}>{c.dms.status}</Tag></span> : <Typography.Text type="secondary">未关联</Typography.Text>) },
                    { title: '处理人', dataIndex: 'assignee', width: 90, render: (v) => v ?? <Typography.Text type="secondary">未分配</Typography.Text> },
                    { title: '来源', dataIndex: 'source', width: 70, render: (v) => ({ manual: '手工', agent: '坐席', chain: '执行链' } as Record<string, string>)[v] },
                    { title: '创建', dataIndex: 'createdAt', width: 150, render: fmtTime },
                  ]}
                />
              </>
            ),
          },
          ...(isAdmin
            ? [{
                key: 'dms',
                label: 'DMS 模拟',
                children: (
                  <>
                    <Alert type="info" showIcon style={{ marginBottom: 12 }} message="模拟适配器与真实 DMS 使用同一契约（建单 / 查询 / 失败语义）；接口授权可得后替换实现，业务代码不变。" />
                    <Space wrap style={{ marginBottom: 12 }}>
                      <span>当前模式</span>
                      <Select value={mock?.mode ?? 'normal'} style={{ width: 220 }} onChange={(m: DmsMockMode) => run('simulate', () => api('/api/dms/simulate', { method: 'POST', body: { mode: m } }), `DMS 模拟模式：${MODE_LABEL[m]}`)} options={(Object.keys(MODE_LABEL) as DmsMockMode[]).map((m) => ({ value: m, label: MODE_LABEL[m] }))} />
                      <Button icon={<ReloadOutlined />} loading={busy === 'retry'} onClick={() => run('retry', async () => { const r = await api<{ retried: number; linked: number; stillPending: number }>('/api/dms/retry-pending', { method: 'POST' }); message.info(`重试 ${r.retried} 条，关联成功 ${r.linked}，仍待同步 ${r.stillPending}`); })}>重试待同步</Button>
                    </Space>
                    <Table
                      rowKey="ticketNo"
                      size="small"
                      dataSource={mock?.tickets ?? []}
                      pagination={{ pageSize: 10, size: 'small' }}
                      columns={[
                        { title: 'DMS 工单号', dataIndex: 'ticketNo', render: (v) => <span className="mono">{v}</span> },
                        { title: '子案件', dataIndex: 'caseId', render: (v) => <span className="mono">{v}</span> },
                        { title: '状态', dataIndex: 'status', render: (v) => <Tag color={dmsStatusColor[v] ?? 'default'}>{v}</Tag> },
                        { title: '更新', dataIndex: 'updatedAt', render: fmtTime },
                        { title: '操作', key: 'ops', render: (_, r) => <Button size="small" disabled={r.status === 'closed'} onClick={() => run(`adv-${r.ticketNo}`, () => api(`/api/dms/mock/${r.ticketNo}/advance`, { method: 'POST' }), '已推进状态')}>推进状态</Button> },
                      ]}
                    />
                  </>
                ),
              }]
            : []),
        ]}
      />

      <Drawer open={!!active} onClose={() => setActive(null)} width={600} title={active ? <span><span className="mono">{active.id}</span> · {active.title}</span> : ''}>
        {active && (
          <>
            <Space wrap style={{ marginBottom: 12 }}>
              <Tag color={prioColor[active.priority]}>{active.priority}</Tag>
              <Tag color={caseStatusMeta[active.status].color}>{caseStatusMeta[active.status].text}</Tag>
              {active.dms.pending && <Tag color="orange">待同步案件</Tag>}
              <Tag>{active.type}</Tag>
              <Tag>客户 {active.customerName}</Tag>
              {active.conversationId && <Button size="small" type="link" onClick={() => nav(`/reception/online?conv=${active.conversationId}`)}>打开会话 {active.conversationId}</Button>}
            </Space>
            <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', background: '#fafafa', padding: 10, borderRadius: 6 }}>{active.description || '（无描述）'}</Typography.Paragraph>

            <Collapse
              size="small"
              style={{ marginBottom: 12 }}
              items={[{
                key: 'ev',
                label: `证据包 · 槽位 ${Object.keys(active.evidence.slots).length} · 事实 ${active.evidence.facts.length} · 轨迹 ${active.evidence.traceIds.length}`,
                children: (
                  <div style={{ fontSize: 12 }}>
                    <div><b>槽位</b>：{Object.entries(active.evidence.slots).map(([k, v]) => `${k}=${v}`).join('，') || '—'}</div>
                    <div><b>事实</b>：{active.evidence.facts.map((f) => `${f.tool}：${f.summary}`).join('；') || '—'}</div>
                    <div><b>轨迹</b>：{active.evidence.traceIds.join('、') || '—'}</div>
                    {active.evidence.candidateReply && <div style={{ whiteSpace: 'pre-wrap', marginTop: 6 }}><b>候选话术</b>：{active.evidence.candidateReply}</div>}
                  </div>
                ),
              }]}
            />

            <div style={{ border: '1px solid #e5e7eb', borderRadius: 6, padding: 10, marginBottom: 12 }}>
              <Typography.Text strong><LinkOutlined /> DMS 正式工单</Typography.Text>
              {active.dms.ticketNo ? (
                <div style={{ marginTop: 6 }}>
                  <Space wrap>
                    <span className="mono dms-no">{active.dms.ticketNo}</span>
                    <Tag color={dmsStatusColor[active.dms.status ?? ''] ?? 'default'}>{active.dms.status}</Tag>
                    <Typography.Text type="secondary">回读 {fmtTime(active.dms.syncedAt)}</Typography.Text>
                    <Button size="small" icon={<ReloadOutlined />} loading={busy === 'dms-refresh'} onClick={() => dmsAction(active.id, 'refresh')}>刷新状态</Button>
                  </Space>
                </div>
              ) : (
                <div style={{ marginTop: 6 }}>
                  <Space wrap>
                    <Tooltip title="调用 DMS 建单接口（当前为模拟适配器），成功后本地状态变为「已关联 DMS」；DMS 不可用时转为待同步案件">
                      <Button size="small" type="primary" loading={busy === 'dms-link'} onClick={() => dmsAction(active.id, 'link')}>关联 DMS（自动建单）</Button>
                    </Tooltip>
                    <Input size="small" style={{ width: 200 }} placeholder="回填 DMS 工单号" value={attachNo} onChange={(e) => setAttachNo(e.target.value)} />
                    <Button size="small" disabled={!attachNo.trim()} loading={busy === 'dms-attach'} onClick={() => dmsAction(active.id, 'attach', { ticketNo: attachNo.trim() })}>回填关联</Button>
                  </Space>
                  {active.dms.lastError && <div style={{ marginTop: 6, fontSize: 12, color: active.dms.pending ? '#d46b08' : '#cf1322' }}>{active.dms.pending ? '待同步：' : '上次失败：'}{active.dms.lastError}</div>}
                </div>
              )}
            </div>

            <Space wrap style={{ marginBottom: 12 }}>
              <Select value={active.assignee ?? undefined} placeholder="转派处理人" style={{ width: 150 }} onChange={(v) => patchCase(active.id, { assignee: v })} options={ASSIGNEES.map((a) => ({ value: a }))} />
              <Select value={active.priority} style={{ width: 90 }} onChange={(v) => patchCase(active.id, { priority: v })} options={['P0', 'P1', 'P2'].map((v) => ({ value: v }))} />
            </Space>
            <Input.TextArea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="处理备注（随状态变更一起记录）" style={{ marginBottom: 8 }} />
            <Space wrap>
              {active.status === 'pending_human' && <Button type="primary" onClick={() => patchCase(active.id, { status: 'in_progress' })}>开始处理</Button>}
              {active.status !== 'archived' && <Button onClick={() => patchCase(active.id, { status: 'archived' })}>归档</Button>}
              {active.status === 'archived' && <Button onClick={() => patchCase(active.id, { status: 'pending_human' })}>重新打开</Button>}
              <Button onClick={() => patchCase(active.id, {})} disabled={!note.trim()}>仅添加备注</Button>
            </Space>
            <Typography.Title level={5} style={{ marginTop: 18 }}>轨迹</Typography.Title>
            <Timeline items={active.history.map((h) => ({ children: <div><div style={{ fontSize: 12, color: '#6b7280' }}>{fmtTime(h.at)} · {h.by}</div><div>{h.action}</div>{h.note && <div style={{ color: '#4b5563' }}>备注：{h.note}</div>}</div> }))} />
          </>
        )}
      </Drawer>

      <Modal open={createOpen} onCancel={() => setCreateOpen(false)} onOk={createCase} title="新建子案件" okText="创建" confirmLoading={busy === 'create'}>
        <Form form={form} layout="vertical" initialValues={{ type: '其他', priority: 'P2' }}>
          <Form.Item name="title" label="标题" rules={[{ required: true, message: '请输入标题' }]}><Input /></Form.Item>
          <Space>
            <Form.Item name="type" label="类型"><Select style={{ width: 140 }} options={['物流', '发票', '退款', '投诉', '售前', '其他'].map((v) => ({ value: v }))} /></Form.Item>
            <Form.Item name="priority" label="优先级"><Select style={{ width: 120 }} options={['P0', 'P1', 'P2'].map((v) => ({ value: v }))} /></Form.Item>
            <Form.Item name="assignee" label="处理人"><Select allowClear style={{ width: 150 }} options={ASSIGNEES.map((a) => ({ value: a }))} /></Form.Item>
          </Space>
          <Form.Item name="conversationId" label="关联会话 ID（可选）"><Input placeholder="conv-xxx" /></Form.Item>
          <Form.Item name="description" label="描述"><Input.TextArea rows={4} /></Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
