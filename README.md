# OpenCode Manager Web（OMW）

以手機管理 Windows 本機 OpenCode 執行個體的個人工具。OMW 負責目錄捷徑、程序管理與狀態摘要；
對話及工具互動沿用官方 OpenCode Web。以下 setup/build command 預設從 repository root 執行；
launcher invocation 的 current working directory 另於下方說明。所有 command 只使用 Windows
PowerShell；不需要 npm global install 或修改 `PATH`。

## QuickStart

需求為 Node.js 24 與 npm。`OMW_OPENCODE_EXECUTABLE` 必須指向真正存在的 absolute
`opencode.exe`，不可指向 `.ps1` shim、launcher 或 `node_modules/.bin`。

### 本機 console 初次啟動

第一次 checkout 或 lockfile 變更後安裝依賴，再編譯並啟動。以下使用一個新的 PowerShell
視窗；若已有 OMW 資料，請沿用原本的 `OMW_DATA_DIR`，不要改成新的空目錄：

```powershell
npm ci
npm run build

# 使用同一個 Windows user 的絕對資料目錄；manager 與 launcher terminal 都要重設這一值。
$env:OMW_DATA_DIR = Join-Path $env:LOCALAPPDATA 'OMW'
$env:OMW_OPENCODE_EXECUTABLE = 'C:\path\to\opencode.exe'
$env:OMW_PORT = '4174'
$env:OMW_MANAGER_ORIGIN = 'http://127.0.0.1:4174'
$env:OMW_LAUNCHER_INTEGRATION = '1'

# 只在這個 OMW_DATA_DIR 尚未有 credentials.dpapi 時執行一次。
npm run credentials:setup -w @omw/manager
npm run dev
```

啟動後在本機瀏覽器開啟 **http://127.0.0.1:4174**。點「啟動執行個體」選取既有目錄，
再點「New Session」開始對話。本機模式不提供手機入口；需要遠端使用時，接著設定下方的 Tailnet 模式。

`npm run dev` 仍是 manager 的 development script，會以 Node 啟動 manager，不會註冊 Windows
service 或自動啟動背景服務。credentials setup 只要求 OMW password，並將 OMW Basic credential
與 launcher token 以 current-user DPAPI 寫入 `OMW_DATA_DIR\credentials.dpapi`；不再要求或保存
OpenCode password。已有 credentials 的升級不可重跑 setup，否則會旋轉既有 credential 與 token。

### 免 port TUI 登錄與 `-s`

保持第一個 terminal 的 manager 執行中，開新的 PowerShell terminal，先切到要開啟的 project
目錄。第二個 terminal 必須使用相同的 `OMW_DATA_DIR`、真正的 executable，以及 exact
`OMW_MANAGER_ORIGIN`；這個變數是 origin，不是帶 path 的 URL。`OMW_DATA_DIR` 使用同一個
absolute path，不依 current working directory；已有 `credentials.dpapi` 時不要重新執行 setup。
以 absolute repository path dot-source shell helper，會在**目前這個 PowerShell 視窗**定義 `omw`
function；只維持到這個 PowerShell session 結束，不寫入 PowerShell profile，也不修改 `PATH`、
ExecutionPolicy 或環境變數。若已有同名 alias、function 或 command，helper 會保留原 binding 並明確
失敗；同一份 helper 則可安全重載。以下三種 invocation 擇一執行，不是連續執行：

```powershell
$env:OMW_DATA_DIR = Join-Path $env:LOCALAPPDATA 'OMW'
$env:OMW_OPENCODE_EXECUTABLE = 'C:\path\to\opencode.exe'
$env:OMW_MANAGER_ORIGIN = 'http://127.0.0.1:4174'
$omwRoot = 'C:\path\to\opencode-manager-web'
. (Join-Path $omwRoot 'scripts\omw-shell.ps1')

omw

# 或選擇目前 project 的既有對話：
omw -s 'ses_example'

# 或明確指定另一個 project：
omw 'C:\work\project'
```

若不想定義 `omw` function，仍可直接使用 Node CLI；同樣要使用編譯檔的 absolute path：

```powershell
$launcher = 'C:\path\to\opencode-manager-web\packages\launcher\dist\src\cli.js'
node $launcher
node $launcher -s 'ses_example'
node $launcher 'C:\work\project'
```

關閉目前 PowerShell 視窗會自動移除此 session-only function。若要在視窗仍開啟時提早移除，先以
`(Get-Command omw -CommandType Function).ScriptBlock.File` 確認來源是這份 `scripts\omw-shell.ps1`，
再執行 `Remove-Item Function:\omw`；不要移除其他來源的同名 user binding。

不指定 `--port` 時，launcher 先向 OMW reserve 下一個 fixed-pool port；這個 reservation response
就是 OMW 已確認的 allocation，不另做 health roundtrip，然後才 spawn OpenCode。原始 argv 會保留，
只在沒有對應旗標時附加 `--hostname 127.0.0.1 --port <reserved-port>`。既有 `--port value`、
`--port=value` 不會被替換；`-s value`、`--session value`、`--session=value` 都保留並可選擇
OpenCode TUI 對話。`-s=value` 未被 launcher 辨識時會 fail-open，以完整原始 argv 執行。

`-s` 只是在 OpenCode TUI 選擇 Session，不代表 OMW 已證明 Primary Session Binding。OMW 只有
在該 Instance 有足夠活動證據，或使用者在 Advanced 明確選擇後，才建立或改變 binding；同一
Project 看得見 Session 不等於該 Instance 正在執行它。

手機 Local TUI 與 Web 要有雙向即時更新，必須使用同一個 Instance：先用 `omw` 啟動 TUI，再在
手機對該 Local TUI 按「進入主 Session」。若 Web 先建立 headless Instance，再另起 TUI 以 `-s`
讀取相同 Session，即使 Session 相同也不保證 live event 同步。`-s` 只選擇 Session，不是
attach 到既有 Instance；OMW 不新增跨 Instance 同步。

若 reservation、DPAPI 或 manager 連線失敗，預設 fail-open 仍以完整原始 argv/environment 執行，
不注入旗標也不登錄；只有設定 `OMW_REQUIRED=1` 才會 fail-closed。完整透傳與 fixed-pool 邊界見
[Local TUI launcher contract](docs/security/launcher-contract.md)。

### 選用手機 Tailnet

電腦與手機須登入同一個受控 Tailnet，並具備所需的 HTTPS / MagicDNS 設定。OMW 不會自動部署
Tailscale。先只讀取現況，避免覆寫已有服務；若交由 agent 修改映射，請先授權具體變更範圍。
不要使用 `tailscale serve reset` 或 `clear` 清空設定：

```powershell
# 使用絕對路徑，不依賴 PATH；非預設安裝位置請另設 OMW_TAILSCALE_EXECUTABLE。
$tailscale = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
& $tailscale serve --help
& $tailscale serve status -json
& $tailscale serve get-config --all
```

依[手機驗收操作手冊](docs/security/mobile-acceptance.md)建立並核對映射後，再啟用 remote mode。
下例要求 HTTPS `40443 → http://127.0.0.1:40443`，以及 HTTPS `40444–40463 → 各自同號的
http://127.0.0.1:<port>`。這些是範例 port，仍須確認你電腦上可綁定、沒有既有服務衝突或
Windows 保留範圍；不是每台電腦都保證可用。先停止原 Manager，再在它的 terminal 執行：

```powershell
$env:OMW_DATA_DIR = Join-Path $env:LOCALAPPDATA 'OMW'
$env:OMW_OPENCODE_EXECUTABLE = 'C:\path\to\opencode.exe'
$env:OMW_PORT = '40443'
$env:OMW_MANAGER_ORIGIN = 'http://127.0.0.1:40443'
$env:OMW_REMOTE_ACCESS = '1'
$env:OMW_EXPECTED_LOOPBACK_ORIGIN = 'http://127.0.0.1:40443'
$env:OMW_TAILNET_DNS_HOST = 'my-pc.example.ts.net'
$env:OMW_MANAGER_PUBLIC_HTTPS_PORT = '40443'
$env:OMW_INSTANCE_PUBLIC_PORT_MIN = '40444'
$env:OMW_INSTANCE_PUBLIC_PORT_MAX = '40463'
$env:OMW_REMOTE_MAPPING_READY = '1' # 只在人工核對所有 Serve mapping 後設定
$env:OMW_LAUNCHER_INTEGRATION = '1'
npm run dev
```

將 `my-pc.example.ts.net` 換成自己的完整、小寫 Tailscale DNS hostname，不包含 `https://`、port
或路徑。手機開啟 `https://my-pc.example.ts.net:40443`，輸入 setup 時建立的 OMW 帳密。
也可從 OMW 的連線區塊複製已設定的手機入口，或使用瀏覽器支援的系統分享。

**另一個 launcher terminal 也要改成同一個 Manager port**，並沿用相同的絕對資料目錄：

```powershell
$env:OMW_DATA_DIR = Join-Path $env:LOCALAPPDATA 'OMW' # 已有資料時改回原本目錄
$env:OMW_OPENCODE_EXECUTABLE = 'C:\path\to\opencode.exe'
$env:OMW_MANAGER_ORIGIN = 'http://127.0.0.1:40443'
. 'C:\path\to\opencode-manager-web\scripts\omw-shell.ps1'
omw
# 要接續已存在的對話，改用同一指令加上 -s 'ses_example'。
```

安全入口只有 Tailnet-only Tailscale Serve HTTPS 與 OMW Basic；Managed OpenCode endpoint 不另設
Basic，但仍須依 Tailnet device policy 限制 user devices。不得啟用 Funnel。`OMW_REMOTE_MAPPING_READY=1`
是你已核對映射的設定聲明，不能取代實際檢查。UI 會只讀查詢本機 Tailscale 在線狀態與 Serve
映射，顯示檢查時間；「映射吻合」仍不保證手機的 Tailnet 權限、TLS 或實際連通性。請以真手機
確認登入、New Session 與送出訊息，不能以桌面畫面或設定值取代。
詳細人工步驟見 [手機驗收操作手冊](docs/security/mobile-acceptance.md) 與
[Tailnet access contract](docs/security/tailnet-access.md)。

### 更新、停止與資料

更新時，在原本的 Manager terminal 按 `Ctrl+C`，保留該視窗的環境設定、資料目錄與 credentials。
不要為了更新 Manager 而停止獨立執行中的 OpenCode Instance。從 repository root 執行：

```powershell
npm ci
npm run build
npm run dev
```

若另開 terminal，請重設先前所用的整組環境變數，包括 remote mode 與實際 port；不要將正在使用
`40443` 的部署換回本機範例的 `4174`。Manager 會重新核對紀錄中的 process 身分，不會只憑 PID
或 port 接管程序。

`OMW_DATA_DIR` 會保留 SQLite database、registry 與同一 Windows user 的 DPAPI ciphertext；
credentials 不是 portable file，換 user 或搬到另一台機器不能直接使用。既有 `credentials.dpapi`
不需要重新 setup 或 rotation。OMW 不提供 reset/clear 作為更新或停止步驟，也不會因 Stop tracking
刪除 Project files 或 OpenCode Session。

## Session 綁定

OMW 會為每個 Instance 維護獨立的 Primary Session Binding。第一次由該 Instance 觀測到足夠的
活動證據時，才會將證據所屬的 root Session 綁定；閒置、其他 Instance 的活動與同 Project
歷史 metadata 不會自動改綁。需要指定歷史 Session 時，請使用 OMW 的 Advanced 手動選擇；
建立新的對話則使用 OMW New Session。

Overview 會以完整 Project 目錄分組，顯示資料夾名稱與 path；每個 Instance 子列顯示 `#PID` 與
primary 最新 title，未知 PID 不會虛構。`已失聯` 不等於 `已停止`：使用者明確確認時可由新的
headless Instance 接續相同 primary，但不會停止舊 Instance 或自動導向 LLM／TUI；停止追蹤只隱藏
OMW tracking record，不會 kill process 或刪除 OpenCode Session。

完整的 API、失聯與停止狀態邊界，以及已驗證的行為證據，見
[開發說明的 Primary Session Binding contract](docs/development.md#primary-session-binding-contract)。

API 與本機資料位置詳見 [開發說明](docs/development.md)。Runtime 預設只監聽 loopback；已實作
核准的 OMW Basic auth、current-user DPAPI credential contract 與 remote URL validation，但不會
自行設定 Tailscale、Firewall、PATH 或 production secrets。未設定 `OMW_REMOTE_ACCESS=1` 時維持
loopback 開發模式，不會自動建立對外入口。

- [MVP 規格](https://github.com/Sevenflanks/opencode-manager-web/issues/1)
- [工作票索引](docs/specs/omw-mvp-work-plan.md)
- [領域詞彙](CONTEXT.md)
- [文件與研究物件盤點](docs/project-inventory.md)
- [Phase-1 歷史研究歸檔](docs/archive/phase1/README.md)
