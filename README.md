# OpenCode Manager Web (OMW)

OMW 補足 OpenCode 缺少的整機管理與 Remote 控制一環：它在 Windows 主機集中管理 Project、Instance 與 Session，並可透過自動註冊 Tailscale Serve，讓使用者從瀏覽器開啟 OMW Web 與 OpenCode Web。

- 集中檢視多個專案、執行個體與對話狀態。
- 從瀏覽器啟動背景 OpenCode，並進入官方 OpenCode Web 繼續工作。
- 自行安裝並登入 Tailscale 後，透過手機或另一台電腦的瀏覽器遠端管理。

## Screenshots

### 集中掌握工作狀態

Overview 集中呈現多個 Project、Instance 與主要 Session，方便快速掌握目前工作狀態。

![OMW Overview：Project、Instance 與主要 Session](docs/images/issue11-overview-details-desktop.png)

### 從瀏覽器啟動背景 OpenCode

從啟動面板選擇 Project 目錄，建立可在官方 OpenCode Web 繼續操作的背景 Instance。

![從 OMW Web 選擇目錄並啟動背景 Instance](docs/images/issue11-start-instance-panel-desktop.png)

> [!NOTE]
> 畫面使用示範資料（正式 Web UI 搭配 mock backend），供介面預覽；不代表真實 Tailnet 或手機端驗收。

## Prerequisites

- Windows 11。
- PowerShell 7，且 `pwsh.exe` 可由 `PATH` 找到。
- Node.js 24 以上與 npm。
- 已安裝的 OpenCode CLI。
- 遠端使用另需在 OMW 主機與訪問裝置自行安裝 Tailscale、登入同一個 Tailnet，並確認裝置有存取權。

OMW 不會安裝 OpenCode 或 Tailscale，也不會修改 `PATH`。

## Quick Start

1. 在日常使用的 PowerShell 啟動 OMW：

```powershell
npx @sevenflanks/omw@latest
```

第一次執行時，npm 可能詢問是否下載 `@sevenflanks/omw`；確認後繼續。

2. 依提示建立 OMW 使用者名稱與至少 16 個字元的密碼。
3. 開啟終端顯示的 URL，例如 `http://127.0.0.1:4174`；實際 port 可能不同。

終端顯示 `OMW Manager ready: http://127.0.0.1:4174 (version <runtime version>, <started|reused|upgraded>)` 且瀏覽器可開啟登入頁，即代表 Manager 已就緒。再次執行新版 CLI 時，OMW 會正常關閉並接替較舊或尚未回報版本的 Manager；相同或較新版則直接重用，不會降版。這個 plain Manager 命令不會啟動 OpenCode TUI。

OMW 的日常 credentials、SQLite 與其他持久資料位於 `%LOCALAPPDATA%\OMW`。Repository development 必須改用[隔離的開發入口](docs/development.md#quick-start)，不要讓開發環境讀寫日常資料。

## Remote Access

1. 在 OMW 主機與要訪問的電腦或手機自行安裝 Tailscale，登入同一個 Tailnet，並確認 Tailnet policy 允許裝置存取這台主機。
2. 先從本機 URL 登入 OMW，在頁面上方的 `TAILNET / SERVE` 區塊按下 `啟用遠端存取`，閱讀存取範圍說明後以目前 OMW 帳密確認。
3. OMW 會使用已登入主機的 Tailnet DNSName，自動註冊 OMW Web 與 Instance port 的 Tailscale Serve mappings；它不會安裝 Tailscale、代替你 login/up、啟動 OS service，或開啟 public Funnel。
4. 確認畫面顯示可用的遠端 URL，再從有存取權的 Tailnet 裝置開啟。若註冊失敗，依畫面診斷修正 Tailscale 狀態或 mapping 衝突後按 `自動註冊` 重試。

Manager 與 OpenCode process 仍只 bind `127.0.0.1`。OpenCode ports 沒有額外 OMW 帳密保護，因此必須維持 Tailnet-only、限制裝置存取，且不得啟用 Funnel。詳細安全邊界與排障見 [Tailnet access runbook](docs/security/tailnet-access.md)。

## Start OpenCode Through OMW

在要工作的 Project 目錄啟動 Local TUI Instance：

```powershell
npx @sevenflanks/omw@latest opencode
```

指定 Project 與既有 Session：

```powershell
npx @sevenflanks/omw@latest opencode 'C:\develop\projects\example' -s '<session-id>'
```

OMW 不會攔截原生 `opencode`。只有 `npx @sevenflanks/omw@latest opencode ...` 會進入 OMW wrapper；若 wrapper bootstrap 失敗，預設可能明示診斷後繼續啟動未受管理的 native OpenCode。完整使用方式、fail-open 與三種不同停止語意見[使用手冊](docs/user-guide.md)。

## Other Installation Options

若希望提供全域 `omw` 命令，可選擇安裝目前最新版：

```powershell
npm install --global @sevenflanks/omw@latest
omw
```

之後可使用 `omw opencode ...`。Global install 與 `npx` 使用同一份 `%LOCALAPPDATA%\OMW` 日常資料。

只有需要從目前 repository 建置或驗證 package 時，才在 repository root 建立本機 artifact：

```powershell
npm ci
$packageDir = Join-Path $env:TEMP 'omw-local-package'
New-Item -ItemType Directory -Force -Path $packageDir | Out-Null
$packageName = npm pack --pack-destination $packageDir -w @sevenflanks/omw | Select-Object -Last 1
$omwPackage = Join-Path $packageDir $packageName
npm exec --yes --package="$omwPackage" -- omw
```

這條本機 artifact 路徑仍連到日常 `%LOCALAPPDATA%\OMW`，不可拿來取代 repository 的隔離開發入口。

## Troubleshooting

若 `pwsh.exe` 不在 `PATH`，可在啟動 OMW 的環境指定 PowerShell 7：

```powershell
$env:OMW_POWERSHELL_EXECUTABLE = 'C:\Program Files\PowerShell\7\pwsh.exe'
npx @sevenflanks/omw@latest
```

更多 executable、port、連線與停止語意見[使用手冊的 Troubleshooting](docs/user-guide.md#troubleshooting)。

## Documentation

- [使用手冊](docs/user-guide.md)
- [Technical Reference](docs/reference.md)
- [架構圖與流程圖](docs/reference.md#diagrams)
- [Development](docs/development.md)
- [Release process](docs/releasing.md)
- [Launcher and authentication contract](docs/security/launcher-contract.md)
- [Tailnet access runbook](docs/security/tailnet-access.md)
- [Mobile acceptance checklist](docs/security/mobile-acceptance.md)
- [Domain model](docs/agents/domain.md)

## Validation Status

目前驗收證據與適用範圍請見[使用手冊的 Validation Status](docs/user-guide.md#validation-status)。

## License

OMW-authored software 使用 [Sustainable Use License 1.0](LICENSE.md)，是 source-available software，不是 OSI 定義的 open source software。第三方元件仍使用各自權利人提供的原始授權。
