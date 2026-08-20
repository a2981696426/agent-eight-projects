import type { SiteContent, SourceRecord } from '../types.ts'
import { escapeAttribute, escapeHtml, safeHref } from './escape.ts'

function renderSource(source: SourceRecord): string {
  const status = source.status === 'deleted'
    ? '原页面已删除'
    : source.status === 'local-artifact'
      ? '本地残留材料'
      : '可访问来源'
  const title = `${source.publisher} · ${source.title}`
  const href = source.url ? safeHref(source.url) : undefined
  const reference = href
    ? `<a href="${escapeAttribute(href)}" rel="noreferrer">${escapeHtml(title)}</a>`
    : `<span>${escapeHtml(title)}</span>`

  return `<li>${reference}：${escapeHtml(source.purpose)}。<strong>状态：${status}</strong></li>`
}

export function renderSupportingSections(content: SiteContent): string {
  return `<section id="core-insight" class="core-insight" aria-labelledby="core-insight-title">
  <h2 id="core-insight-title">核心洞察：数据复用需要治理边界</h2>
  <p>数据复用可以减少重复清洗成本，让知识、评测、训练与业务应用围绕同一份可追溯资产协作；它的价值仍取决于数据质量、清晰的所有权，以及是否适合当前使用场景。</p>
  <p>数据库负责业务事实与事务边界，需求工程负责确认要解决的问题；数据平台并不取代二者。</p>
</section>
<section id="interview-script" class="interview-script" aria-labelledby="interview-script-title">
  <h2 id="interview-script-title">面试表达：30 / 90 / 30</h2>
  <ol>
    <li><strong>30 秒开场：</strong>这是一套从客服切入、把数据沉淀为资产，再服务内容、培训、模型优化与运行治理的五层系统学习设计。</li>
    <li><strong>90 秒架构解释：</strong>业务入口承接客服、运营和培训；AI 应用与工作流消费知识资产；数据治理加工来源系统的数据；MCP 或工具网关负责能力互操作，鉴权、观测、实验和回滚横切全链路。</li>
    <li><strong>30 秒收束：</strong>我会从自己真正做过、验证过的部分展开，并说明评测、人工审核与回滚如何让反馈安全回流。</li>
  </ol>
  <p><strong>诚实边界：</strong>只有实际完成的工作才能作为项目经历；其余内容应明确称为架构设计、练习或技术验证。你希望我从哪个真实负责的领域继续展开？</p>
</section>
<section id="audit-summary" class="audit-summary" aria-labelledby="audit-summary-title">
  <h2 id="audit-summary-title">审校结论</h2>
  <ol>
    <li><strong>MCP：</strong>MCP 是能力互操作协议，不是完整的负载均衡、可观测性、集群或发布平台。</li>
    <li><strong>Workflow / Agent：</strong>预设步骤是工作流；只有会动态决定步骤与工具的部分才是 Agent。</li>
    <li><strong>数据平台：</strong>数据中台不替代业务数据库、数据质量责任或需求工程。</li>
    <li><strong>RAG 评测：</strong>RAGAS 指标是评测组件，不等同于完整的检索、生成和业务结果评估体系。</li>
    <li><strong>模型优化与流量：</strong>SFT、偏好优化与 RAG 解决不同问题；“20% 流量”只是场景示例，必须由风险与样本量决定。</li>
    <li><strong>反馈回流：</strong>回答、审核和实验结果必须先经质量检查与人工审校，不能无条件进入知识库或训练集。</li>
  </ol>
</section>
<section id="sources" class="sources" aria-labelledby="sources-title">
  <h2 id="sources-title">来源与恢复边界</h2>
  <p>本页是审校型知识重建，不是原作者的逐字全文；已删除页面与残留索引只能支持有限事实，不能证明原文细节。</p>
  <details>
    <summary>查看来源状态与用途</summary>
    <ul>
      ${content.sources.map((source) => renderSource(source)).join('\n      ')}
    </ul>
  </details>
</section>
<footer class="site-footer">
  <p><strong>审校型知识重建</strong> · 面向 AI 应用开发面试准备的本地静态学习页</p>
  <p>内容边界、证据状态与恢复限制以本页来源说明及工作区审校报告为准。</p>
</footer>`
}
