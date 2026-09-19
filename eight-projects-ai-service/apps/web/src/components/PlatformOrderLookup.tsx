import { useEffect, useState } from 'react';
import { Alert, Button, Descriptions, Empty, Input, Space, Tag, Typography } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import { api, useApi } from '../api';

/** 电商平台只读订单查询（CS-018）：坐席按访客提供的天猫订单号核对订单 / 物流 / 退款；数据已脱敏、只读。 */
interface Result {
  order: { orderId: string; status: string; statusText: string; createdAt: string; paidAt: string | null; shippedAt: string | null; amount: number; paidAmount: number; items: { title: string; skuText: string; qty: number; price: number }[]; receiver: { nameMasked: string; phoneMasked: string; addressMasked: string }; buyerNickMasked: string };
  logistics: { company: string; trackingNo: string; status: string; lastUpdate: string | null; hoursSinceUpdate: number | null; stalled: boolean; events: { time: string; desc: string }[] } | null;
  refunds: { refundId: string; statusText: string; amount: number; reason: string; createdAt: string }[];
  source: string;
}

export default function PlatformOrderLookup({ initialOrderId }: { initialOrderId?: string | null }) {
  const { data: status } = useApi<{ platforms: { platform: string; mode: string; ok: boolean; detail: string; sampleOrderIds: string[] }[] }>('/api/platform/status');
  const [id, setId] = useState(initialOrderId ?? '');
  const [res, setRes] = useState<Result | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const tmall = status?.platforms[0];
  useEffect(() => {
    if (initialOrderId && /^\d{16,19}$/.test(initialOrderId)) setId(initialOrderId);
  }, [initialOrderId]);

  async function lookup() {
    if (!/^\d{16,19}$/.test(id.trim())) {
      setErr('请输入 16~19 位电商平台订单号');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      setRes(await api<Result>(`/api/platform/tmall/orders/${id.trim()}`));
    } catch (e) {
      setRes(null);
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ fontSize: 12 }}>
      <Space.Compact style={{ width: '100%', marginBottom: 8 }}>
        <Input size="small" value={id} onChange={(e) => setId(e.target.value)} placeholder="天猫订单号（16~19 位）" onPressEnter={lookup} />
        <Button size="small" type="primary" icon={<SearchOutlined />} loading={busy} onClick={lookup}>查询</Button>
      </Space.Compact>
      <Typography.Text type="secondary" style={{ fontSize: 11 }}>
        {tmall ? <>数据源 <Tag color={tmall.ok ? 'green' : 'red'} style={{ marginInlineEnd: 4 }}>{tmall.platform} · {tmall.mode === 'sandbox' ? '沙箱' : tmall.mode === 'live' ? '开放平台' : '关闭'}</Tag>{tmall.detail}{tmall.mode === 'sandbox' && tmall.sampleOrderIds.length ? <> · 样例：{tmall.sampleOrderIds.map((s) => <a key={s} onClick={() => setId(s)} style={{ marginRight: 6 }}>{s}</a>)}</> : null}</> : '平台数据源状态加载中…'}
      </Typography.Text>
      {err && <Alert type="warning" showIcon style={{ marginTop: 8 }} message={err} />}
      {res && (
        <div style={{ marginTop: 8 }}>
          <Descriptions size="small" column={1} bordered items={[
            { key: 's', label: '状态', children: <span><Tag color={res.order.status === 'TRADE_FINISHED' ? 'green' : res.order.status.startsWith('TRADE_CLOSED') ? 'default' : 'blue'}>{res.order.statusText}</Tag><Tag>{res.source}</Tag><Tag>只读</Tag></span> },
            { key: 'i', label: '商品', children: res.order.items.map((it, i) => <div key={i}>{it.title} <span style={{ color: '#6b7280' }}>{it.skuText}</span> ×{it.qty} ¥{it.price}</div>) },
            { key: 'a', label: '金额', children: `应付 ¥${res.order.amount} · 实付 ¥${res.order.paidAmount}` },
            { key: 't', label: '时间', children: `下单 ${res.order.createdAt}${res.order.paidAt ? ` · 付款 ${res.order.paidAt}` : ''}${res.order.shippedAt ? ` · 发货 ${res.order.shippedAt}` : ''}` },
            { key: 'r', label: '收件人', children: `${res.order.receiver.nameMasked} ${res.order.receiver.phoneMasked} ${res.order.receiver.addressMasked}（脱敏，仅用于与访客自述比对）` },
          ]} />
          <div style={{ marginTop: 8, fontWeight: 600 }}>物流</div>
          {res.logistics ? (
            <div>
              <Space size={4} wrap><Tag>{res.logistics.company}</Tag><span className="mono">{res.logistics.trackingNo}</span><Tag color={res.logistics.stalled ? 'red' : 'blue'}>{res.logistics.status}{res.logistics.stalled ? ` · 停滞 ${res.logistics.hoursSinceUpdate} 小时` : ''}</Tag></Space>
              {res.logistics.events.slice(0, 4).map((e, i) => <div key={i} style={{ color: '#6b7280' }}>{e.time} {e.desc}</div>)}
            </div>
          ) : <Typography.Text type="secondary">暂无物流记录</Typography.Text>}
          <div style={{ marginTop: 8, fontWeight: 600 }}>退款</div>
          {res.refunds.length ? res.refunds.map((r) => <div key={r.refundId}><span className="mono">{r.refundId}</span> <Tag color="orange">{r.statusText}</Tag>¥{r.amount} · {r.reason} · {r.createdAt}</div>) : <Typography.Text type="secondary">无退款记录</Typography.Text>}
        </div>
      )}
      {!res && !err && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="输入天猫订单号查看平台只读数据" style={{ margin: '12px 0' }} />}
    </div>
  );
}
