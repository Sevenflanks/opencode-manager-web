# OpenCode Manager Web（OMW）

以手機管理 Windows 本機 OpenCode 執行個體的個人工具。
OMW 負責目錄捷徑、程序管理與狀態摘要；對話及工具互動沿用官方 OpenCode Web。

## 開發

需求為 Node.js 24 與 npm。Manager 預設只監聽 `127.0.0.1`，且必須透過
`OMW_OPENCODE_EXECUTABLE` 明確指定 OpenCode executable。

```powershell
npm install
npm run build
$env:OMW_OPENCODE_EXECUTABLE = 'C:\path\to\opencode.exe'
npm run dev
```

API 與本機資料位置詳見 [開發說明](docs/development.md)。Runtime 仍只監聽 loopback；
已實作核准的 Basic auth、current-user DPAPI credential contract 與 remote URL validation，
但不會自行設定 Tailscale、Firewall、PATH 或 production secrets。安全取捨與隔離 PoC 見
[Tailnet access contract](docs/security/tailnet-access.md)；opt-in `omw-opencode`、fixed port pool 與
fail-open 邊界見 [Local TUI launcher contract](docs/security/launcher-contract.md)。

- [MVP 規格](https://github.com/Sevenflanks/opencode-manager-web/issues/1)
- [工作票索引](docs/specs/omw-mvp-work-plan.md)
- [領域詞彙](CONTEXT.md)

未設定 `OMW_REMOTE_ACCESS=1` 時維持未啟用 production auth 的 loopback 開發模式；不會自動建立對外入口。
