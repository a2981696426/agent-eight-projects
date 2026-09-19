# 评测（CS-009B 分级证据链）

| 级别 | 文件 / 工具 | 状态 |
|---|---|---|
| L0 测量合同 | `L0-MEASUREMENT-CONTRACT.md` | v0.1 草案，待四方签发 |
| L1 历史分层回放 | `pnpm eval:replay`（`apps/api/src/eval/replay.ts`） | 可运行；等待云商历史会话导出 |
| L3 官网坐席辅助试点 | — | 需先补坐席活动计时埋点（L0 §7） |
| L4 白名单小流量 | — | 需 web 端发送回执 + 72h 复联检测（P0 告警回执已落地） |

## L1 回放流程

1. **导出**：云商后台导出历史会话（长表：每行一条消息）。至少需要 `会话ID / 发送方 / 内容`，建议带 `时间 / 渠道 / 问题分类`；表头中英文自动映射（见 `replay.ts` 的 `COL` / `ROLE_MAP` / `CHANNEL_MAP`）。也接受 JSON（`[{ id, channel, turns: [{ at, role, text }] }]`）。
2. **回放**：
   ```bash
   pnpm eval:replay --input <导出.csv> --out docs/eval/replays/<日期>-<批次> [--limit 200] [--turns 6]
   ```
   默认在内存库中重建种子知识与白名单（不碰正式库）；要用正式库的知识/白名单，设 `REPLAY_USE_DB=1`。**用真实模型跑**（不要设 `LLM_MOCK`），报告的「版本冻结」会记录模型、知识快照、白名单版本。
   每一轮访客消息只看到决策时点之前的**原始**对话（访客 + 当时机器人/坐席），本系统的回复不进入后续上下文；访客文本在产物中已脱敏。
3. **两阶段盲审**（CS-009C）：把 `blind-stage1.csv` 发给质检——只含决策时点信息，先填 `should_category / evidence_status / should_path`；再发 `blind-stage2.csv`（含 Agent 建议与云商期原始应答）填 `facts_ok / category_ok / eligibility_ok / next_step_ok / post_hoc_evidence / guard_event / reviewer`。高风险与护栏样本双审。
4. **出基线**：把第二阶段结果另存为 `labels.csv`（列名同 stage2），重跑：
   ```bash
   pnpm eval:replay --input <导出.csv> --out <同目录> --labels <labels.csv>
   ```
   `report.md` 的「售后辅助建议可用率」按 L0 §2.1 计算（clarify 不入分母；后获证据与不可判定剔除），并按渠道 / 场景 / 风险 / 时段切片。可重建率 < 80% 时报告自动降级为"只用于发现案例"。

## 产物

`records.json`（逐轮完整记录）、`report.json` / `report.md`、`blind-stage1.csv`、`blind-stage2.csv`。`replays/2026-09-19-sample-mock/` 是用 `sample-yunshang-export.csv`（10 个合成会话）在 **Mock 模型**下生成的格式示例，数字不代表任何真实表现。

## 不要做的事

- 不要把 L1 的决策分布或 Benchmark 准确率当作"安全自主解决率"（只有 L4 能建立）。
- 不要在没有人工标签时引用"建议可用率"——报告会写"不可判定"。
- 不要把签发前的 L0 草案口径用于发布门禁。
