import type { Claim, EvidenceLevel, EvidenceMark, ProjectContent } from '../types.ts'

function evidence(level: EvidenceLevel, sourceIds: readonly string[], rationale: string): EvidenceMark {
  if ((level !== 'editorial' && sourceIds.length === 0) || rationale.trim().length === 0) {
    throw new Error('Evidence needs a rationale and non-editorial evidence needs sources')
  }
  return { level, sourceIds, rationale }
}

function claim(level: EvidenceLevel, text: string, sourceIds: readonly string[], rationale: string): Claim {
  return { text, evidence: evidence(level, sourceIds, rationale) }
}

function inferred(text: string, rationale = '依据工作区残留复原稿整理，不能证明为原文逐字内容。'): Claim {
  return claim('inferred', text, ['local-draft'], rationale)
}

function editorial(text: string, sourceIds: readonly string[], rationale: string): Claim {
  return claim('editorial', text, sourceIds, rationale)
}

type PipelineDefinition = readonly [label: string, detail: string, sourceIds?: readonly string[]]

function pipeline(steps: readonly PipelineDefinition[]): readonly { readonly label: string; readonly detail: Claim }[] {
  return steps.map(([label, detail, sourceIds = []]) => ({
    label,
    detail: editorial(detail, sourceIds, '流程标签来自残留叙事；具体输入输出、状态变化、可观测信号与失败边界是编辑补全。'),
  }))
}

const designQuestion = '为什么这样设计，而不是更简单的方案？'
const failureQuestion = '最容易失败的环节是什么，如何发现并回滚？'

export const projects: readonly ProjectContent[] = [
  {
    id: 1, slug: 'ai-customer-service', anchor: 'project-1-ai-customer-service', title: 'AI 客服', subtitle: '让可回答的问题受知识与人工边界约束。',
    thesis: inferred('AI 客服把重复咨询交给检索与受约束生成，同时把高风险或低置信问题交回人工。'),
    businessProblem: inferred('重复咨询占用人工，复杂投诉仍需人工处理。'),
    primaryPositions: ['ai-applications'], layerTouchpoints: ['business-entry', 'knowledge-assets'], upstream: ['客服会话', '知识库', '商品与订单查询'], downstream: ['客服坐席', '知识修订', '评测集'],
    pipeline: pipeline([
      ['意图与边界', '输入会话、账户上下文与风险规则，输出可回答、需查单或转人工路由；投诉与低置信请求直接进入人工队列。'],
      ['混合召回', '结构化条件与语义查询并行召回并记录各路命中数；任一路超时即降级，证据不足则停止生成。'],
      ['去重与重排', '合并候选后按权限、时效与相关性重排，输出带来源版本的证据集；空集或过期版本转人工。'],
      ['受约束生成', '输入仅限已授权证据，输出答复草稿必须携带引用；出现越权字段或无依据结论时阻断发送。'],
      ['引用校验与转人工', '逐条校验引用能否回指当前证据；缺失、过期或高风险命中时记录原因码并把会话交给坐席。'],
    ]),
    feedbackLoop: editorial('错答、追问、转人工原因经人工审核后，分别进入知识修订候选和隔离的评测集版本。', [], '审核、分流和版本隔离是为避免错误反馈直接污染知识与评测基准而补充的治理要求。'),
    misconception: editorial('“做了向量检索就等于生产级 RAG”不成立；还需要引用校验、失败边界和业务评测。', ['ragas-metrics'], 'RAGAS 提供评测指标，不能替代端到端业务评估。'),
    interviewQuestions: [
      { question: designQuestion, answer: '混合召回后增加重排、引用校验与转人工，是用额外延迟换取可追溯答案和对复杂投诉的安全边界。' },
      { question: failureQuestion, answer: '最容易失败的是召回不到正确依据；可观察无引用回答和转人工率，恢复动作是降级转人工并修订知识与评测集。' },
    ],
  },
  {
    id: 2, slug: 'data-platform', anchor: 'project-2-data-platform', title: '数据中台', subtitle: '把分散事实加工为可治理的数据资产。',
    thesis: editorial('数据中台的价值是提供可复用、可追溯的数据产品，而不是取代各业务系统。', [], '“不取代业务系统”是对残留叙事中平台边界的编辑性纠正。'),
    businessProblem: inferred('客服、商品、ERP、运营和直播数据分散且不可直接供模型使用。'),
    primaryPositions: ['data-governance'], layerTouchpoints: ['source-systems', 'knowledge-assets'], upstream: ['客服数据', '商品数据', 'ERP', '运营与直播数据'], downstream: ['知识库', '训练集', '评测集', 'AI 应用'],
    pipeline: pipeline([
      ['全量/增量接入', '全量快照建立基线，数据库变更事件按偏移量续传；输出落盘批次号，重复事件用业务键幂等合并。', ['debezium-docs']],
      ['清洗脱敏', '输入原始字段与数据分级规则，输出通过质量校验的脱敏记录；敏感字段漏检或规则版本缺失时隔离批次。'],
      ['人工标注', '待标样本进入双人或抽检队列，状态从待标转为已审；分歧率越界时暂停发布并回到规范修订。'],
      ['多模态理解', '文本、图片和视频生成结构化标签与置信度，记录模型版本；低置信或格式失败样本进入人工复核。'],
      ['数据产品与版本', '验收通过的数据按用途封装为知识、训练或评测版本，输出血缘清单；质量门未过不得标记可用。'],
    ]),
    feedbackLoop: editorial('质量问题、使用效果和业务变更回到数据负责人；回流事件需幂等，未经审核不得改写已发布数据产品。', [], '这是为使数据产品变更可追溯、可重放而新增的治理要求。'),
    misconception: editorial('“数据中台会取代业务数据库并自动解决语义问题”不成立；变更捕获只是一种接入能力，语义与治理仍需明确责任。', ['debezium-docs'], 'Debezium 文档支持变更事件捕获，不支持数据平台替代业务数据库的结论。'),
    interviewQuestions: [
      { question: designQuestion, answer: '选择接入、清洗、标注和版本化链路，是以更高治理成本换取跨系统数据可复用和可追溯。' },
      { question: failureQuestion, answer: '最容易失败的是增量数据质量漂移；可观察质量告警与版本差异，恢复动作是暂停发布并回滚到上一数据产品版本。' },
    ],
  },
  {
    id: 3, slug: 'operations-agent', anchor: 'project-3-operations-agent', title: '运营 Agent', subtitle: '将内容生产编排成可审查的工作流。',
    thesis: editorial('运营内容生产应将固定步骤表达为工作流，只把需要动态决策的部分称为 Agent。', ['langgraph-workflows'], 'LangGraph 文档直接区分预设 Workflow 与动态 Agent，本句据此纠正命名。'),
    businessProblem: inferred('主图、文案、视频等内容生产跨角色且审核成本高。'),
    primaryPositions: ['ai-applications'], layerTouchpoints: ['business-entry', 'knowledge-assets'], upstream: ['商品与人群数据', '素材资产', '合规规则'], downstream: ['运营审核', '发布渠道', '评测样本'],
    pipeline: pipeline([
      ['商品与人群分析', '输入商品属性、活动目标与人群约束，输出内容任务简报；关键字段缺失时记录阻断原因并退回运营补充。'],
      ['任务编排', '固定步骤由工作流推进状态，只有动态选工具或路径的节点才交给 Agent；每次转移记录决策与重试。', ['langgraph-workflows']],
      ['文案/图片/视频生成', '任务简报与已审核素材分别生成多模态候选，输出绑定模型、提示和素材版本；单路失败不放行残缺组合。'],
      ['合规检查', '候选内容依次通过敏感词、版权与平台规则校验，输出通过或拒绝原因；规则服务超时默认阻断发布。'],
      ['人工审核', '审核员对候选执行通过、驳回或修改，状态写入审计记录；只有已通过版本才能进入发布队列。'],
    ]),
    feedbackLoop: editorial('驳回原因和修改意见经归类与人工确认后，分别形成提示、规则候选和隔离的评测样本。', [], '将驳回意见直接学习会放大噪声，因此补充分类、确认与评测隔离门槛。'),
    misconception: editorial('“只要用了 LangGraph，每个节点都应该叫 Agent”不成立；预设路径是 workflow，动态选择工具和路径的部分才是 agent。', ['langgraph-workflows'], 'LangGraph 文档区分预设工作流与动态 Agent。'),
    interviewQuestions: [
      { question: designQuestion, answer: '采用任务编排、合规检查和人工审核，是以少量人工介入换取跨角色内容的一致性与可控发布。' },
      { question: failureQuestion, answer: '最容易失败的是生成内容越过合规边界；可观察审核驳回原因，恢复动作是阻断发布并把规则与样本回写评测。' },
    ],
  },
  {
    id: 4, slug: 'ai-asset-center', anchor: 'project-4-ai-asset-center', title: 'AI 素材中心', subtitle: '把文件、业务关联与派生语义置于同一版本边界。',
    thesis: editorial('素材中心必须同时管理原始文件、元数据、审核版本和可追溯的派生语义。', [], '这是为使素材事实、业务关系和派生结果可追溯而新增的数据模型要求。'),
    businessProblem: inferred('文件与商品、版本、活动和审核状态脱节。'),
    primaryPositions: ['knowledge-assets'], layerTouchpoints: ['data-governance', 'source-systems'], upstream: ['文件入库', '商品关联', '活动信息'], downstream: ['组合检索', '运营工作流', '事件订阅者'],
    pipeline: pipeline([
      ['文件入库', '输入文件流先计算内容哈希并校验格式，输出不可变对象键；哈希重复执行幂等关联，病毒或解码失败立即隔离。'],
      ['元数据绑定', '对象键与商品、活动、版权和租户字段绑定，状态从孤立文件转为待审核素材；必填关系缺失不得检索。'],
      ['审核与版本', '审核员冻结可发布版本并记录通过或驳回原因，输出版本号与审计人；新修订不能覆盖仍被引用的旧版本。'],
      ['组合检索', '结构化过滤先约束租户、版权和状态，再合并文本与视觉召回；输出结果保留对象和元数据版本。'],
      ['事件通知与派生语义', '已审核事件触发 OCR 或视觉理解，输出派生标签及来源版本；消费失败进入重试队列且不改变原素材状态。'],
    ]),
    feedbackLoop: editorial('只有已审核素材事件才能触发 OCR 或视觉理解；派生结果经质量门后写入，并保留来源、模型和素材版本。', [], '触发条件、质量门和三类版本信息是为防止派生语义脱离事实来源而补充的约束。'),
    misconception: editorial('“对象存储加 Elasticsearch 就自然成为内容资产系统”不成立；还需要审核、版本、业务关系与派生结果的血缘。', [], '这是没有直接支持来源的编辑性工程判断，不将残留复原稿伪作技术依据。'),
    interviewQuestions: [
      { question: designQuestion, answer: '把审核与版本置于检索之前，是以更严格的数据模型换取文件、商品和派生语义之间的可追溯关系。' },
      { question: failureQuestion, answer: '最容易失败的是派生结果与素材版本错配；可观察来源版本不一致事件，恢复动作是撤销派生索引并按已审核版本重算。' },
    ],
  },
  {
    id: 5, slug: 'livestream-clipping', anchor: 'project-5-livestream-clipping', title: '直播切片', subtitle: '用结构化时间轴支撑高光选择与人工审核。',
    thesis: editorial('直播切片不能只依赖摘要，需要将语音、视觉、商品与高光信号对齐到可审查的时间轴。', [], '结构化时间轴与多信号审核边界是为纠正“摘要即可剪辑”的叙述而编辑补充。'),
    businessProblem: inferred('数小时直播需要人工定位商品、筛高光并适配平台。'),
    primaryPositions: ['ai-applications'], layerTouchpoints: ['knowledge-assets', 'data-governance'], upstream: ['直播视频', '商品目录', '平台规格'], downstream: ['运营审核', '剪辑合成', '投放评测'],
    pipeline: pipeline([
      ['ASR 与视觉理解', '输入直播音视频，输出带时间戳的转写、镜头和画面实体；解码失败或时间戳漂移超过门槛时标记不可切。'],
      ['商品时间轴', '将口播、画面商品与商品目录对齐成时间区间，记录匹配置信度；冲突区间进入人工校对而非强行合并。'],
      ['候选片段', '按商品区间、句子边界和平台时长生成候选，输出起止帧与前后缓冲；素材缺帧时剔除候选。'],
      ['多信号高光评分', '组合语义、互动、商品与历史采用信号输出排序分；信号缺失会降权，并保留各分量供运营审查。'],
      ['合成与审核', '按平台规格合成字幕、画幅和片段版本，输出待审视频；人工未通过或转码失败时不得进入投放状态。'],
    ]),
    feedbackLoop: editorial('运营采用、驳回原因和投放表现按片段版本汇总，经人工确认后进入下一轮评测，不直接改写高光规则。', [], '采用信号与投放结果存在偏差，需按版本汇总并通过人工门槛后再用于评测。'),
    misconception: editorial('“模型的一段视频总结可以直接替代结构化时间轴和审核”不成立；摘要缺少片段定位、可验证信号和发布责任。', [], '这是没有直接支持来源的编辑性工程判断，不将残留复原稿伪作技术依据。'),
    interviewQuestions: [
      { question: designQuestion, answer: '先建立商品时间轴再做多信号评分，是以更多处理步骤换取可定位候选片段和平台适配能力。' },
      { question: failureQuestion, answer: '最容易失败的是商品与片段错位；可观察时间轴人工驳回率，恢复动作是撤回候选片段并校正时间对齐。' },
    ],
  },
  {
    id: 6, slug: 'ai-sales-assessment', anchor: 'project-6-ai-sales-assessment', title: 'AI 销售考核', subtitle: '把训练与评分放在可校准的评价闭环中。',
    thesis: editorial('销售陪练可将真实场景、规则与语义评分结合，但 LLM 判断必须接受人工校准。', [], '人工校准与偏差监控是对自动评分客观性假设的编辑性纠正。'),
    businessProblem: inferred('人工出题、陪练和评分成本高且口径不一致。'),
    primaryPositions: ['ai-applications'], layerTouchpoints: ['business-entry', 'knowledge-assets'], upstream: ['真实销售场景', '评分规则', '题库'], downstream: ['培训终端', '题库版本', '评分基准'],
    pipeline: pipeline([
      ['真实场景抽取', '输入经脱敏的销售对话与业务标签，输出场景卡片和证据片段；隐私检查失败或证据不足时拒绝入题库。'],
      ['难度化出题', '场景卡片按知识点、异议类型和难度生成题目候选，输出标准要点；专家审核后状态才转为可练习。'],
      ['多轮陪练', '学员回答驱动受角色约束的下一轮对话，记录每轮状态与超时；越界提示或安全命中时终止练习。'],
      ['规则评分', '输入完整练习记录，输出必答项、禁用项和流程项的确定性分数；缺少关键轮次时标记不可评分。'],
      ['LLM 评分与校准', '语义评分输出分数、理由与模型版本，并与人工样本比较；分歧率越界时停用该评分版本并回退规则分。'],
    ]),
    feedbackLoop: editorial('练习记录、抽检结论和优秀回答经专家审核后更新题库；评分样本按校准集与固定评测集隔离并版本化。', [], '专家门槛、样本隔离和版本化是防止评分漂移与评测污染的新增要求。'),
    misconception: editorial('“LLM-as-Judge 的分数天然客观，可以脱离人工校准”不成立；评分指标与输出需要持续抽检和业务基准。', [], '这是没有直接支持来源的编辑性工程判断；RAGAS 指标目录不能为 LLM 评分校准结论背书。'),
    interviewQuestions: [
      { question: designQuestion, answer: '保留规则评分并加入 LLM 评分与校准，是以校准工作换取对明确规则和复杂表达的共同覆盖。' },
      { question: failureQuestion, answer: '最容易失败的是评分口径漂移；可观察抽检分歧率，恢复动作是停用当前评分版本并回退到已校准基准。' },
    ],
  },
  {
    id: 7, slug: 'model-optimization', anchor: 'project-7-model-optimization', title: '模型优化', subtitle: '以可版本化的数据、评测和风险门槛决定是否扩大。',
    thesis: editorial('模型优化用高质量样本改善行为和风格，但不能替代检索事实依据或忽略离线与线上评测。', [], '微调、偏好优化、检索与实验的适用边界是编辑纠错，残留材料不能直接为此背书。'),
    businessProblem: inferred('RAG 改善事实依据后，品牌语气、结构和复杂情绪处理仍不稳定。'),
    primaryPositions: ['knowledge-assets'], layerTouchpoints: ['ai-applications', 'data-governance'], upstream: ['筛选数据', '偏好数据', '离线评测集'], downstream: ['版本实验', '风险监控', '回滚决策'],
    pipeline: pipeline([
      ['数据筛选', '输入经授权的会话与审核结果，输出去重、脱敏且带用途标签的候选；来源不明或与评测集重叠的样本隔离。'],
      ['SFT/偏好数据构造', '候选样本按目标拆成示范或偏好对，输出数据集版本与质量统计；标签冲突或格式失败进入人工复核。'],
      ['离线评测', '模型候选在冻结且隔离的评测集上输出质量与风险指标；任一安全门退化即停止进入线上实验。'],
      ['小流量实验', '通过离线门槛的模型按实验单元接收受控流量，记录版本、曝光和护栏指标；告警触发自动停止分配。'],
      ['扩量或回滚', '决策输入包含效果、风险、样本量与成本，输出扩量、继续观察或回滚状态；不采用固定流量比例。'],
    ]),
    feedbackLoop: editorial('业务、风险和失败样本按模型与数据版本回流；训练候选须经审核，并与冻结评测集做污染检查后再入库。', [], '版本绑定、审核门和污染检查是保证实验结论可信的新增模型治理要求。'),
    misconception: editorial('“微调替代 RAG，或者固定 20% 流量就是通用上线方法”不成立；二者解决不同问题，流量比例应由风险与样本量决定。', [], '这是没有直接支持来源的编辑性工程判断；RAGAS 指标目录不能为微调策略或流量比例背书。'),
    interviewQuestions: [
      { question: designQuestion, answer: '先离线评测再小流量实验，是以更慢的扩量速度换取在真实风险指标下可回滚的验证。' },
      { question: failureQuestion, answer: '最容易失败的是新版本在线风险恶化；可观察风险指标与失败样本，恢复动作是立即停止扩量并回滚模型和数据版本。' },
    ],
  },
  {
    id: 8, slug: 'mcp-governance', anchor: 'project-8-mcp-governance', title: 'MCP 与运行治理', subtitle: '分开管理能力连接协议与横切运行责任。',
    thesis: editorial('MCP 或工具网关统一 AI 应用与企业工具的连接；鉴权、观测、版本和发布应作为独立的运行治理能力。', ['mcp-intro', 'mcp-architecture'], 'MCP 官方资料直接支持协议与角色边界；运行治理分离是据此完成的编辑纠正。'),
    businessProblem: inferred('多个 AI 应用直接耦合私有 API，权限、观测、版本和发布职责混杂。'),
    primaryPositions: ['capability-connection', 'runtime-governance'], layerTouchpoints: ['ai-applications', 'data-governance', 'source-systems'], upstream: ['AI 应用', '私有 API', '身份与权限策略'], downstream: ['工具调用遥测', '版本实验', '治理告警'],
    pipeline: pipeline([
      ['工具边界设计', '输入业务能力、数据分级与副作用清单，输出最小化工具契约；无法定义权限或幂等语义的操作不予暴露。', ['mcp-architecture']],
      ['MCP/网关暴露', 'MCP Server 或网关发布版本化能力描述，客户端协商后调用；协议握手或模式校验失败时拒绝请求。', ['mcp-intro', 'mcp-architecture']],
      ['身份权限', '调用身份映射为租户、主体与最小权限策略，输出允许或拒绝决策；高风险工具还需人工批准令牌。'],
      ['调用观测', '每次调用记录工具版本、延迟、结果码、成本与追踪标识；超时、拒绝率或异常成本触发治理告警。'],
      ['版本实验与回滚', '新工具或策略只进入受控实验，输出质量与风险差异；护栏越界立即撤销路由并回滚已审计版本。'],
    ]),
    feedbackLoop: editorial('工具失败、权限拒绝、成本和质量遥测按租户与版本聚合，经治理负责人审核后形成规则或版本变更。', [], '遥测不能自动改变权限与发布状态，因此补充按租户、版本聚合和人工审批门槛。'),
    misconception: editorial('“MCP 自身提供完整服务发现、负载均衡、监控和灰度发布”不成立；MCP 定义 Host、Client、Server 的连接与能力边界，不替代完整运行平台。', ['mcp-intro', 'mcp-architecture'], 'MCP 官方介绍和架构规范界定的是协议与角色边界。'),
    interviewQuestions: [
      { question: designQuestion, answer: '将 MCP/网关暴露与身份、观测、实验分离，是以更多治理组件换取工具连接与运行责任的清晰边界。' },
      { question: failureQuestion, answer: '最容易失败的是权限策略误配；可观察权限拒绝和异常调用遥测，恢复动作是撤销工具版本或策略并回滚到已审计配置。' },
    ],
  },
]
