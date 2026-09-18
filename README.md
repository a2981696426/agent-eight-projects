# Agent 面试必备的 8 个项目：审校型知识重建

这是一个面向有后端基础、正在准备 AI 应用开发面试读者的静态学习页。页面是经过来源分级与工程边界审校的知识重建，不是原作者逐字全文，也不声称官方恢复原页面。

## 子项目：八项目 AI 客服系统

`eight-projects-ai-service/` 是一个独立的 pnpm workspace（Node 22 + Fastify + React），以网易云商 AI 客服的产品结构为参照，围绕一条九阶段 Agent 执行链实现在线客服、工单、机器人、Agent/Mind Studio、质检、报表、大屏、客户之声与售后数字员工。它与本学习站不共享运行时；使用与拆出为独立仓库的方法见 [eight-projects-ai-service/README.md](eight-projects-ai-service/README.md)。

## 在线访问

- 学习页：<https://a2981696426.github.io/agent-eight-projects/>
- 源码仓库：<https://github.com/a2981696426/agent-eight-projects>

## 环境要求

- Node.js 24（`package.json` 限定 `>=24.0.0 <25`）
- pnpm 11.5.2

## 本地运行

```powershell
pnpm install
pnpm dev
```

开发服务器会在终端显示本地访问地址。本站不需要后端 API、第三方脚本、远程图片或在线字体。

## 构建与验证

```powershell
pnpm build
pnpm test
pnpm test:e2e
pnpm verify
pnpm screenshots
```

- `pnpm build` 执行 TypeScript 检查并生成生产静态文件。
- `pnpm test` 运行内容、渲染、交互、源文件完整性测试，并用 Vite 原生配置加载器验证显式导入路径。
- `pnpm test:e2e` 使用生产构建与本地预览运行 Playwright 验收，包括多视口、深色模式、减少动画、无 JavaScript、键盘、离线初始加载、Axe 与控制台检查。
- `pnpm verify` 依次运行单元测试、生产构建和完整浏览器验收。
- `pnpm screenshots` 通过生产预览生成确定性的全页验收截图。

生产输出位于 `dist/`。验收截图位于 `artifacts/visual/`，覆盖 1440、768、390、320 像素亮色视口及 1440 像素深色视口。

## 自动验证与部署

`.github/workflows/pages.yml` 使用 GitHub Actions 维护统一发布链路：

- Pull Request 只运行完整的 `pnpm verify`，工作流默认权限为只读，不取得 Pages 写权限。
- 向 `main` 推送或合并后，先运行相同质量门禁，再重新构建并只上传 `dist/`，最后发布到 `github-pages` environment。
- `workflow_dispatch` 可在 GitHub Actions 页面人工重跑同一发布流程。

Vite 使用相对基础路径 `base: './'`。生产资源因此相对于当前页面解析，可同时用于本地预览和 `/agent-eight-projects/` 项目级 Pages 地址；部署契约测试会用真实生产构建验证资源没有逃逸到账号根路径。

## 内容与证据维护

经审校的网页内容在 `src/content/` 编辑。每个知识主张只能分配一个主证据等级：

- `confirmed`（已确认）：可访问页面、残存索引或权威资料直接支持。
- `inferred`（合理推断）：符合残存上下文和工程常识，但不能证明属于原文章节或原作者原意。
- `editorial`（编辑补全）：为准确、连贯地解释工程边界而新增。

新增或修改主张时必须说明证据理由，并仅引用 `src/content/sources.ts` 中登记的来源 ID。来源失效不得影响静态正文渲染；删除页面必须继续显示状态，不能升级为“已确认全文”。

## 原始材料与出处边界

受保护的残留输入文件是：

`《Agent 面试必备的 8 个项目》内容还原稿.md`

SHA-256 基线：

`9730E8E72CB5BCF62D40BDEC6DD31EA13DFFB5CA1E578935CF6B4BFFB11DE00C`

该文件必须逐字节保持不变。网页正文与其分离维护，且明确使用“审校型知识重建”的定位。

## 授权边界

本仓库未附加开源许可证。除适用法律及 GitHub 平台功能明确允许的范围外，代码、审校重建内容、残留材料和视觉证据均未授权复制、再分发或制作衍生作品。公开可见不等于开放许可。
