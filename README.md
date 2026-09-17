# OpenCode Manager Web（OMW）

以手機管理 Windows 本機 OpenCode 執行個體的個人工具。
OMW 負責目錄捷徑、程序管理與狀態摘要；對話及工具互動沿用官方 OpenCode Web。

## 專案狀態

目前為開發初始化階段，尚未提供正式部署版本。
技術方向為 Vue 3、TypeScript、Vite、shadcn-vue，以及 Node.js、Fastify、SQLite。

- [MVP 規格](https://github.com/Sevenflanks/opencode-manager-web/issues/1)
- [工作票索引](docs/specs/omw-mvp-work-plan.md)
- [領域詞彙](CONTEXT.md)

初期僅在 loopback 開發。認證、Tailnet 與正式部署依工作票中的核准方案實作，不預設公開網路入口。
