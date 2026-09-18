import { useState } from 'react';
import { App, Button, Card, Col, Input, Row, Select, Space, Table, Tag, Typography } from 'antd';
import { CarOutlined, FileTextOutlined, MoneyCollectOutlined, PlayCircleOutlined } from '@ant-design/icons';
import type { ScenarioPack, Trace } from '@eight/shared';
import { api, fmtTime, useApi } from '../../api';
import TraceViewer, { DecisionTag, RiskTag } from '../../components/TraceViewer';

type Employee = ScenarioPack & { stats: { total: number; auto: number; humanConfirm: number; escalate: number } };
const ICON: Record<string, React.ReactNode> = { logistics: <CarOutlined />, invoice: <FileTextOutlined />, refund_price_diff: <MoneyCollectOutlined /> };
const SAMPLE: Record<string, string> = { logistics: '订单 20260918000123 的快递三天没动了', invoice: '20260917000789 的专票开了吗，财务催了', refund_price_diff: '20260910000321 刚买就降价了，能退差价吗' };
const CUSTOMER: Record<string, string> = { logistics: 'cust-001', invoice: 'cust-003', refund_price_diff: 'cust-004' };

export default function DigitalEmployees() {
  const { message } = App.useApp();
  const { data: list, reload } = useApi<Employee[]>('/api/employees');
  const [active, setActive] = useState<string>('logistics');
  const { data: runs, reload: reloadRuns } = useApi<{ id: string; trace_id: string; created_at: string; decision: string; risk_level: string; summary: string; conversation_id: string }[]>(`/api/employees/${active}/runs`);
  const [text, setText] = useState(SAMPLE.logistics);
  const [customerId, setCustomerId] = useState<string | null>(CUSTOMER.logistics);
  const [trace, setTrace] = useState<Trace | null>(null);
  const [busy, setBusy] = useState(false);
  const emp = list?.find((e) => e.id === active);

  function pick(id: string) {
    setActive(id);
    setText(SAMPLE[id]);
    setCustomerId(CUSTOMER[id]);
    setTrace(null);
  }
  async function run() {
    setBusy(true);
    try {
      const r = await api<{ trace: Trace; matchedEmployee: boolean }>(`/api/employees/${active}/run`, { method: 'POST', body: { text, customerId } });
      setTrace(r.trace);
      if (!r.matchedEmployee) message.warning(`执行链把该问题识别为 ${r.trace.scenario}，不是当前员工负责的场景`);
      await Promise.all([reload(), reloadRuns()]);
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
          <h2>售后服务数字员工</h2>
          <div className="desc">物流 / 发票 / 退款差价三个智能体 = 三个场景包：各自声明必填槽位、可用业务工具、知识标签、允许自动执行的动作与自治风险上限；由同一条执行链按意图路由调度，运行轨迹统一沉淀。</div>
        </div>
      </div>
      <Row gutter={[12, 12]}>
        {list?.map((e) => (
          <Col key={e.id} xs={24} md={8}>
            <Card size="small" hoverable onClick={() => pick(e.id)} style={{ borderColor: e.id === active ? '#1f6feb' : undefined }} title={<Space>{ICON[e.id]}{e.name}<Tag>上限 {e.maxAutoRisk}</Tag></Space>}>
              <div style={{ color: '#6b7280', fontSize: 12, minHeight: 36 }}>{e.description}</div>
              <div style={{ fontSize: 12, marginTop: 6 }}>
                <div>必填：{e.requiredSlots.map((s) => <Tag key={s.key}>{s.label}</Tag>)}{!e.requiredSlots.length && '无'}</div>
                <div>工具：{e.tools.map((t) => <Tag key={t} color="blue">{t}</Tag>)}</div>
                <div>自动动作：{e.allowedAutoActions.map((a) => <Tag key={a} color="green">{a}</Tag>)}</div>
              </div>
              <Space style={{ marginTop: 8 }} wrap size={4}>
                <Tag>运行 {e.stats.total}</Tag><Tag color="green">自主 {e.stats.auto}</Tag><Tag color="orange">人工确认 {e.stats.humanConfirm}</Tag><Tag color="red">升级 {e.stats.escalate}</Tag>
              </Space>
            </Card>
          </Col>
        ))}
      </Row>
      <Row gutter={12} style={{ marginTop: 12 }}>
        <Col xs={24} lg={9}>
          <Card size="small" title={`试跑 · ${emp?.name ?? ''}`}>
            <Select value={customerId} onChange={setCustomerId} allowClear placeholder="匿名访客" style={{ width: '100%', marginBottom: 8 }} options={[['cust-001', '张伟 · vip'], ['cust-002', '李娜'], ['cust-003', '王芳 · svip'], ['cust-004', '刘洋'], ['cust-005', '陈静'], ['cust-006', '赵敏 · vip']].map(([v, l]) => ({ value: v, label: l }))} />
            <Input.TextArea rows={3} value={text} onChange={(e) => setText(e.target.value)} />
            <Space wrap size={4} style={{ marginTop: 6 }}>{emp?.examples.map((x) => <Tag key={x} style={{ cursor: 'pointer' }} onClick={() => setText(x)}>{x}</Tag>)}</Space>
            <Button type="primary" icon={<PlayCircleOutlined />} block loading={busy} onClick={run} style={{ marginTop: 8 }}>运行（沙箱）</Button>
          </Card>
          <Card size="small" title="运行记录" style={{ marginTop: 12 }}>
            <Table size="small" rowKey="id" dataSource={runs ?? []} pagination={{ pageSize: 6, size: 'small' }} onRow={(r) => ({ onClick: () => api<Trace>(`/api/traces/${r.trace_id}`).then(setTrace), style: { cursor: 'pointer' } })} columns={[
              { title: '时间', dataIndex: 'created_at', width: 130, render: fmtTime },
              { title: '决策', dataIndex: 'decision', width: 100, render: (v) => <DecisionTag decision={v} /> },
              { title: '风险', dataIndex: 'risk_level', width: 80, render: (v) => <RiskTag level={v} /> },
              { title: '摘要', dataIndex: 'summary', ellipsis: true },
            ]} />
          </Card>
        </Col>
        <Col xs={24} lg={15}>
          <Card size="small" title="轨迹">
            <div style={{ maxHeight: 700, overflow: 'auto' }}>{trace ? <TraceViewer trace={trace} /> : <Typography.Text type="secondary">运行后显示九阶段轨迹，或点击运行记录回看</Typography.Text>}</div>
          </Card>
        </Col>
      </Row>
    </div>
  );
}
