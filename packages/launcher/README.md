# OpenCode Manager Web (OMW)

OMW 補足 OpenCode 缺少的整機管理與 Remote 控制一環：它在 Windows 主機集中管理 Project、Instance 與 Session，並可透過自動註冊 Tailscale Serve，讓使用者從瀏覽器開啟 OMW Web 與 OpenCode Web。

- 從 Web UI 查看 Instance 與 Session，或啟動 OMW 管理的背景 Instance。
- 本機預設維持 loopback-only；遠端模式沿用你自行安裝並登入的 Tailscale。
- 不攔截原生 `opencode`；只有明確使用 OMW wrapper 的命令會納入管理。

OMW 是 source-available software，不是 OSI 定義的 open source software。使用前請閱讀 [Sustainable Use License 1.0](LICENSE.md)。

## Requirements

- Windows 11。
- PowerShell 7，且 `pwsh.exe` 可由 `PATH` 找到。
- Node.js 24 以上與 npm。
- 已安裝的 OpenCode CLI。
- 遠端使用另需在 OMW 主機與訪問裝置自行安裝 Tailscale、登入同一個 Tailnet，並確認裝置有存取權。

OMW 不會安裝 OpenCode 或 Tailscale，也不會修改 `PATH`。

## Quick Start

1. 在 PowerShell 啟動 OMW：

```powershell
npx @sevenflanks/omw@latest
```

第一次執行時，npm 可能詢問是否下載 `@sevenflanks/omw`；確認後繼續。

2. 依提示建立 OMW 使用者名稱與至少 16 個字元的密碼。
3. 開啟終端顯示的 URL。

終端先顯示 `OMW CLI version: <package version>`，再顯示 `OMW Manager ready: http://127.0.0.1:4174 (version <runtime version>, <started|reused|upgraded>)`（port 可能不同），且瀏覽器可開啟登入頁，即代表 Manager 已就緒。再次執行新版 CLI 時，OMW 會正常關閉並接替較舊或尚未回報版本的 Manager；相同或較新版則直接重用，不會降版。這個 plain Manager 命令不會啟動 OpenCode TUI。

只查詢已安裝的 OMW CLI 版本、不啟動 Manager，可使用單一版本旗標：

```powershell
omw --version
omw -v
```

兩者都會只輸出 `<package version>` 並以成功狀態結束。

OMW 將 credentials、SQLite 與其他持久資料放在 `%LOCALAPPDATA%\OMW`。Credentials 使用 Windows current-user DPAPI 保護。

## Remote Access

1. 在 OMW 主機與訪問裝置自行安裝 Tailscale，登入同一個 Tailnet，並確認 Tailnet policy 允許存取。
2. 從本機 OMW UI 頁面上方的 `TAILNET / SERVE` 區塊按下 `啟用遠端存取`，閱讀存取範圍說明後以目前 OMW 帳密確認。
3. OMW 會使用已登入主機的 Tailnet DNSName，自動註冊 OMW Web 與 Instance port 的 Tailscale Serve mappings。
4. 確認畫面顯示可用的遠端 URL，再從有存取權的 Tailnet 裝置開啟。若註冊失敗，依畫面診斷修正後按 `自動註冊` 重試。

OMW 不會安裝或登入 Tailscale、不會啟動 OS service，也不會開啟 public Funnel。OpenCode ports 沒有額外 OMW 帳密保護，請維持 Tailnet-only 並限制裝置存取。

## Start OpenCode Through OMW

在目前目錄啟動 Local TUI Instance：

```powershell
npx @sevenflanks/omw@latest opencode
```

指定 Project 與既有 Session：

```powershell
npx @sevenflanks/omw@latest opencode 'C:\develop\projects\example' -s '<session-id>'
```

OMW 不會攔截原生 `opencode`。只有 `npx @sevenflanks/omw@latest opencode ...` 會進入 OMW wrapper。

## Optional Global Install

若希望提供全域 `omw` 命令，可安裝目前最新版：

```powershell
npm install --global @sevenflanks/omw@latest
omw
```

後續可使用 `omw opencode ...`。Global install 與 `npx` 使用同一份 `%LOCALAPPDATA%\OMW` 日常資料。

## Troubleshooting

若 `pwsh.exe` 不在 `PATH`，可在啟動 OMW 的環境指定 PowerShell 7：

```powershell
$env:OMW_POWERSHELL_EXECUTABLE = 'C:\Program Files\PowerShell\7\pwsh.exe'
npx @sevenflanks/omw@latest
```

若 OMW 無法找到真正的 `opencode.exe`，請指定可信任 executable 的絕對路徑：

```powershell
$env:OMW_OPENCODE_EXECUTABLE = 'C:\path\to\opencode.exe'
npx @sevenflanks/omw@latest
```

## License

OMW-authored software 使用 [Sustainable Use License 1.0](LICENSE.md)：允許自己的內部業務、個人及非商業用途；散布或提供給他人須免費且為非商業目的。完整邊界以授權正文為準。

第三方元件仍依其各自權利人提供的原始授權條款使用。Web browser assets 會把第三方程式碼包進單一 bundle，因此套件隨附的 [Third-Party Notices](THIRD_PARTY_NOTICES.md) 會保守涵蓋 Web production dependency closure，並保留實際上游套件中的完整授權及適用 notice。未包進 Web assets 的 npm runtime dependencies 則由各自安裝的 package 提供 license metadata 與授權文件。

Source: <https://github.com/Sevenflanks/opencode-manager-web>
