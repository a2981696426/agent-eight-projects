import { Alert, Card, Col, Row, Steps, Tag, Typography } from 'antd';
import { Link } from 'react-router-dom';
import { STAGE_LABELS } from '@eight/shared';
import { useApi } from '../api';
import { NAV } from '../layout/AppLayout';

interface OverviewData {
  conversations: number;
  waitingHuman: number;
  cases: number;
  handoffsPending: number;
  traces: number;
  knowledge: number;
  quality: number;
  voc: number;
  llmConfigured: boolean;
}

export default function Overview() {
  const { data } = useApi<OverviewData>('/api/overview', { pollMs: 15_000 });
  const kpis = [
    ['会话总数', data?.conversations],
    ['待人工接续', data?.waitingHuman],
    ['待处理子案件', data?.cases],
    ['待接续任务', data?.handoffsPending],
    ['执行链运行次数', data?.traces],
    ['已发布知识', data?.knowledge],
    ['质检记录', data?.quality],
    ['客户之声条目', data?.voc],
  ] as const;
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>八项目 AI 客服 · 系统总览</h2>
          <div className="desc">以网易云商 AI 客服产品结构为参照重构：系统基座 · 智能增强 · 服务管理 · 售后数字员工，四层围绕同一条可审计的 Agent 执行链。</div>
        </div>
      </div>
      {data && !data.llmConfigured && <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="大模型未配置：请在根目录 .env 设置 LLM_API_KEY（兼容 OpenAI 协议），机器人与 AIGC 能力将不可用。" />}
      <Row gutter={[12, 12]}>
        {kpis.map(([label, value]) => (
          <Col key={label} xs={12} md={6} xl={3}>
            <div className="kpi">
              <div className="label">{label}</div>
              <div className="value">{value ?? '—'}</div>
            </div>
          </Col>
        ))}
      </Row>
      <Card title="核心业务执行链（每次机器人应答都完整走一遍，并留下可追溯的九阶段轨迹）" style={{ marginTop: 14 }} size="small">
        <Steps
          size="small"
          items={(Object.keys(STAGE_LABELS) as (keyof typeof STAGE_LABELS)[]).map((k) => ({ title: STAGE_LABELS[k], status: 'finish' as const }))}
        />
        <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0, fontSize: 13 }}>
          规则先行（寒暄/致谢零模型调用）→ 正则 + CRM + 历史轨迹补全槽位 → 快模型识别场景/意图/实体/风险信号 → 按场景包调用业务工具取证 → 混合检索 + 弱命中时改写重检 → 推理模型给出根因/话术/动作提案（引用只允许已给来源）→ 四维信号 + 规则计算风险等级 L0–L3 → 白名单 × 风险上限 × 动作许可决定 自主 / 人工确认 / 升级 (P0–P2) → 生成对客回复与内部备注。
          在 <Link to="/ai/online-robot">在线机器人</Link> 里发一句话即可看到全过程。
        </Typography.Paragraph>
      </Card>
      <Row gutter={[12, 12]} style={{ marginTop: 14 }}>
        {NAV.map((g) => (
          <Col key={g.group} xs={24} md={12} xl={6}>
            <Card size="small" title={g.group}>
              {g.items.map((it) => (
                <div key={it.key} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px dashed #f0f0f0' }}>
                  <Link to={it.key}>
                    {it.icon} <span style={{ marginLeft: 6 }}>{it.label}</span>
                  </Link>
                  {it.deferred ? <Tag>暂缓</Tag> : <Tag color="green">可用</Tag>}
                </div>
              ))}
            </Card>
          </Col>
        ))}
      </Row>
    </div>
  );
}
