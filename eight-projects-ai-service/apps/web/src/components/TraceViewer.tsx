import { Collapse, Descriptions, Empty, Space, Tag, Typography } from 'antd';
import type { Trace } from '@eight/shared';

export const riskColor: Record<string, string> = { L0: 'green', L1: 'cyan', L2: 'orange', L3: 'red' };
export const decisionMeta: Record<string, { label: string; color: string }> = {
  auto_reply: { label: '自主回复', color: 'green' },
  human_confirm: { label: '人工确认', color: 'orange' },
  escalate: { label: '升级人工', color: 'red' },
};

export function DecisionTag({ decision, priority }: { decision?: string | null; priority?: string | null }) {
  if (!decision) return <Tag>—</Tag>;
  const m = decisionMeta[decision] ?? { label: decision, color: 'default' };
  return (
    <Tag color={m.color}>
      {m.label}
      {priority ? ` · ${priority}` : ''}
    </Tag>
  );
}

export function RiskTag({ level }: { level?: string | null }) {
  return level ? (
    <Tag color={riskColor[level]} className="badge-risk">
      风险 {level}
    </Tag>
  ) : (
    <Tag>—</Tag>
  );
}

/** 九阶段执行轨迹可视化：每个阶段一张卡，可展开看结构化明细 */
export default function TraceViewer({ trace, compact = false }: { trace: Trace | null | undefined; compact?: boolean }) {
  if (!trace) return <Empty description="尚无执行轨迹" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  return (
    <div>
      <Space wrap size={[6, 6]} style={{ marginBottom: 10 }}>
        <Tag color={trace.status === 'completed' ? 'green' : 'red'}>{trace.status === 'completed' ? '执行完成' : '执行失败'}</Tag>
        <Tag>场景 {trace.scenario ?? '—'}</Tag>
        <Tag>意图 {trace.intent ?? '—'}</Tag>
        <RiskTag level={trace.risk?.level} />
        <DecisionTag decision={trace.autonomy?.decision} priority={trace.autonomy?.priority} />
        <Tag>{trace.totalDurationMs} ms</Tag>
        <Tag>
          LLM {trace.usage.calls} 次 · {trace.usage.promptTokens + trace.usage.completionTokens} tokens
        </Tag>
        <Typography.Text type="secondary" className="mono">
          {trace.id}
        </Typography.Text>
      </Space>
      {trace.stages.map((s, i) => (
        <div key={s.id} className={`stage ${s.status}`}>
          <div className="h">
            <span>
              {i + 1}. {s.label}
            </span>
            <span style={{ fontWeight: 400, color: '#6b7280', fontSize: 12 }}>
              {s.durationMs} ms{s.llm ? ` · ${s.llm.model}${s.llm.thinking ? '·思考' : ''} ${s.llm.promptTokens}+${s.llm.completionTokens}` : ''}
            </span>
          </div>
          <div className="s">{s.summary}</div>
          {!compact && (
            <Collapse
              ghost
              size="small"
              items={[
                {
                  key: 'd',
                  label: <span style={{ fontSize: 12 }}>结构化明细</span>,
                  children: <pre className="mono" style={{ margin: 0, maxHeight: 320, overflow: 'auto', whiteSpace: 'pre-wrap', background: '#fafafa', padding: 8, borderRadius: 4 }}>{JSON.stringify(s.detail, null, 2)}</pre>,
                },
              ]}
            />
          )}
        </div>
      ))}
      {trace.reply && (
        <Descriptions size="small" column={1} bordered style={{ marginTop: 8 }}>
          <Descriptions.Item label="对客回复（实际发送）">
            <span className="reply-sent" style={{ whiteSpace: 'pre-wrap' }}>{trace.reply.text}</span>
          </Descriptions.Item>
          {trace.reply.candidate && trace.reply.candidate !== trace.reply.text && (
            <Descriptions.Item label={trace.reply.kind === 'handoff' ? '候选话术（已升级，供坐席参考）' : '候选话术（待人工确认后发送）'}>
              <span className="reply-candidate" style={{ whiteSpace: 'pre-wrap' }}>{trace.reply.candidate}</span>
            </Descriptions.Item>
          )}
          <Descriptions.Item label="内部备注">
            <span style={{ whiteSpace: 'pre-wrap', fontSize: 12, color: '#4b5563' }}>{trace.reply.internalNote}</span>
          </Descriptions.Item>
        </Descriptions>
      )}
    </div>
  );
}
