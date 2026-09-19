import { useState } from 'react';
import { Alert, App, Button, Card, Col, Drawer, Input, Row, Select, Space, Table, Tag, Typography } from 'antd';
import { PlusOutlined, StopOutlined } from '@ant-design/icons';
import type { ScenarioPack, Whitelist, WhitelistItem, WhitelistScope } from '@eight/shared';
import { api, fmtTime, useApi } from '../api';
import { useAuth } from '../auth';

/**
 * 白名单签发（CS-015 / ADR-0042 / CS-007）：自有渠道全时段 · 渠道平台非人工时段。
 * 流程：草稿 → 售后负责人签发 → 平台管理员发布（自动停用旧版本）→ 可即时停用。演示中 admin 同时承担两个角色，记名区分。
 */
const statusMeta: Record<Whitelist['status'], { text: string; color: string }> = { draft: { text: '草稿', color: 'default' }, signed: { text: '已签发', color: 'blue' }, published: { text: '生效中', color: 'green' }, disabled: { text: '已停用', color: 'red' } };
const SCOPE_LABEL: Record<WhitelistScope, { title: string; desc: string }> = {
  owned: { title: '自有渠道（官网 / App / 微信）', desc: '白名单内场景全时段自动回复；白名单外日间转在线坐席、夜间创建人工接续任务' },
  platform: { title: '渠道平台（天猫 / 抖店 / 京东）', desc: '工作时段一律辅助模式；仅非人工时段按白名单自动回复（CS-004 / CS-008B）' },
};

export default function WhitelistPanel({ scenarios }: { scenarios: ScenarioPack[] }) {
  const { message } = App.useApp();
  const { can } = useAuth();
  const isAdmin = can(['admin']);
  const { data: list, reload } = useApi<Whitelist[]>('/api/whitelists', { pollMs: 10_000 });
  const { data: active, reload: reloadActive } = useApi<{ owned: Whitelist | null; platform: Whitelist | null }>('/api/whitelists/active', { pollMs: 10_000 });
  const [draftScope, setDraftScope] = useState<WhitelistScope | null>(null);
  const [items, setItems] = useState<WhitelistItem[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = () => Promise.all([reload(), reloadActive()]);
  const run = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    try {
      await fn();
      await refresh();
      message.success(ok);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  function openDraft(scope: WhitelistScope) {
    const cur = active?.[scope];
    setItems(cur?.items.map((i) => ({ ...i })) ?? scenarios.filter((s) => ['logistics', 'invoice', 'presale', 'general'].includes(s.id)).map((s) => ({ scenario: s.id, maxRisk: 'L1' as const })));
    setNote('');
    setDraftScope(scope);
  }
  async function createDraft() {
    if (!draftScope || !items.length) return;
    await run('draft', () => api('/api/whitelists', { method: 'POST', body: { scope: draftScope, items, note } }), '已创建草稿，待售后负责人签发');
    setDraftScope(null);
  }
  const scenarioName = (id: string) => scenarios.find((s) => s.id === id)?.name ?? id;

  return (
    <>
      <Alert type="info" showIcon style={{ marginBottom: 12 }} message="白名单是唯一允许自动回复的口径：命中场景且风险不超过上限才自动发送；没有生效版本时默认拒绝。医疗建议、售后资格结论、权益承诺永远不在白名单内。" />
      <Row gutter={12}>
        {(['owned', 'platform'] as WhitelistScope[]).map((scope) => {
          const cur = active?.[scope] ?? null;
          return (
            <Col xs={24} lg={12} key={scope}>
              <Card
                size="small"
                title={<span>{SCOPE_LABEL[scope].title} {cur ? <Tag color="green">生效 v{cur.version}</Tag> : <Tag color="red">无生效版本 · 默认拒绝</Tag>}</span>}
                extra={isAdmin && <Button size="small" icon={<PlusOutlined />} onClick={() => openDraft(scope)}>新建版本</Button>}
              >
                <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>{SCOPE_LABEL[scope].desc}</Typography.Paragraph>
                {cur ? (
                  <Space wrap>
                    {cur.items.map((i) => <Tag key={i.scenario} color="blue">{scenarioName(i.scenario)} ≤ {i.maxRisk}</Tag>)}
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>签发 {cur.signedBy} · 发布 {cur.publishedBy} {fmtTime(cur.publishedAt)}</Typography.Text>
                  </Space>
                ) : (
                  <Typography.Text type="secondary">当前该范围内所有场景都不会自动回复。</Typography.Text>
                )}
              </Card>
            </Col>
          );
        })}
      </Row>
      <Table<Whitelist>
        style={{ marginTop: 12 }}
        size="small"
        rowKey="id"
        dataSource={list ?? []}
        pagination={{ pageSize: 10, size: 'small' }}
        onRow={() => ({ 'data-testid': 'whitelist-row' } as Record<string, string>)}
        columns={[
          { title: '范围', dataIndex: 'scope', width: 90, render: (v: WhitelistScope) => (v === 'owned' ? '自有渠道' : '渠道平台') },
          { title: '版本', dataIndex: 'version', width: 70, render: (v) => `v${v}` },
          { title: '状态', dataIndex: 'status', width: 90, render: (v: Whitelist['status']) => <Tag color={statusMeta[v].color}>{statusMeta[v].text}</Tag> },
          { title: '场景与上限', dataIndex: 'items', render: (items: WhitelistItem[]) => items.map((i) => `${scenarioName(i.scenario)}≤${i.maxRisk}`).join('，') },
          { title: '说明', dataIndex: 'note', ellipsis: true },
          { title: '签发', key: 'sign', width: 170, render: (_, w) => (w.signedBy ? <span style={{ fontSize: 12 }}>{w.signedBy}<br />{fmtTime(w.signedAt)}</span> : '—') },
          { title: '发布 / 停用', key: 'pub', width: 190, render: (_, w) => (w.status === 'disabled' ? <span style={{ fontSize: 12 }}>停用 {w.disabledBy}<br />{w.disabledReason}</span> : w.publishedBy ? <span style={{ fontSize: 12 }}>{w.publishedBy}<br />{fmtTime(w.publishedAt)}</span> : '—') },
          {
            title: '操作',
            key: 'ops',
            width: 210,
            render: (_, w) =>
              isAdmin && (
                <Space size={4}>
                  {w.status === 'draft' && <Button size="small" loading={busy === `sign-${w.id}`} onClick={() => run(`sign-${w.id}`, () => api(`/api/whitelists/${w.id}/sign`, { method: 'POST' }), '已签发（售后负责人）')}>签发</Button>}
                  {w.status === 'signed' && <Button size="small" type="primary" loading={busy === `pub-${w.id}`} onClick={() => run(`pub-${w.id}`, () => api(`/api/whitelists/${w.id}/publish`, { method: 'POST' }), '已发布并替代旧版本')}>发布</Button>}
                  {w.status !== 'disabled' && <Button size="small" danger icon={<StopOutlined />} loading={busy === `dis-${w.id}`} onClick={() => run(`dis-${w.id}`, () => api(`/api/whitelists/${w.id}/disable`, { method: 'POST', body: { reason: '管理员手动停用' } }), '已停用，立即生效')}>停用</Button>}
                </Space>
              ),
          },
        ]}
      />
      <Drawer open={!!draftScope} onClose={() => setDraftScope(null)} width={520} title={draftScope ? `新建白名单版本 · ${SCOPE_LABEL[draftScope].title}` : ''} extra={<Button type="primary" loading={busy === 'draft'} disabled={!items.length} onClick={createDraft}>创建草稿</Button>}>
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>默认复制当前生效版本。风险上限：L0 只允许纯追问/寒暄类零风险回复；L1 允许带只读事实的回复。资金/权益场景（退款差价、投诉）不可加入。</Typography.Paragraph>
        <Space direction="vertical" style={{ width: '100%' }}>
          {scenarios.filter((s) => !['refund_price_diff', 'complaint'].includes(s.id)).map((s) => {
            const cur = items.find((i) => i.scenario === s.id);
            return (
              <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', border: '1px solid #f0f0f0', borderRadius: 6 }}>
                <Button size="small" type={cur ? 'primary' : 'default'} onClick={() => setItems(cur ? items.filter((i) => i.scenario !== s.id) : [...items, { scenario: s.id, maxRisk: 'L1' }])} style={{ width: 150 }}>{s.name}</Button>
                <Select size="small" disabled={!cur} value={cur?.maxRisk ?? 'L1'} style={{ width: 90 }} onChange={(v: 'L0' | 'L1') => setItems(items.map((i) => (i.scenario === s.id ? { ...i, maxRisk: v } : i)))} options={[{ value: 'L0' }, { value: 'L1' }]} />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>{s.description}</Typography.Text>
              </div>
            );
          })}
        </Space>
        <Input.TextArea style={{ marginTop: 12 }} rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="变更说明（如：新增售前知识范围；依据 2026-09 质检数据）" />
      </Drawer>
    </>
  );
}
