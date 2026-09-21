# OpenCode Manager Web (OMW)

OMW 是 Windows 本機的 OpenCode 管理介面，提供 `omw` CLI 與 Web UI，用來檢視 Project、Instance 與 Session，並啟動 OMW 管理的背景 OpenCode Instance。

OMW 是 source-available software，不是 OSI 定義的 open source software。使用前請閱讀 [Sustainable Use License 1.0](LICENSE.md)。

## Requirements

- Windows 11
- PowerShell 7，且 `pwsh.exe` 可由 `PATH` 找到（不是 Windows PowerShell 5.1 的 `powershell.exe`）。OMW launcher 與 Manager runtime 預設使用此命令；若需指定位置，可在啟動 OMW process 的環境設定 `OMW_POWERSHELL_EXECUTABLE`。此設定只覆蓋 OMW runtime 內採用它的 PowerShell 呼叫，不會覆蓋其他 scripts 或手動指令。
- Node.js 24 以上與 npm
- 已安裝的 OpenCode CLI

OMW 不會安裝 OpenCode，也不會修改 `PATH`。如果 OMW 無法找到真正的 `opencode.exe`，請將 `OMW_OPENCODE_EXECUTABLE` 設為該執行檔的絕對路徑。

## Install

從 public npm registry 安裝固定版本：

```powershell
npm install --global @sevenflanks/omw@0.1.0
```

也可以不做 global install，直接執行固定版本：

```powershell
npm exec --yes --package=@sevenflanks/omw@0.1.0 -- omw
```

## Start CLI And Web

Global install 後執行：

```powershell
omw
```

第一次執行會在互動式終端要求建立 OMW 帳號與至少 16 個字元的密碼。成功後終端會顯示 Web 管理介面的 loopback URL，預設為 `http://127.0.0.1:4174`。Plain `omw` 只會初始化、啟動或重用 Manager，不會啟動 OpenCode TUI。

OMW 將 credentials、SQLite 與其他持久資料放在 `%LOCALAPPDATA%\OMW`。Credentials 使用 Windows current-user DPAPI 保護。

## Start OpenCode Through OMW

在目前目錄啟動 Local TUI Instance：

```powershell
omw opencode
```

指定 Project 與既有 Session：

```powershell
omw opencode 'C:\develop\projects\example' -s '<session-id>'
```

OMW 不會攔截原生 `opencode`。只有 `omw opencode ...` 會進入 OMW wrapper。

## License

OMW-authored software 使用 [Sustainable Use License 1.0](LICENSE.md)：允許自己的內部業務、個人及非商業用途；散布或提供給他人須免費且為非商業目的。完整邊界以授權正文為準。

第三方元件仍依其各自權利人提供的原始授權條款使用。Web browser assets 會把第三方程式碼包進單一 bundle，因此套件隨附的 [Third-Party Notices](THIRD_PARTY_NOTICES.md) 會保守涵蓋 Web production dependency closure，並保留實際上游套件中的完整授權及適用 notice。未包進 Web assets 的 npm runtime dependencies 則由各自安裝的 package 提供 license metadata 與授權文件。

Source: <https://github.com/Sevenflanks/opencode-manager-web>
