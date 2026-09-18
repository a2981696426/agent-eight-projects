import { useState } from 'react';
import { Alert, App, Button, Card, Col, Form, Input, Modal, Progress, Row, Space, Table, Tag } from 'antd';
import { PlayCircleOutlined, PlusOutlined } from '@ant-design/icons';
import type { OutboundCampaign } from '@eight/shared';
import { api, fmtTime, useApi } from '../../api';

const RESULT: Record<string, { text: string; color: string }> = { connected_interested: { text: '接通·有意向', color: 'green' }, connected_neutral: { text: '接通·中立', color: 'blue' }, connected_refused: { text: '接通·拒绝', color: 'orange' }, no_answer: { text: '未接听', color: 'default' }, busy: { text: '忙线', color: 'default' } };

export default function Outbound() {
  const { message } = App.useApp();
  const { data: list, reload } = useApi<OutboundCampaign[]>('/api/outbound/campaigns');
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm();
  const [busy, setBusy] = useState<string | null>(null);
  const [active, setActive] = useState<OutboundCampaign | null>(null);

  async function create() {
    const v = await form.validateFields();
    const contacts = String(v.contacts).split('\n').map((l: string) => l.trim()).filter(Boolean).map((l: string) => { const [name, phone] = l.split(/[,，\s]+/); return { name, phone: phone ?? '' }; });
    await api('/api/outbound/campaigns', { method: 'POST', body: { name: v.name, goal: v.goal, script: v.script, contacts } });
    setOpen(false);
    form.resetFields();
    await reload();
    message.success('外呼任务已创建');
  }
  async function run(id: string) {
    setBusy(id);
    try {
      const c = await api<OutboundCampaign>(`/api/outbound/campaigns/${id}/run`, { method: 'POST' });
      setActive(c);
      await reload();
      message.success(`模拟外呼完成：接通 ${c.stats.connected}/${c.stats.total}`);
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
          <h2>AI 外呼 · 主动服务任务</h2>
          <div className="desc">面向存量用户的主动触达（到期提醒、满意度回访、复购关怀）。任务 = 目标 + 话术 + 名单；当前为大模型驱动的「模拟外呼」演示流程与结果沉淀，未接入真实线路。</div>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>新建任务</Button>
      </div>
      <Alert type="info" showIcon style={{ marginBottom: 12 }} message="模拟模式" description="每位联系人的通话结果与小结由大模型按话术模拟生成，用于验证任务编排、结果回写与统计口径；接入云呼叫中心后替换为真实通话结果。" />
      <Row gutter={12}>
        <Col xs={24} lg={14}>
          <Table<OutboundCampaign> size="small" rowKey="id" dataSource={list ?? []} pagination={false} onRow={(c) => ({ onClick: () => setActive(c), style: { cursor: 'pointer' } })} columns={[
            { title: '任务', dataIndex: 'name' },
            { title: '目标', dataIndex: 'goal', ellipsis: true },
            { title: '名单', width: 70, render: (_v, c) => c.contacts.length },
            { title: '接通率', width: 140, render: (_v, c) => <Progress size="small" percent={c.stats.total ? Math.round((c.stats.connected / c.stats.total) * 100) : 0} /> },
            { title: '状态', dataIndex: 'status', width: 90, render: (v) => <Tag color={v === 'finished' ? 'green' : v === 'running' ? 'processing' : 'default'}>{{ draft: '草稿', running: '进行中', finished: '已完成' }[v as string]}</Tag> },
            { title: '创建', dataIndex: 'createdAt', width: 160, render: fmtTime },
            { title: '', width: 110, render: (_v, c) => <Button size="small" type="primary" icon={<PlayCircleOutlined />} loading={busy === c.id} onClick={(e) => { e.stopPropagation(); run(c.id); }}>{c.status === 'finished' ? '重跑' : '开始外呼'}</Button> },
          ]} />
        </Col>
        <Col xs={24} lg={10}>
          <Card size="small" title={active ? `任务详情 · ${active.name}` : '任务详情'}>
            {active ? (
              <>
                <div style={{ fontSize: 13, marginBottom: 8 }}><b>目标：</b>{active.goal}</div>
                <div style={{ fontSize: 13, background: '#fafafa', padding: 8, borderRadius: 6, marginBottom: 10 }}><b>话术：</b>{active.script}</div>
                <Space style={{ marginBottom: 8 }}><Tag>总计 {active.stats.total}</Tag><Tag color="blue">接通 {active.stats.connected}</Tag><Tag color="green">有意向 {active.stats.interested}</Tag><Tag color="orange">拒绝 {active.stats.refused}</Tag></Space>
                <Table size="small" rowKey="phone" dataSource={active.contacts} pagination={false} columns={[
                  { title: '联系人', dataIndex: 'name', width: 80 },
                  { title: '电话', dataIndex: 'phone', width: 120, render: (v) => <span className="mono">{v}</span> },
                  { title: '结果', dataIndex: 'result', width: 110, render: (v) => v ? <Tag color={RESULT[v]?.color}>{RESULT[v]?.text ?? v}</Tag> : <Tag>待呼</Tag> },
                  { title: '小结', dataIndex: 'summary', ellipsis: true },
                ]} />
              </>
            ) : '选择左侧任务查看'}
          </Card>
        </Col>
      </Row>
      <Modal open={open} onCancel={() => setOpen(false)} onOk={create} title="新建外呼任务" okText="创建">
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="任务名称" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="goal" label="外呼目标" rules={[{ required: true }]}><Input placeholder="例：传感器到期提醒并收集使用反馈" /></Form.Item>
          <Form.Item name="script" label="开场话术" rules={[{ required: true }]}><Input.TextArea rows={3} /></Form.Item>
          <Form.Item name="contacts" label="名单（每行：姓名,手机）" rules={[{ required: true }]}><Input.TextArea rows={4} placeholder={'张伟,13812340001\n李娜,13912340002'} /></Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
