# OpenCode Manager Web (OMW)

OMW 是 Windows 本機的 OpenCode 管理介面，用來檢視 Project、Instance 與 Session，並啟動 OMW 管理的背景 OpenCode Instance。

> [!IMPORTANT]
> `@sevenflanks/omw@0.1.0` 已發布至 public npm registry；Quick Start 優先使用 exact-version global install。原始碼／本機 `.tgz` 仍保留為替代路徑；已發布 package 的 fresh consumer 安裝與 CLI/Manager/Web smoke 見[release verification 紀錄](docs/acceptance/release-verification-0.1.0-2026-09-21.md)。
>
> Published package 的 global `omw` 是日常／configured product flow，會使用 `%LOCALAPPDATA%\OMW`；原始碼／本機 package 替代路徑也會連到同一份日常資料。Repository development 必須改用[隔離的開發入口](docs/development.md#quick-start)，避免讀寫日常 credentials、token、SQLite 與 OpenCode data。

## Prerequisites

- Windows 11
- PowerShell 7，且 `pwsh.exe` 可由 `PATH` 找到
- Node.js 24 以上與 npm
- 已安裝的 OpenCode CLI
- 本 repository 的本機 checkout（僅原始碼／本機 artifact 替代路徑需要）

## Quick Start

日常使用約 3 步：

1. 在 PowerShell 安裝固定版本：

```powershell
npm install --global @sevenflanks/omw@0.1.0
```

2. 啟動 OMW：

```powershell
omw
```

3. 第一次執行時建立 OMW 帳密，然後開啟終端顯示的 URL。

**完成指標：**終端顯示 `OMW Manager ready: http://127.0.0.1:4174`（port 可能不同），瀏覽器可開啟登入頁。Plain `omw` 不會啟動 OpenCode TUI。

Global install 是建議的正式使用路徑。本次 [release verification](docs/acceptance/release-verification-0.1.0-2026-09-21.md) 已驗證 public registry 的 exact-version fresh consumer 安裝與 CLI/Manager/Web smoke，但未將 global install 本身宣稱為已單獨測試。

## Usage

1. 在要工作的 Project 目錄啟動 OpenCode：

```powershell
omw opencode
```

2. 需要指定 Project 與既有 Session 時執行：

```powershell
omw opencode 'C:\develop\projects\example' -s '<session-id>'
```

OMW 不會安裝 OpenCode、修改 `PATH` 或攔截原生 `opencode`。只有 `omw opencode ...` 進入 wrapper。完整操作、不同停止語意、資料保留與問題排除見[使用手冊](docs/user-guide.md)。

## 原始碼／本機 artifact 替代路徑

只有需要從目前 repository 建置或驗證 package 時，才在 repository root 執行：

```powershell
npm ci
$packageDir = Join-Path $env:TEMP 'omw-local-package'
New-Item -ItemType Directory -Force -Path $packageDir | Out-Null
$packageName = npm pack --pack-destination $packageDir -w @sevenflanks/omw | Select-Object -Last 1
$omwPackage = Join-Path $packageDir $packageName
npm exec --yes --package="$omwPackage" -- omw
```

這條路徑使用與 global `omw` 相同的日常 `%LOCALAPPDATA%\OMW` 資料。後續命令請將 `omw` 替換為 `npm exec --yes --package="$omwPackage" -- omw`；repository development 不可使用這條路徑。

## Troubleshooting

若 `pwsh.exe` 不在 `PATH`，可在啟動 OMW 的環境指定 PowerShell 7：

```powershell
$env:OMW_POWERSHELL_EXECUTABLE = 'C:\Program Files\PowerShell\7\pwsh.exe'
omw
```

此設定只覆蓋 OMW runtime 內採用它的 PowerShell 呼叫，不會改變其他 scripts 或手動指令。更多 executable、port 與連線問題見[使用手冊的 Troubleshooting](docs/user-guide.md#troubleshooting)。

## Architecture

![OMW 本機與 Tailnet 架構](docs/diagrams/omw-architecture.svg)

[HTML source](docs/diagrams/omw-architecture.html)

![OMW 啟動、重用與失敗處理](docs/diagrams/omw-startup-flow.svg)

[HTML source](docs/diagrams/omw-startup-flow.html)

![OMW 三種停止操作](docs/diagrams/omw-stop-semantics.svg)

[HTML source](docs/diagrams/omw-stop-semantics.html)

## Development

Repository 開發、測試與驗收使用 worktree-local 或 fresh temporary isolation，不使用上述日常 package 命令。從[開發說明的 Quick Start](docs/development.md#quick-start)開始。

## License

OMW-authored software 使用 [Sustainable Use License 1.0](LICENSE.md)，是 source-available software，不是 OSI 定義的 open source software。第三方元件仍使用各自權利人提供的原始授權。

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

Public npm exact-version publication、fresh consumer install，以及 packaged CLI/Manager/Web smoke 已有證據；local package pack 與 `.tgz` 的 `omw` bin resolution 是原始碼／本機 artifact 替代路徑。`npx @sevenflanks/omw` end-to-end、global install 本身、真實 OpenCode TUI、完整 Web walkthrough、Tailnet 與真手機仍不可由本文件或圖表推定完成。精確界線見[使用手冊的驗收證據](docs/user-guide.md#validation-status)。
