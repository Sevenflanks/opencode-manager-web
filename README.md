# OpenCode Manager Web (OMW)

OMW 是 Windows 本機的 OpenCode 管理介面，用來檢視 Project、Instance 與 Session，並啟動 OMW 管理的背景 OpenCode Instance。

> [!IMPORTANT]
> `@sevenflanks/omw` 尚未確認已發布至 public npm registry。以下步驟只使用此 repository 建出的 local `.tgz`，不把 `npx @sevenflanks/omw` 當成可用的安裝方式。
>
> Local package 是日常／configured product flow，會使用 `%LOCALAPPDATA%\OMW`。Repository development 必須改用[隔離的開發入口](docs/development.md#quick-start)，避免讀寫日常 credentials、token、SQLite 與 OpenCode data。

## Prerequisites

- Windows 11
- Node.js 24 以上與 npm
- 已安裝的 OpenCode CLI
- 本 repository 的本機 checkout

## Quick Start

在 repository root 開啟 PowerShell：

```powershell
npm ci
$packageDir = Join-Path $env:TEMP 'omw-local-package'
New-Item -ItemType Directory -Force -Path $packageDir | Out-Null
$packageName = npm pack --pack-destination $packageDir -w @sevenflanks/omw | Select-Object -Last 1
$omwPackage = Join-Path $packageDir $packageName
npm exec --yes --package="$omwPackage" -- omw
```

第一次執行會在互動式終端建立 OMW 帳密；之後會重用既有 Manager。成功後開啟終端顯示的 URL，預設為 `http://127.0.0.1:4174`。Plain `omw` 不會啟動 OpenCode TUI。

## Usage

在目前目錄透過 OMW wrapper 啟動 OpenCode：

```powershell
npm exec --yes --package="$omwPackage" -- omw opencode
```

指定 Project 與既有 Session：

```powershell
npm exec --yes --package="$omwPackage" -- omw opencode 'C:\develop\projects\example' -s '<session-id>'
```

OMW 不會安裝 OpenCode、修改 `PATH` 或攔截原生 `opencode`。只有 `omw opencode ...` 進入 wrapper。完整操作、不同停止語意、資料保留與問題排除見[使用手冊](docs/user-guide.md)。

## Architecture

![OMW 本機與 Tailnet 架構](docs/diagrams/omw-architecture.svg)

[HTML source](docs/diagrams/omw-architecture.html)

![OMW 啟動、重用與失敗處理](docs/diagrams/omw-startup-flow.svg)

[HTML source](docs/diagrams/omw-startup-flow.html)

![OMW 三種停止操作](docs/diagrams/omw-stop-semantics.svg)

[HTML source](docs/diagrams/omw-stop-semantics.html)

## Development

Repository 開發、測試與驗收使用 worktree-local 或 fresh temporary isolation，不使用上述日常 package 命令。從[開發說明的 Quick Start](docs/development.md#quick-start)開始。

## Reference

- [使用手冊](docs/user-guide.md)
- [Development](docs/development.md)
- [Technical Reference](docs/reference.md)
- [Launcher and authentication contract](docs/security/launcher-contract.md)
- [Tailnet access runbook](docs/security/tailnet-access.md)
- [Mobile acceptance checklist](docs/security/mobile-acceptance.md)
- [Domain model](docs/agents/domain.md)
- [Issue tracker workflow](docs/agents/issue-tracker.md)

## Validation Status

Local package pack、`.tgz` 的 `omw` bin resolution，以及指定的人工本機流程已有證據；public npm publication、`npx @sevenflanks/omw` end-to-end、真實 Manager 的完整 Web walkthrough、Tailnet 與真手機仍不可由本文件或圖表推定完成。精確界線見[使用手冊的驗收證據](docs/user-guide.md#validation-status)。
