# 压测（k6）

门禁来源：切片 0 P1——200 并发访客下 p95 端到端 ≤ 15 s、失败率 < 1%（`docs/contexts/commerce-platform/DELIVERY-SLICES.md`）。

```bash
# 1) 另起一个 mock 模型的 API 实例（内存库，不写开发数据，不产生模型费用）
LLM_MOCK=1 DATA_DIR=:memory: API_PORT=8788 pnpm --filter @eight/api start
# 2) 冒烟 / 峰值
pnpm load:smoke
pnpm load:peak
# 3) 结果：终端摘要 + load/results/<scenario>-<time>.json；整理后写入 docs/LOAD-TEST.md
```

真实模型参考：`k6 run -e SCENARIO=smoke -e BASE_URL=http://127.0.0.1:8787 load/k6-chat.js`（会产生模型费用；只用于观察真实时延分布）。

Windows 若 `k6` 不在 PATH：`& "C:\Program Files\k6\k6.exe" run ...`。
