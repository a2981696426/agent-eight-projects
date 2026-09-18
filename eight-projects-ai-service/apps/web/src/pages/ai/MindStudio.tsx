import { useState } from 'react';
import { App, Button, Card, Col, Drawer, Form, Input, Modal, Row, Select, Space, Switch, Table, Tabs, Tag, Typography } from 'antd';
import { CheckOutlined, DeleteOutlined, ImportOutlined, PlusOutlined, SearchOutlined } from '@ant-design/icons';
import type { KnowledgeDoc, KnowledgeHit } from '@eight/shared';
import { api, fmtTime, useApi } from '../../api';

interface DocDetail {
  doc: KnowledgeDoc;
  chunks: { id: string; seq: number; text: string; tags: string[] }[];
  usage: { traceId: string; at: string; scenario: string }[];
  usageCount: number;
}

export default function MindStudio() {
  const { message, modal } = App.useApp();
  const { data: docs, reload } = useApi<KnowledgeDoc[]>('/api/knowledge/docs');
  const { data: stats, reload: reloadStats } = useApi<{ docs: number; published: number; chunks: number; indexed: number; categories: { category: string; n: number }[] }>('/api/knowledge/stats');
  const [detail, setDetail] = useState<DocDetail | null>(null);
  const [editing, setEditing] = useState<Partial<KnowledgeDoc> | null>(null);
  const [form] = Form.useForm();
  const [q, setQ] = useState('这个传感器防水吗');
  const [hits, setHits] = useState<KnowledgeHit[] | null>(null);
  const [importText, setImportText] = useState('');
  const [importPublish, setImportPublish] = useState(false);
  const [faqSource, setFaqSource] = useState('');
  const [faqs, setFaqs] = useState<{ question: string; answer: string; tags: string[] }[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = () => Promise.all([reload(), reloadStats()]);
  async function openDoc(id: string) {
    setDetail(await api<DocDetail>(`/api/knowledge/docs/${id}`));
  }
  async function publish(id: string, action: 'publish' | 'unpublish') {
    await api(`/api/knowledge/docs/${id}/publish`, { method: 'POST', body: { action } });
    message.success(action === 'publish' ? '已发布并重建索引' : '已下线');
    await refresh();
    if (detail?.doc.id === id) await openDoc(id);
  }
  async function save() {
    const v = await form.validateFields();
    const body = { ...v, tags: String(v.tags ?? '').split(/[,，\s]+/).filter(Boolean) };
    if (editing?.id) await api(`/api/knowledge/docs/${editing.id}`, { method: 'PUT', body });
    else await api('/api/knowledge/docs', { method: 'POST', body });
    setEditing(null);
    message.success('已保存为草稿，发布后进入检索');
    await refresh();
  }
  async function search() {
    setBusy('search');
    try {
      const r = await api<{ hits: KnowledgeHit[] }>('/api/knowledge/search', { method: 'POST', body: { q, topK: 6 } });
      setHits(r.hits);
    } finally {
      setBusy(null);
    }
  }
  async function doImport() {
    setBusy('import');
    try {
      const r = await api<{ created: number }>('/api/knowledge/import', { method: 'POST', body: { text: importText, publish: importPublish, category: '导入' } });
      message.success(`已导入 ${r.created} 篇`);
      setImportText('');
      await refresh();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  async function extract() {
    setBusy('faq');
    try {
      const r = await api<{ faqs: { question: string; answer: string; tags: string[] }[] }>('/api/knowledge/faq-extract', { method: 'POST', body: { text: faqSource, max: 6 } });
      setFaqs(r.faqs);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  async function saveFaqs(publishNow: boolean) {
    if (!faqs?.length) return;
    await api('/api/knowledge/faq/save', { method: 'POST', body: { faqs, publish: publishNow } });
    message.success(`已保存 ${faqs.length} 条 FAQ${publishNow ? '并发布' : '为草稿'}`);
    setFaqs(null);
    await refresh();
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>Mind Studio · 企业知识底座</h2>
          <div className="desc">接入 → 加工（自动切块/FAQ 抽取）→ 人工发布 → 供在线机器人、坐席辅助、执行链调用 → 使用追溯。草稿不进入检索；发布后即刻重建索引。</div>
        </div>
        <Space>
          <Button icon={<PlusOutlined />} type="primary" onClick={() => { form.resetFields(); setEditing({}); }}>新建资料</Button>
        </Space>
      </div>
      <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
        {[['资料总数', stats?.docs], ['已发布', stats?.published], ['知识块', stats?.chunks], ['已入索引', stats?.indexed]].map(([l, v]) => (
          <Col key={String(l)} xs={12} md={6}><div className="kpi"><div className="label">{l}</div><div className="value">{v ?? '—'}</div></div></Col>
        ))}
      </Row>
      <Tabs
        items={[
          {
            key: 'docs',
            label: '知识资料',
            children: (
              <Table<KnowledgeDoc>
                rowKey="id"
                size="small"
                dataSource={docs ?? []}
                pagination={{ pageSize: 10, size: 'small' }}
                onRow={(d) => ({ onClick: () => openDoc(d.id), style: { cursor: 'pointer' } })}
                columns={[
                  { title: '标题', dataIndex: 'title', ellipsis: true },
                  { title: '分类', dataIndex: 'category', width: 90 },
                  { title: '标签', dataIndex: 'tags', width: 220, render: (t: string[]) => t.map((x) => <Tag key={x}>{x}</Tag>) },
                  { title: '来源', dataIndex: 'source', width: 80, render: (v) => ({ manual: '手工', import: '导入', faq: 'FAQ', conversation: '会话' } as Record<string, string>)[v] },
                  { title: '版本', dataIndex: 'version', width: 60, render: (v) => `v${v}` },
                  { title: '块', dataIndex: 'chunkCount', width: 50 },
                  { title: '状态', dataIndex: 'status', width: 90, render: (v) => <Tag color={v === 'published' ? 'green' : 'default'}>{v === 'published' ? '已发布' : '草稿'}</Tag> },
                  { title: '更新时间', dataIndex: 'updatedAt', width: 160, render: fmtTime },
                  {
                    title: '操作',
                    width: 170,
                    render: (_, d) => (
                      <Space size={4} onClick={(e) => e.stopPropagation()}>
                        {d.status === 'published' ? <Button size="small" onClick={() => publish(d.id, 'unpublish')}>下线</Button> : <Button size="small" type="primary" icon={<CheckOutlined />} onClick={() => publish(d.id, 'publish')}>发布</Button>}
                        <Button size="small" onClick={async () => { const full = await api<DocDetail>(`/api/knowledge/docs/${d.id}`); form.setFieldsValue({ ...full.doc, tags: full.doc.tags.join(',') }); setEditing(full.doc); }}>编辑</Button>
                        <Button size="small" danger icon={<DeleteOutlined />} onClick={() => modal.confirm({ title: `删除《${d.title}》？`, onOk: async () => { await api(`/api/knowledge/docs/${d.id}`, { method: 'DELETE' }); await refresh(); } })} />
                      </Space>
                    ),
                  },
                ]}
              />
            ),
          },
          {
            key: 'search',
            label: '检索测试台',
            children: (
              <Card size="small">
                <Space.Compact style={{ width: '100%', maxWidth: 720 }}>
                  <Input value={q} onChange={(e) => setQ(e.target.value)} onPressEnter={search} placeholder="输入用户可能的问法，查看命中的知识块与分数" />
                  <Button type="primary" icon={<SearchOutlined />} loading={busy === 'search'} onClick={search}>检索</Button>
                </Space.Compact>
                <Typography.Paragraph type="secondary" style={{ marginTop: 8, fontSize: 12 }}>混合词法检索（中文二元组 + BM25，命中率归一化 0~1）。执行链在弱命中（低于 Agent 配置的 minScore）时会让快模型结合上下文改写查询后重检。</Typography.Paragraph>
                {hits?.map((h) => (
                  <div key={h.id} style={{ padding: '8px 10px', border: '1px solid #f0f0f0', borderRadius: 6, marginBottom: 8 }}>
                    <Space><Tag color={h.score >= 0.22 ? 'green' : 'orange'}>{h.score.toFixed(2)}</Tag><b>{h.docTitle}</b><span className="mono" style={{ color: '#9ca3af' }}>{h.id}</span>{h.tags.map((t) => <Tag key={t}>{t}</Tag>)}</Space>
                    <div style={{ fontSize: 13, whiteSpace: 'pre-wrap', marginTop: 4 }}>{h.text}</div>
                  </div>
                ))}
                {hits && !hits.length && <Typography.Text type="secondary">无命中</Typography.Text>}
              </Card>
            ),
          },
          {
            key: 'import',
            label: '批量导入',
            children: (
              <Card size="small">
                <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>粘贴多篇资料，用一行 <code>---</code> 或 <code># 标题</code> 分隔；每篇首行作为标题。可选导入后直接发布。</Typography.Paragraph>
                <Input.TextArea rows={10} value={importText} onChange={(e) => setImportText(e.target.value)} placeholder={'# 加固贴使用说明\n加固贴用于……\n\n---\n\n# 传感器更换周期\n每 14 天……'} />
                <Space style={{ marginTop: 8 }}>
                  <Switch checked={importPublish} onChange={setImportPublish} /> 导入后直接发布
                  <Button type="primary" icon={<ImportOutlined />} loading={busy === 'import'} disabled={!importText.trim()} onClick={doImport}>导入</Button>
                </Space>
              </Card>
            ),
          },
          {
            key: 'faq',
            label: 'FAQ 抽取（大模型）',
            children: (
              <Card size="small">
                <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>从原始资料（说明书、聊天记录、政策文档）自动抽取问答对，人工核对后入库为 FAQ 知识。</Typography.Paragraph>
                <Input.TextArea rows={8} value={faqSource} onChange={(e) => setFaqSource(e.target.value)} placeholder="粘贴资料原文（≥ 20 字）" />
                <Space style={{ marginTop: 8 }}>
                  <Button type="primary" loading={busy === 'faq'} disabled={faqSource.trim().length < 20} onClick={extract}>抽取问答对</Button>
                  {faqs && <><Button onClick={() => saveFaqs(false)}>保存为草稿</Button><Button type="primary" onClick={() => saveFaqs(true)}>保存并发布</Button></>}
                </Space>
                {faqs && (
                  <Table size="small" style={{ marginTop: 10 }} rowKey="question" dataSource={faqs} pagination={false} columns={[
                    { title: '标准问', dataIndex: 'question', width: 260, render: (v, _r, i) => <Input value={v} onChange={(e) => setFaqs((f) => f!.map((x, j) => (j === i ? { ...x, question: e.target.value } : x)))} /> },
                    { title: '答案', dataIndex: 'answer', render: (v, _r, i) => <Input.TextArea autoSize value={v} onChange={(e) => setFaqs((f) => f!.map((x, j) => (j === i ? { ...x, answer: e.target.value } : x)))} /> },
                    { title: '标签', dataIndex: 'tags', width: 160, render: (t: string[]) => t.map((x) => <Tag key={x}>{x}</Tag>) },
                    { title: '', width: 50, render: (_v, _r, i) => <Button size="small" danger icon={<DeleteOutlined />} onClick={() => setFaqs((f) => f!.filter((_x, j) => j !== i))} /> },
                  ]} />
                )}
              </Card>
            ),
          },
        ]}
      />
      <Drawer open={!!detail} onClose={() => setDetail(null)} width={680} title={detail?.doc.title}>
        {detail && (
          <>
            <Space wrap style={{ marginBottom: 10 }}>
              <Tag color={detail.doc.status === 'published' ? 'green' : 'default'}>{detail.doc.status === 'published' ? '已发布' : '草稿'}</Tag>
              <Tag>v{detail.doc.version}</Tag><Tag>{detail.doc.category}</Tag>{detail.doc.tags.map((t) => <Tag key={t}>{t}</Tag>)}
              <Tag color="blue">被执行链引用 {detail.usageCount} 次</Tag>
            </Space>
            <Typography.Title level={5}>原文</Typography.Title>
            <pre style={{ whiteSpace: 'pre-wrap', background: '#fafafa', padding: 10, borderRadius: 6, fontFamily: 'inherit', fontSize: 13 }}>{detail.doc.content}</pre>
            <Typography.Title level={5}>加工结果 · {detail.chunks.length} 个知识块</Typography.Title>
            {detail.chunks.map((c) => (
              <div key={c.id} style={{ border: '1px solid #f0f0f0', borderRadius: 6, padding: 8, marginBottom: 6, fontSize: 13 }}>
                <span className="mono" style={{ color: '#9ca3af' }}>{c.id}</span>
                <div style={{ whiteSpace: 'pre-wrap' }}>{c.text}</div>
              </div>
            ))}
            {detail.usage.length > 0 && (
              <>
                <Typography.Title level={5}>使用追溯（最近）</Typography.Title>
                {detail.usage.map((u) => <div key={u.traceId} className="mono" style={{ fontSize: 12 }}>{fmtTime(u.at)} · {u.scenario} · {u.traceId}</div>)}
              </>
            )}
          </>
        )}
      </Drawer>
      <Modal open={!!editing} onCancel={() => setEditing(null)} onOk={save} title={editing?.id ? '编辑资料（内容变更将升版并回到草稿）' : '新建资料'} okText="保存草稿" width={720}>
        <Form form={form} layout="vertical" initialValues={{ category: '未分类' }}>
          <Form.Item name="title" label="标题" rules={[{ required: true }]}><Input /></Form.Item>
          <Space>
            <Form.Item name="category" label="分类"><Select style={{ width: 160 }} options={['物流', '发票', '退款', '产品', '服务规范', 'FAQ', '未分类'].map((v) => ({ value: v }))} /></Form.Item>
            <Form.Item name="tags" label="标签（逗号分隔，用于场景包软过滤）"><Input style={{ width: 360 }} placeholder="物流,发货" /></Form.Item>
          </Space>
          <Form.Item name="content" label="正文（Markdown 段落自动切块）" rules={[{ required: true }]}><Input.TextArea rows={12} /></Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
