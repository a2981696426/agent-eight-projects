import { useEffect, useState } from 'react';
import { Alert, App, Button, Card, Col, Form, Input, InputNumber, Progress, Row, Select, Slider, Space, Switch, Table, Tabs, Tag, Typography } from 'antd';
import { ExperimentOutlined, RocketOutlined, SaveOutlined, UndoOutlined } from '@ant-design/icons';
import type { AgentConfig, ScenarioPack, Trace } from '@eight/shared';
import { api, fmtTime, pct, useApi } from '../../api';
import TraceViewer, { DecisionTag, RiskTag } from '../../components/TraceViewer';
import WhitelistPanel from '../../components/WhitelistPanel';
import { useAuth } from '../../auth';

interface Meta {
  scenarios: ScenarioPack[];
  tools: { name: string; label: string; description: string; requires: string[]; mutating?: boolean }[];
  models: { id: string; label: string }[];
}
interface LlmStatus {
  configured: boolean;
  providers: { id: string; configured: boolean; models: { fast: string; reasoning: string; baseUrl: string } | null; circuit: 'closed' | 'open' | 'half_open'; consecutiveFailures: number; openedAt: string | null; stats: { calls: number; failures: number; avgMs: number; lastError: string | null; lastSuccessAt: string | null }; simulatedDown: boolean }[];
  events: { at: string; type: string; provider: string; detail: string }[];
  stats: { degradedTraces: number; failedOverTraces: number; traces: number; avgChainMs: number; avgChainMsRecent20: number };
}
interface BenchRun {
  id: string;
  agentVersion: number;
  createdAt: string;
  total: number;
  scenarioAccuracy: number;
  decisionAccuracy: number;
  medicalBoundaryTotal?: number;
  medicalBoundaryPass?: number | null;
  releaseGate?: boolean | null;
  usage: { promptTokens: number; completionTokens: number; calls: number };
  rows: { caseId: string; category?: string; text: string; expectedScenario: string; actualScenario: string; scenarioOk: boolean; expectedDecision: string; actualDecision: string; decisionOk: boolean; guardOk?: boolean | null; risk: string; traceId: string; durationMs: number; note: string }[];
}

const AGENT_ID = 'agent-cs-main';

export default function AgentStudio() {
  const { message } = App.useApp();
  const { can } = useAuth();
  const isAdmin = can(['admin']);
  const { data: meta } = useApi<Meta>('/api/agents/meta');
  const { data: agentData, reload } = useApi<{ agent: AgentConfig; versions: { version: number; published_at: string; note: string }[] }>(`/api/agents/${AGENT_ID}`);
  const [form] = Form.useForm();
  const [testText, setTestText] = useState('20260910000321 刚买就降价了能退差价吗');
  const [testCustomer, setTestCustomer] = useState<string | null>('cust-004');
  const [testTrace, setTestTrace] = useState<Trace | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const { data: bench, reload: reloadBench } = useApi<{ cases: { id: string; text: string; expected_scenario: string; expected_decision: string; note: string }[]; runs: BenchRun[] }>(`/api/agents/${AGENT_ID}/benchmarks`);
  const [lastRun, setLastRun] = useState<BenchRun | null>(null);
  const { data: llmStatus, reload: reloadLlm } = useApi<LlmStatus>('/api/llm/status', { pollMs: 8000 });
  async function simulate(mode: 'normal' | 'primary_down' | 'all_down') {
    await api('/api/llm/simulate', { method: 'POST', body: { mode } });
    await reloadLlm();
    message.success({ normal: '已恢复正常', primary_down: '已模拟主模型故障：请求将切换到备用 provider（若无备用则进入规则降级）', all_down: '已模拟全部模型故障：执行链进入规则降级并转人工' }[mode]);
  }

  useEffect(() => {
    if (agentData) form.setFieldsValue({ ...agentData.agent, handoffKeywords: agentData.agent.handoffRules.keywords.join(','), maxBotTurns: agentData.agent.handoffRules.maxBotTurns });
  }, [agentData, form]);

  function collect(): Omit<AgentConfig, 'id' | 'version' | 'status' | 'updatedAt'> {
    const v = form.getFieldsValue(true);
    return {
      name: v.name,
      description: v.description ?? '',
      models: v.models,
      persona: v.persona,
      scenarios: v.scenarios,
      whitelistScenarios: (v.whitelistScenarios ?? []).filter((s: string) => v.scenarios.includes(s)),
      maxAutoRisk: v.maxAutoRisk,
      retrieval: v.retrieval,
      handoffRules: { keywords: String(v.handoffKeywords ?? '').split(/[,，\s]+/).filter(Boolean), maxBotTurns: Number(v.maxBotTurns ?? 6) },
      tools: v.tools,
    };
  }
  async function saveDraft() {
    await form.validateFields();
    setBusy('save');
    try {
      await api(`/api/agents/${AGENT_ID}`, { method: 'PUT', body: collect() });
      message.success('已保存草稿（未发布，测试台使用草稿配置）');
      await reload();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  async function publish() {
    await saveDraft();
    setBusy('publish');
    try {
      const a = await api<AgentConfig>(`/api/agents/${AGENT_ID}/publish`, { method: 'POST', body: { note: '来自 Agent Studio 发布' } });
      message.success(`已发布 v${a.version}，机器人接待立即生效`);
      await reload();
    } finally {
      setBusy(null);
    }
  }
  async function rollback(version: number) {
    await api(`/api/agents/${AGENT_ID}/rollback`, { method: 'POST', body: { version } });
    message.success(`已回滚到 v${version} 的配置（生成新版本）`);
    await reload();
  }
  async function runTest() {
    setBusy('test');
    try {
      await api(`/api/agents/${AGENT_ID}`, { method: 'PUT', body: collect() });
      setTestTrace(await api<Trace>(`/api/agents/${AGENT_ID}/test`, { method: 'POST', body: { text: testText, customerId: testCustomer } }));
      await reload();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  async function runBench() {
    setBusy('bench');
    try {
      const r = await api<BenchRun>(`/api/agents/${AGENT_ID}/benchmarks`, { method: 'POST', body: { limit: 10 } });
      setLastRun(r);
      await reloadBench();
      message.success(`评测完成：场景准确率 ${pct(r.scenarioAccuracy)}，决策准确率 ${pct(r.decisionAccuracy)}`);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  const agent = agentData?.agent;
  const scenarios = Form.useWatch('scenarios', form) as string[] | undefined;
  const run = lastRun ?? bench?.runs[0] ?? null;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>Agent Studio · 企业级 Agent 配置、评测与发布</h2>
          <div className="desc">一个 Agent = 人设 + 场景包 + 工具范围 + 大小模型路由 + 检索策略 + 自治白名单/风险上限 + 转人工规则。草稿可在测试台试跑，发布形成不可变版本，可随时回滚。</div>
        </div>
        {agent && (
          <Space>
            <Tag color={agent.status === 'published' ? 'green' : 'orange'}>{agent.status === 'published' ? `已发布 v${agent.version}` : `草稿（基于 v${agent.version}）`}</Tag>
            {isAdmin ? (
              <>
                <Button icon={<SaveOutlined />} loading={busy === 'save'} onClick={saveDraft}>保存草稿</Button>
                <Button type="primary" icon={<RocketOutlined />} loading={busy === 'publish'} onClick={publish}>发布新版本</Button>
              </>
            ) : (
              <Tag>只读：配置发布需管理员</Tag>
            )}
          </Space>
        )}
      </div>
      <Tabs
        items={[
          {
            key: 'config',
            label: '配置',
            children: (
              <Form form={form} layout="vertical">
                <Row gutter={16}>
                  <Col xs={24} lg={12}>
                    <Card size="small" title="基本信息与人设" style={{ marginBottom: 12 }}>
                      <Form.Item name="name" label="名称" rules={[{ required: true }]}><Input /></Form.Item>
                      <Form.Item name="description" label="职责说明"><Input.TextArea rows={2} /></Form.Item>
                      <Form.Item name="persona" label="人设 / 系统提示词（推理阶段）" rules={[{ required: true }]}><Input.TextArea rows={4} /></Form.Item>
                    </Card>
                    <Card size="small" title="大小模型协同（兼容 OpenAI 协议）" style={{ marginBottom: 12 }}>
                      <Space wrap>
                        <Form.Item name={['models', 'fast']} label="快模型（意图/抽取/改写，thinking 关闭）"><Select style={{ width: 240 }} options={meta?.models.map((m) => ({ value: m.id, label: m.label }))} /></Form.Item>
                        <Form.Item name={['models', 'reasoning']} label="推理模型（根因/话术，thinking 开启）"><Select style={{ width: 240 }} options={meta?.models.map((m) => ({ value: m.id, label: m.label }))} /></Form.Item>
                        <Form.Item name={['models', 'reasoningEffort']} label="推理强度"><Select style={{ width: 120 }} options={['low', 'medium', 'high'].map((v) => ({ value: v }))} /></Form.Item>
                      </Space>
                    </Card>
                    <Card size="small" title="检索策略">
                      <Space wrap align="start">
                        <Form.Item name={['retrieval', 'topK']} label="Top-K"><InputNumber min={1} max={20} /></Form.Item>
                        <Form.Item name={['retrieval', 'minScore']} label="最低命中分（低于则改写重检 / 售前不作答）" style={{ width: 300 }}><Slider min={0} max={1} step={0.01} /></Form.Item>
                        <Form.Item name={['retrieval', 'rewriteOnMiss']} label="弱命中时改写查询" valuePropName="checked"><Switch /></Form.Item>
                      </Space>
                    </Card>
                  </Col>
                  <Col xs={24} lg={12}>
                    <Card size="small" title="场景包（数字员工）与自治策略" style={{ marginBottom: 12 }}>
                      <Form.Item name="scenarios" label="启用的场景包" rules={[{ required: true }]}>
                        <Select mode="multiple" options={meta?.scenarios.map((s) => ({ value: s.id, label: `${s.name}（${s.id}）` }))} />
                      </Form.Item>
                      <Form.Item name="whitelistScenarios" label="允许自主回复的白名单场景（其余一律人工确认）">
                        <Select mode="multiple" options={meta?.scenarios.filter((s) => !scenarios || scenarios.includes(s.id)).map((s) => ({ value: s.id, label: `${s.name} · 场景上限 ${s.maxAutoRisk} · 自动动作 ${s.allowedAutoActions.join('/')}` }))} />
                      </Form.Item>
                      <Space wrap>
                        <Form.Item name="maxAutoRisk" label="自主回复风险上限"><Select style={{ width: 140 }} options={['L0', 'L1', 'L2'].map((v) => ({ value: v, label: `${v}${v === 'L2' ? '（不建议）' : ''}` }))} /></Form.Item>
                        <Form.Item name="maxBotTurns" label="机器人最多连续回复轮次"><InputNumber min={1} max={50} /></Form.Item>
                      </Space>
                      <Form.Item name="handoffKeywords" label="强制转人工关键词（逗号分隔）"><Input /></Form.Item>
                    </Card>
                    <Card size="small" title="工具范围（AOP：未授权工具在证据阶段被跳过，动作工具受自治门禁约束）">
                      <Form.Item name="tools" noStyle>
                        <Select mode="multiple" style={{ width: '100%' }} options={meta?.tools.map((t) => ({ value: t.name, label: `${t.label} · ${t.name}${t.mutating ? ' · 动作' : ''}` }))} />
                      </Form.Item>
                      <div style={{ marginTop: 8, fontSize: 12, color: '#6b7280' }}>{meta?.tools.map((t) => <div key={t.name}><b>{t.name}</b>：{t.description}{t.requires.length ? `（需 ${t.requires.join('/')}）` : ''}</div>)}</div>
                    </Card>
                  </Col>
                </Row>
              </Form>
            ),
          },
          {
            key: 'test',
            label: '测试台',
            children: (
              <Row gutter={12}>
                <Col xs={24} lg={9}>
                  <Card size="small" title="用当前（草稿）配置试跑">
                    <Select value={testCustomer} onChange={setTestCustomer} allowClear placeholder="匿名访客" style={{ width: '100%', marginBottom: 8 }} options={[['cust-001', '张伟 · vip · 停滞包裹'], ['cust-002', '李娜 · 换开发票'], ['cust-003', '王芳 · svip · 专票'], ['cust-004', '刘洋 · 保价降价'], ['cust-005', '陈静 · 待发货'], ['cust-006', '赵敏 · vip · 退货退款']].map(([v, l]) => ({ value: v, label: l }))} />
                    <Input.TextArea rows={4} value={testText} onChange={(e) => setTestText(e.target.value)} />
                    <Button type="primary" icon={<ExperimentOutlined />} loading={busy === 'test'} onClick={runTest} style={{ marginTop: 8 }} block>运行执行链（沙箱，不真正建单）</Button>
                    <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8 }}>试跑会先保存草稿再执行；结果不落入任何会话，动作工具在沙箱中不执行。</Typography.Paragraph>
                  </Card>
                </Col>
                <Col xs={24} lg={15}>
                  <Card size="small" title="轨迹"><div style={{ maxHeight: 620, overflow: 'auto' }}><TraceViewer trace={testTrace} /></div></Card>
                </Col>
              </Row>
            ),
          },
          {
            key: 'bench',
            label: 'Benchmark',
            children: (
              <>
                <Space style={{ marginBottom: 10 }} wrap>
                  <Button type="primary" loading={busy === 'bench'} onClick={runBench}>运行评测集（{bench?.cases.length ?? 0} 例，真实模型调用）</Button>
                  {run && (
                    <>
                      <Tag>v{run.agentVersion} · {fmtTime(run.createdAt)}</Tag>
                      <span>场景准确率 <Progress type="circle" size={40} percent={Math.round(run.scenarioAccuracy * 100)} /></span>
                      <span>决策准确率 <Progress type="circle" size={40} percent={Math.round(run.decisionAccuracy * 100)} /></span>
                      {run.medicalBoundaryTotal ? (
                        <Tag className="medical-gate" color={run.releaseGate ? 'green' : 'red'}>医疗边界 {Math.round((run.medicalBoundaryPass ?? 0) * 100)}%（{run.medicalBoundaryTotal} 例）· {run.releaseGate ? '发布门禁通过' : '发布门禁未通过'}</Tag>
                      ) : null}
                      <Tag>{run.usage.calls} 次调用 · {run.usage.promptTokens + run.usage.completionTokens} tokens</Tag>
                    </>
                  )}
                </Space>
                {run && run.releaseGate === false && <Alert type="error" showIcon style={{ marginBottom: 10 }} message="医疗边界用例未全部通过：机器人在这些问法下可能输出医疗建议。发布前必须修正（CS-008B：始终禁止医疗建议）。" />}
                <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>评测集是冻结的真实问法 + 期望场景 + 期望自治决策；每次评测绑定 Agent 版本，用于比较配置改动是否真的改善（而不是仅看工程测试通过）。</Typography.Paragraph>
                <Table
                  size="small"
                  rowKey="caseId"
                  dataSource={(run?.rows ?? bench?.cases.map((c) => ({ caseId: c.id, category: (c as { category?: string }).category, text: c.text, expectedScenario: c.expected_scenario, expectedDecision: c.expected_decision, note: c.note })) ?? []) as Record<string, unknown>[]}
                  pagination={false}
                  columns={[
                    { title: '类别', dataIndex: 'category', width: 90, render: (v) => (v === 'medical_boundary' ? <Tag color="volcano">医疗边界</Tag> : <Tag>业务</Tag>) },
                    { title: '输入', dataIndex: 'text', ellipsis: true },
                    { title: '守卫', dataIndex: 'guardOk', width: 70, render: (v) => (v == null ? '—' : <Tag color={v ? 'green' : 'red'}>{v ? '通过' : '越界'}</Tag>) },
                    { title: '期望场景', dataIndex: 'expectedScenario', width: 130 },
                    { title: '实际场景', dataIndex: 'actualScenario', width: 130, render: (v, r: any) => v ? <Tag color={r.scenarioOk ? 'green' : 'red'}>{v}</Tag> : '—' },
                    { title: '期望决策', dataIndex: 'expectedDecision', width: 120, render: (v) => <DecisionTag decision={v} /> },
                    { title: '实际决策', dataIndex: 'actualDecision', width: 120, render: (v, r: any) => v ? <span style={{ outline: r.decisionOk ? 'none' : '2px solid #ff4d4f', borderRadius: 4 }}><DecisionTag decision={v} /></span> : '—' },
                    { title: '风险', dataIndex: 'risk', width: 90, render: (v) => v ? <RiskTag level={v} /> : '—' },
                    { title: '耗时', dataIndex: 'durationMs', width: 80, render: (v) => v ? `${v} ms` : '—' },
                    { title: '说明', dataIndex: 'note', ellipsis: true },
                  ]}
                />
                {bench?.runs && bench.runs.length > 1 && (
                  <Card size="small" title="历史评测" style={{ marginTop: 12 }}>
                    {bench.runs.map((r) => <div key={r.id} style={{ fontSize: 13, padding: '4px 0', cursor: 'pointer' }} onClick={() => setLastRun(r)}>v{r.agentVersion} · {fmtTime(r.createdAt)} · 场景 {pct(r.scenarioAccuracy)} · 决策 {pct(r.decisionAccuracy)}</div>)}
                  </Card>
                )}
              </>
            ),
          },
          {
            key: 'llm',
            label: '模型与高可用',
            children: (
              <Row gutter={12}>
                <Col xs={24} lg={14}>
                  <Card size="small" title="Provider 路由状态" extra={<Tag color={llmStatus?.configured ? 'green' : 'red'}>{llmStatus?.configured ? '可用' : '全部不可用 → 规则降级'}</Tag>}>
                    <Table size="small" rowKey="id" pagination={false} dataSource={llmStatus?.providers ?? []} columns={[
                      { title: 'Provider', dataIndex: 'id', width: 100, render: (v, r) => <span>{v}{r.simulatedDown && <Tag color="red" style={{ marginLeft: 6 }}>演练故障</Tag>}</span> },
                      { title: '模型', render: (_v, r) => r.models ? <span className="mono" style={{ fontSize: 12 }}>{r.models.fast}{r.models.fast !== r.models.reasoning ? ` / ${r.models.reasoning}` : ''}<br />{r.models.baseUrl}</span> : '—' },
                      { title: '熔断', dataIndex: 'circuit', width: 90, render: (v) => <Tag color={{ closed: 'green', half_open: 'orange', open: 'red' }[v as string]}>{{ closed: '闭合', half_open: '半开', open: '熔断' }[v as string]}</Tag> },
                      { title: '调用/失败', width: 100, render: (_v, r) => `${r.stats.calls} / ${r.stats.failures}` },
                      { title: '平均耗时', width: 90, render: (_v, r) => `${r.stats.avgMs} ms` },
                      { title: '最近错误', dataIndex: ['stats', 'lastError'], ellipsis: true, render: (v) => v ?? '—' },
                    ]} />
                    {isAdmin && (
                      <Space style={{ marginTop: 10 }} wrap>
                        <span>故障演练：</span>
                        <Button size="small" onClick={() => simulate('primary_down')}>模拟主模型故障</Button>
                        <Button size="small" danger onClick={() => simulate('all_down')}>模拟全部模型故障</Button>
                        <Button size="small" type="primary" onClick={() => simulate('normal')}>恢复正常</Button>
                      </Space>
                    )}
                    <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
                      策略：可重试错误（超时/网络/429/5xx）在同一 provider 指数退避重试 → 用尽后切换下一个 provider；连续失败达阈值即熔断并冷却后半开试探；401 直接切换；全部不可用时执行链进入<b>规则降级</b>（关键词识别场景、只陈述工具事实、强制人工确认），不让服务中断。备用 provider 通过 <code>LLM_FALLBACK_*</code> 配置。
                    </Typography.Paragraph>
                  </Card>
                </Col>
                <Col xs={24} lg={10}>
                  <Row gutter={[12, 12]}>
                    {[['执行链总数', llmStatus?.stats.traces], ['平均耗时(全部)', `${llmStatus?.stats.avgChainMs ?? 0} ms`], ['平均耗时(近20)', `${llmStatus?.stats.avgChainMsRecent20 ?? 0} ms`], ['发生切换', llmStatus?.stats.failedOverTraces], ['规则降级', llmStatus?.stats.degradedTraces]].map(([l, v]) => (
                      <Col key={String(l)} xs={12}><div className="kpi"><div className="label">{l}</div><div className="value" style={{ fontSize: 20 }}>{v ?? '—'}</div></div></Col>
                    ))}
                  </Row>
                  <Card size="small" title="路由事件" style={{ marginTop: 12 }}>
                    {llmStatus?.events.length ? llmStatus.events.map((e, i) => <div key={i} style={{ fontSize: 12, padding: '3px 0', borderBottom: '1px dashed #f0f0f0' }}><Tag color={e.type === 'circuit_open' || e.type === 'all_down' ? 'red' : e.type === 'failover' ? 'orange' : 'green'}>{e.type}</Tag>{e.provider} · {e.detail} <span style={{ color: '#9ca3af' }}>{fmtTime(e.at)}</span></div>) : <Typography.Text type="secondary">暂无切换/熔断事件</Typography.Text>}
                  </Card>
                </Col>
              </Row>
            ),
          },
          {
            key: 'whitelist',
            label: '白名单签发',
            children: <WhitelistPanel scenarios={meta?.scenarios ?? []} />,
          },
          {
            key: 'versions',
            label: `版本 ${agentData?.versions.length ?? ''}`,
            children: (
              <Table size="small" rowKey="version" dataSource={agentData?.versions ?? []} pagination={false} columns={[
                { title: '版本', dataIndex: 'version', width: 80, render: (v) => <Tag color={v === agent?.version ? 'green' : 'default'}>v{v}{v === agent?.version ? ' 当前' : ''}</Tag> },
                { title: '发布时间', dataIndex: 'published_at', width: 180, render: fmtTime },
                { title: '说明', dataIndex: 'note' },
                { title: '', width: 120, render: (_v, r) => isAdmin && r.version !== agent?.version && <Button size="small" icon={<UndoOutlined />} onClick={() => rollback(r.version)}>回滚到此版</Button> },
              ]} />
            ),
          },
        ]}
      />
    </div>
  );
}
