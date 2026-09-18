import { useEffect, useState } from 'react';
import { App, Button, Card, Col, Input, Row, Select, Space, Steps, Table, Tag, Typography } from 'antd';
import { PhoneOutlined, SaveOutlined } from '@ant-design/icons';
import type { IvrFlow, IvrNode } from '@eight/shared';
import { api, useApi } from '../../api';

const TYPE_LABEL: Record<IvrNode['type'], string> = { play: '播报', menu: '按键菜单', collect: '收集信息', transfer: '转人工', end: '结束' };

export default function InboundRobot() {
  const { message } = App.useApp();
  const { data: flows, reload } = useApi<IvrFlow[]>('/api/ivr/flows');
  const [flow, setFlow] = useState<IvrFlow | null>(null);
  const [inputs, setInputs] = useState('1,20260918000123#');
  const [customerId, setCustomerId] = useState<string | null>('cust-001');
  const [sim, setSim] = useState<{ flow: string; slots: Record<string, string>; log: { node: string; type: string; say: string; input?: string; chainTraceId?: string }[]; remainingInputs: string[] } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (flows?.length && !flow) setFlow(structuredClone(flows[0]));
  }, [flows, flow]);

  function updateNode(id: string, patch: Partial<IvrNode>) {
    setFlow((f) => f && { ...f, nodes: f.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) });
  }
  async function save() {
    if (!flow) return;
    await api(`/api/ivr/flows/${flow.id}`, { method: 'PUT', body: { name: flow.name, status: flow.status, entry: flow.entry, nodes: flow.nodes } });
    message.success('流程已保存');
    await reload();
  }
  async function simulate() {
    if (!flow) return;
    setBusy(true);
    try {
      await save();
      setSim(await api(`/api/ivr/flows/${flow.id}/simulate`, { method: 'POST', body: { inputs: inputs.split(',').map((s) => s.trim()).filter(Boolean), customerId } }));
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
          <h2>呼入机器人 · IVR 流程与执行链接入</h2>
          <div className="desc">语音渠道复用同一条执行链：IVR 收集订单号等槽位后，把「菜单意图 + 槽位」交给执行链完成证据获取、推理与分级。当前以文本模拟来电（未接入线路/ASR，见「呼叫中心·暂缓」）。</div>
        </div>
        <Space>
          {flow && <Select value={flow.status} onChange={(v) => setFlow({ ...flow, status: v })} options={[{ value: 'draft', label: '草稿' }, { value: 'published', label: '已发布' }]} style={{ width: 110 }} />}
          <Button icon={<SaveOutlined />} onClick={save} disabled={!flow}>保存流程</Button>
        </Space>
      </div>
      <Row gutter={12}>
        <Col xs={24} lg={14}>
          <Card size="small" title={<Space>流程节点 {flow && <Tag>{flow.name}</Tag>}<Tag>入口 {flow?.entry}</Tag></Space>}>
            {flow && (
              <Table<IvrNode>
                size="small"
                rowKey="id"
                dataSource={flow.nodes}
                pagination={false}
                columns={[
                  { title: '节点', dataIndex: 'id', width: 120, render: (v) => <span className="mono">{v}</span> },
                  { title: '类型', dataIndex: 'type', width: 100, render: (v: IvrNode['type']) => <Tag>{TYPE_LABEL[v]}</Tag> },
                  { title: '播报文本', dataIndex: 'text', render: (v, n) => <Input.TextArea autoSize value={v} onChange={(e) => updateNode(n.id, { text: e.target.value })} /> },
                  { title: '跳转', width: 200, render: (_v, n) => n.type === 'menu' ? <div style={{ fontSize: 12 }}>{n.options?.map((o) => <div key={o.key}>按 {o.key} → {o.label} → <span className="mono">{o.next}</span></div>)}</div> : n.next ? <span className="mono">→ {n.next}</span> : '—' },
                  { title: '槽位', dataIndex: 'slot', width: 90, render: (v) => v ? <Tag color="blue">{v}</Tag> : '—' },
                ]}
              />
            )}
          </Card>
        </Col>
        <Col xs={24} lg={10}>
          <Card size="small" title="模拟来电（文本代替按键/语音）">
            <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>输入序列用逗号分隔：菜单按键、订单号（# 结束）。示例 <code>1,20260918000123#</code> 表示选物流并输入订单号；<code>0</code> 表示直接转人工。</Typography.Paragraph>
            <Select value={customerId} onChange={setCustomerId} allowClear placeholder="来电客户（匿名）" style={{ width: '100%', marginBottom: 8 }} options={[['cust-001', '张伟 13812340001'], ['cust-003', '王芳 13712340003'], ['cust-004', '刘洋 13612340004']].map(([v, l]) => ({ value: v, label: l }))} />
            <Space.Compact style={{ width: '100%' }}>
              <Input value={inputs} onChange={(e) => setInputs(e.target.value)} onPressEnter={simulate} />
              <Button type="primary" icon={<PhoneOutlined />} loading={busy} onClick={simulate}>模拟来电</Button>
            </Space.Compact>
            {sim && (
              <div style={{ marginTop: 12 }}>
                <Steps
                  direction="vertical"
                  size="small"
                  current={sim.log.length}
                  items={sim.log.map((l) => ({
                    title: <span><Tag>{TYPE_LABEL[l.type as IvrNode['type']]}</Tag><span className="mono">{l.node}</span>{l.input !== undefined && <Tag color="blue" style={{ marginLeft: 6 }}>输入 {l.input}</Tag>}</span>,
                    description: <div style={{ whiteSpace: 'pre-wrap', fontSize: 13 }}>{l.say}{l.chainTraceId && <div className="mono" style={{ color: '#9ca3af' }}>执行链 {l.chainTraceId}</div>}</div>,
                  }))}
                />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>收集到的槽位：{JSON.stringify(sim.slots)}</Typography.Text>
              </div>
            )}
          </Card>
        </Col>
      </Row>
    </div>
  );
}
