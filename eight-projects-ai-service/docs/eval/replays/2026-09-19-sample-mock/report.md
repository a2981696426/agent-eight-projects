# L1 历史分层回放报告

生成时间：2026-09-19T11:08:35.138Z

> 本报告只建立固定案例上的建议质量与护栏覆盖基线（CS-009B 第 1 级）；**不得**据此声称人工节时、客户复联改善或真实自主解决率（L0 §7）。

## 版本冻结

| 项 | 值 |
|---|---|
| agent | agent-cs-main@v1 |
| whitelistOwned | owned@1 |
| whitelistPlatform | platform@1 |
| knowledgeSnapshot | a3fdb6bad59d |
| retrievalMode | hybrid |
| embedding | mock/mock-bigram-hash |
| llm | MOCK（结果不代表真实模型） |
| workCalendar | 09:00-18:00 d1-5 |
| codeVersion | dev |

## 输入审计

| 会话 | 访客轮次 | 带时间戳 | 带订单号/取到证据 | 可重建 | 可重建率 | 云商期转人工会话 |
|---|---|---|---|---|---|---|
| 10 | 16 | 16 | 11 | 16 | 100.0% | 5 |

> 可重建率 100.0% ≥ 80%，满足 L0 §6 的基线条件（阈值待签发冻结）。

## 自治决策分布

- 总体：auto_reply 8 · human_confirm 4 · escalate 4
- 按渠道：web（auto_reply 5 · escalate 2）；wechat（auto_reply 3 · human_confirm 1 · escalate 2）；app（human_confirm 3）
- 按场景：logistics（auto_reply 2）；invoice（auto_reply 2）；presale（auto_reply 3）；refund_price_diff（human_confirm 3）；general（human_confirm 1 · escalate 2 · auto_reply 1）；complaint（escalate 2）
- 按风险：L0 10 · L2 3 · L3 3
- 人工时段：auto_reply 5 · human_confirm 1 · escalate 2；非人工时段：auto_reply 3 · human_confirm 3 · escalate 2；时间未知：—

## 护栏规则扫描（机器检出，需人工复核确认）

| 医疗建议 | 越权承诺语言 | 无依据金额 | 无效引用 | 规则降级 |
|---|---|---|---|---|
| 0 | 0 | 0 | 0 | 0 |

## 与云商期应答的描述性对照（不是因果）

- 云商机器人应答的 14 轮中，本系统自主回复 7（50.0%）
- 云商人工应答的 2 轮中，本系统同样交人工 1（50.0%）

## 延迟与调用

平均 4 ms · p95 13 ms · 平均模型调用 2.13 次/轮

## 售后辅助建议可用率（L0 §2.1）

**不可判定**——已标注 0 轮，形成建议且四字段齐全的 0 轮。请用 `blind-stage1.csv` → `blind-stage2.csv` 完成两阶段盲审后以 `--labels` 重跑。
