import type { SourceRecord } from '../types.ts'

export const sources = [
  { id: 'local-draft', title: '《Agent 面试必备的 8 个项目》内容还原稿', status: 'local-artifact', publisher: '工作区残留材料', purpose: '项目顺序、复原叙事与待审查技术主张' },
  { id: 'deleted-codefather', title: 'Agent面试必备的8个项目（已删除）', url: 'https://www.codefather.cn/post/2073963436408045570', status: 'deleted', publisher: '编程导航 / Codefather', purpose: '确认原页面地址、标题及删除状态' },
  { id: 'codefather-index', title: '校招标签残存索引', url: 'https://ai.codefather.cn/tag/%E6%A0%A1%E6%8B%9B?current=5', status: 'live', publisher: '鱼皮 AI 导航', purpose: '确认文章标题仍存在于站内索引' },
  { id: 'mcp-intro', title: 'What is the Model Context Protocol?', url: 'https://modelcontextprotocol.io/docs/getting-started/intro', status: 'live', publisher: 'Model Context Protocol', purpose: '界定 MCP 为连接 AI 应用与外部系统的开放标准' },
  { id: 'mcp-architecture', title: 'MCP Architecture', url: 'https://modelcontextprotocol.io/specification/2025-06-18/architecture', status: 'live', publisher: 'Model Context Protocol', purpose: '界定 Host、Client、Server 与能力协商边界' },
  { id: 'langgraph-workflows', title: 'Workflows and agents', url: 'https://docs.langchain.com/oss/python/langgraph/workflows-agents', status: 'live', publisher: 'LangChain', purpose: '区分预设 Workflow 与动态 Agent' },
  { id: 'ragas-metrics', title: 'List of available metrics', url: 'https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/', status: 'live', publisher: 'Ragas', purpose: '说明 Faithfulness、Response Relevancy 等是评测指标而非完整体系' },
  { id: 'debezium-docs', title: 'Debezium Documentation', url: 'https://debezium.io/documentation/reference/stable/index.html', status: 'live', publisher: 'Debezium', purpose: '确认数据库变更事件捕获能力' },
] as const satisfies readonly SourceRecord[]
