# OpenCode Manager Web (OMW)

OMW 是 Windows 本機的 OpenCode 管理介面，用來檢視 Project、Instance 與 Session，並啟動 OMW 管理的背景 OpenCode Instance。

> [!IMPORTANT]
> `@sevenflanks/omw` 尚未確認已發布至 public npm registry。目前請使用這個 repository 建出的 local `.tgz`；`npx @sevenflanks/omw` 不是已驗證的安裝步驟。

## Local package 快速開始

需求：Windows 11、Node.js 24+、npm，以及已安裝的 OpenCode CLI。

在 repository root 開啟 PowerShell：

```powershell
$packageDir = Join-Path $env:TEMP 'omw-local-package'
New-Item -ItemType Directory -Force -Path $packageDir | Out-Null
npm pack --pack-destination $packageDir -w @sevenflanks/omw
$omwPackage = Join-Path $packageDir 'sevenflanks-omw-0.1.0.tgz'

# 第一次執行會在互動式終端建立 OMW 帳密；之後會重用既有 Manager。
npm exec --yes --package="$omwPackage" -- omw
```

成功後，用瀏覽器開啟終端輸出的 URL，預設是 `http://127.0.0.1:4174`。Plain `omw` 只啟動或重用 Manager，不會啟動 OpenCode TUI。

在目前目錄透過 OMW wrapper 啟動 OpenCode：

```powershell
npm exec --yes --package="$omwPackage" -- omw opencode
```

也可提供 Project 與 Session：

```powershell
npm exec --yes --package="$omwPackage" -- omw opencode 'C:\develop\projects\example' -s '<session-id>'
```

OMW 不會安裝 OpenCode、不會修改 `PATH`，也不會攔截原生 `opencode`。只有 `omw opencode ...` 會進入 wrapper；直接執行 `opencode` 永遠保留原生行為。

如果 `opencode.exe` 不在 `PATH`，請使用可信任的絕對路徑：

```powershell
$env:OMW_OPENCODE_EXECUTABLE = 'C:\path\to\opencode.exe'
```

OMW 的預設持久資料固定在 `%LOCALAPPDATA%\OMW`，不受 cwd、repository、local `.tgz` 或 npm cache 位置影響。不要為了重試而刪除或覆寫既有 OMW data。

## 使用手冊

完整操作、三種停止語意、資料與 auth 保留規則、問題排除、Tailnet 安全邊界和待補實機驗收，請閱讀：

- [OMW 本機使用手冊](docs/user-guide.md)

架構與流程圖：

- [OMW 本機與 Tailnet 架構](docs/diagrams/omw-architecture.html)
- [OMW 啟動、重用與失敗處理](docs/diagrams/omw-startup-flow.html)
- [OMW 三種停止操作](docs/diagrams/omw-stop-semantics.html)

## 安全與開發文件

- [Launcher and authentication contract](docs/security/launcher-contract.md)
- [Tailnet access runbook](docs/security/tailnet-access.md)
- [Mobile acceptance checklist](docs/security/mobile-acceptance.md)
- [Domain model](docs/agents/domain.md)
- [Issue tracker workflow](docs/agents/issue-tracker.md)
- [Project context](CONTEXT.md)

## 目前未驗證

Local package pack 與 `.tgz` 的 `omw` bin resolution 已驗證；下列項目仍需正式 acceptance run，不應由文件或設計圖推定完成：

- Public npm publication 與 `npx @sevenflanks/omw` end-to-end。
- 首次互動式設定、真實背景 Manager 與 OpenCode TUI。
- Web UI 桌面 walkthrough 與六張正式截圖。
- Tailscale Serve 與真實手機 list/detail 操作。

細部證據與待補畫面清單見[使用手冊的驗收章節](docs/user-guide.md#11-驗收證據與待補截圖)。
