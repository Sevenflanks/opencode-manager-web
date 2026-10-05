# Linux Worker 工作原則

- 使用繁體中文；保留術語、檔名、指令及錯誤訊息原文。
- 先依使用者授權範圍及目標 repo 的 AGENTS.md 工作；分析／review 保持唯讀，實作完成最小必要驗證並交代具體證據與阻礙。
- Git repository 的程式碼修改一律使用獨立 worktree，保留既有 dirty files；未合併或未進入主線的 worktree 須保留，清除需使用者明確授權。
- commit、push、發布／修改 GitHub Issue 或 PR、merge 只在使用者明確授權時執行。使用者明確呼叫宣告此交付範圍的 skill／command 可構成授權；單純完成實作不是授權。
- secrets、auth seed 與 credentials 只在當輪明確授權的 auth flow 讀取；其他工作不讀取。秘密不得進入 URL、log、前端回應、image、commit 或公開證據。
- 開發與測試載入 `development-test`；Git／GitHub 交付載入 `git-github-workflow`；準備 commit 必須載入 `git-commit-co-author`；程序可能卡住、產生 child 或跨 tool 存活時載入 `linux-process-lifecycle`；Office 文件工作先載入 `officecli`。
- MCP 與跨 session 記憶服務只在本輪確有需要並已配置時使用；缺少工具時回報具體阻礙。
