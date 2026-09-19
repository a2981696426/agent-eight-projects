import { useEffect, useState } from 'react';
import { App, Button, Card, Col, DatePicker, Input, Row, Segmented, Select, Space, Table, Tag } from 'antd';
import ReactECharts from 'echarts-for-react';
import type { ReportResult, ReportSpec } from '@eight/shared';
import { api, fmtTime, useApi } from '../../api';

interface Options { datasets: { id: string; dimensions: { id: string; label: string }[]; metrics: { id: string; label: string }[] }[]; saved: { id: string; name: string; spec: ReportSpec; created_at: string }[] }
const DS_LABEL: Record<string, string> = { conversations: '会话', cases: '子案件', traces: '执行链', quality: '质检' };

export default function Reports() {
  const { message } = App.useApp();
  const { data: opts, reload } = useApi<Options>('/api/reports/options');
  const [spec, setSpec] = useState<ReportSpec>({ dataset: 'conversations', dimension: 'channel', metric: 'count' });
  const [result, setResult] = useState<ReportResult | null>(null);
  const [chart, setChart] = useState<'bar' | 'pie' | 'line'>('bar');
  const [name, setName] = useState('');
  const ds = opts?.datasets.find((d) => d.id === spec.dataset);

  async function run(s = spec) {
    try {
      setResult(await api<ReportResult>('/api/reports/run', { method: 'POST', body: s }));
    } catch (e) {
      message.error((e as Error).message);
    }
  }
  useEffect(() => {
    if (opts) void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts]);
  async function save() {
    if (!name.trim()) return;
    await api('/api/reports/saved', { method: 'POST', body: { name, spec } });
    setName('');
    await reload();
    message.success('报表已保存');
  }
  const option = {
    tooltip: {},
    grid: { left: 60, right: 20, top: 30, bottom: 60 },
    xAxis: chart === 'pie' ? undefined : { type: 'category', data: result?.rows.map((r) => r.key) ?? [], axisLabel: { rotate: 20 } },
    yAxis: chart === 'pie' ? undefined : { type: 'value' },
    series: [chart === 'pie' ? { type: 'pie', radius: ['35%', '65%'], data: result?.rows.map((r) => ({ name: r.key, value: r.value })) ?? [] } : { type: chart, data: result?.rows.map((r) => r.value) ?? [], itemStyle: { color: '#1f6feb' }, smooth: true }],
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>自定义报表</h2>
          <div className="desc">开箱即用的自助分析：选择数据集 × 维度 × 指标 × 时间范围，服务端实时聚合，表格与图表联动，可保存为常用报表。</div>
        </div>
      </div>
      <Row gutter={12}>
        <Col xs={24} lg={7}>
          <Card size="small" title="报表定义">
            <Space direction="vertical" style={{ width: '100%' }}>
              <Select value={spec.dataset} onChange={(v) => { const d = opts?.datasets.find((x) => x.id === v)!; setSpec({ dataset: v, dimension: d.dimensions[0].id, metric: d.metrics[0].id }); }} options={opts?.datasets.map((d) => ({ value: d.id, label: `数据集：${DS_LABEL[d.id] ?? d.id}` }))} />
              <Select value={spec.dimension} onChange={(v) => setSpec({ ...spec, dimension: v })} options={ds?.dimensions.map((d) => ({ value: d.id, label: `维度：${d.label}` }))} />
              <Select value={spec.metric} onChange={(v) => setSpec({ ...spec, metric: v })} options={ds?.metrics.map((m) => ({ value: m.id, label: `指标：${m.label}` }))} />
              <DatePicker.RangePicker style={{ width: '100%' }} onChange={(_d, s) => setSpec({ ...spec, dateFrom: s[0] || undefined, dateTo: s[1] || undefined })} />
              <Button type="primary" block onClick={() => run()}>运行报表</Button>
              <Space.Compact style={{ width: '100%' }}>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="保存为…" />
                <Button onClick={save} disabled={!name.trim()}>保存</Button>
              </Space.Compact>
            </Space>
          </Card>
          <Card size="small" title="已保存报表" style={{ marginTop: 12 }}>
            {opts?.saved.length ? opts.saved.map((s) => (
              <div key={s.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px dashed #f0f0f0', fontSize: 13 }}>
                <a onClick={() => { setSpec(s.spec); void run(s.spec); }}>{s.name}</a>
                <Space size={4}><Tag>{DS_LABEL[s.spec.dataset]}</Tag><a onClick={async () => { await api(`/api/reports/saved/${s.id}`, { method: 'DELETE' }); await reload(); }}>删除</a></Space>
              </div>
            )) : <span style={{ color: '#9ca3af', fontSize: 13 }}>暂无</span>}
          </Card>
        </Col>
        <Col xs={24} lg={17}>
          <Card size="small" title={result ? `${DS_LABEL[result.spec.dataset]} · ${result.columns[0]} × ${result.columns[1]}` : '结果'} extra={<Segmented size="small" value={chart} onChange={(v) => setChart(v as typeof chart)} options={[{ label: '柱状', value: 'bar' }, { label: '折线', value: 'line' }, { label: '饼图', value: 'pie' }]} />}>
            <ReactECharts style={{ height: 300 }} option={option} notMerge />
            <Table size="small" rowKey="key" pagination={false} dataSource={result?.rows ?? []} columns={[{ title: result?.columns[0] ?? '维度', dataIndex: 'key' }, { title: result?.columns[1] ?? '指标', dataIndex: 'value', width: 140 }, { title: '样本数', width: 100, render: (_v, r) => r.extra?.n }]} />
            {result && <div style={{ color: '#9ca3af', fontSize: 12, marginTop: 8 }}>生成时间 {fmtTime(result.generatedAt)}</div>}
          </Card>
        </Col>
      </Row>
    </div>
  );
}
