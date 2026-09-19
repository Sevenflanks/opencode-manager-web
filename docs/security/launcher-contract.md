# Local TUI launcher 與固定 port pool 契約

## 範圍

`omw-opencode` 是 OpenCode root TUI 的 opt-in launcher。它不取代 `opencode`、不修改
`PATH`、不設定 Tailscale Serve 或 Firewall，也不讓 OMW 取得 Local TUI 的 Stop authority。
Manager-launched headless Instance 與已登錄的 Local TUI Instance 共用一個以 registry 為準的
loopback fixed port pool。

Manager 只有在 `OMW_LAUNCHER_INTEGRATION=1` 時提供 launcher API。本機開發使用與 remote
access 相同的 Windows current-user DPAPI 檔案；啟用 launcher 不會同時啟用 browser Basic
auth 或 public Manager listener。DPAPI payload 只需要 OMW Basic credential 與 launcher token；
舊 payload 的 `openCode` 欄位相容讀取後會被忽略，不會自動重寫或 rotation。

## Local CLI invocation

從 launcher repository root 執行 `npm ci` 後，先以 `npm run build` 建立 launcher。執行時，
launcher 的 current working directory 預設就是啟動 terminal 的目錄；可在目標 project terminal
使用編譯檔的 absolute path。以下三種 invocation 擇一執行：

```powershell
npm ci
npm run build
$launcher = 'C:\path\to\opencode-manager-web\packages\launcher\dist\src\cli.js'
node $launcher --port 42001
node $launcher
node $launcher -s ses_example
```

上述 invocation 是替代方式，不是連續執行。沒有 project argument 時使用 current working
directory；若需明確指定 project，將 project argument 加到其中一個 invocation。指定 project
argument 時才以該 argument 計算 reservation directory。若另一個
project terminal 直接使用 repository-relative `packages/launcher/dist/src/cli.js`，可能會找錯
file；`$launcher` 的 absolute path 與 project argument 是兩件不同的事。

`node_modules/.bin/omw-opencode.cmd` 只是 npm 在安裝時已能解析 `bin` target 時可能產生的
可選 shim；不應假設它會在 build 前由 `npm ci` 產生，也不需要 npm global install 或修改
`PATH`。

## 命令與參數透傳

- `OMW_OPENCODE_EXECUTABLE` 必須是存在的 absolute real executable，且不可解析回 launcher。
  Manager 登錄 PID 時會獨立核對同一 executable。
- `completion`、`mcp`、`run`、`serve` 等已知 OpenCode subcommand，以及 `--help`、`--version`，
  都以原始 argv 直接執行，不登錄。只有 root TUI invocation 可進 managed flow。
- 未提供 `--port` 的 root TUI invocation 會先向 OMW reserve 下一個 port；reservation response
  就是這次的 OMW allocation confirmation，不再做多餘的 health roundtrip。launcher 會保留 literal
  argv，例如 `-s ses_example C:\work\project`，只附加缺少的 `--hostname 127.0.0.1` 與
  `--port <reserved-port>` 後才 spawn。
- `-s ses_example`、`--session ses_example` 與 `--session=ses_example` 是目前支援的 Session
  syntax；`-s=ses_example` 不在 parser contract 內，會走 fail-open，而不是猜測 native CLI 意義。
  `-s` 只選 OpenCode TUI 對話，不自動建立或證明 OMW Primary Session Binding。
- `--port 42001` 與 `--port=42001` 都會保留原形式與數值。explicit port 衝突或不在 fixed pool
  時不會偷偷替換；未提供 port 才附加 `--port <reserved-port>`。
- 未提供 hostname 時附加 `--hostname 127.0.0.1`。兩種形式的 explicit
  `--hostname 127.0.0.1` 都原樣保留。其他 hostname（包含 `0.0.0.0`）會明示 bypass，使用
  原始 argv 啟動且不登錄，絕不呈現為 managed remote endpoint。
- Managed child 使用實際 invocation cwd、`stdio: "inherit"`、`shell: false`、
  `detached: false`、`windowsHide: false`。成功 reserve 後會複製 parent environment，再明確移除
  `OPENCODE_SERVER_USERNAME` 與 `OPENCODE_SERVER_PASSWORD`；不在 argv 或 diagnostics 傳送 OpenCode
  credential。一般 exit code 原樣回傳；只有 child 以 signal 結束時換算成
  `128 + signal number`。

若 DPAPI、authentication、reservation 或 Manager 連線失敗，launcher 只輸出一則有長度上限
且已遮蔽敏感值的診斷，然後用原始 argv/environment 啟動 real executable。這個 process 不登錄、
不對外宣告，也不可由 OMW Stop。`OMW_REQUIRED=1` 只把此 Manager integration failure 改成
exit 70；它不會把 unsupported hostname 或 subcommand 強制納入 managed flow。
Native bypass 與上述 fail-open 都不清理 user environment，因此 user 自己明示的原生 OpenCode
auth 仍維持原樣；只有成功的 OMW managed launch 會清理兩個 server auth variables。

## Fixed pool 與 reservation

本機 fixed pool 預設為 `42000-42099`，可用成對的 `OMW_INSTANCE_PORT_MIN` 與
`OMW_INSTANCE_PORT_MAX` 調整。Remote mode 直接使用核准的
`OMW_INSTANCE_PUBLIC_PORT_MIN/MAX` 作為 internal pool，因為每個 public HTTPS port 必須映射到
相同編號的 `127.0.0.1` port。pool 最多 128 個 ports，確保能在有界範圍內完整檢查。

SQLite `port_allocations` 是跨 Manager process 的 port authority。port 與 Local TUI invocation
ID 各自有 unique constraint，寫入使用 `BEGIN IMMEDIATE` transaction。每次寫入前先做 OS bind
probe；SQLite 競爭或 OS listener 衝突時，automatic allocation 才會嘗試下一個候選。explicit
port 只有一個候選。

未登錄 reservation 的 TTL 是 10,000 ms。到期不代表可直接重用：Manager 先重新 bind-probe；
若仍有 listener，就延長 10,000 ms 作隔離。registered allocation 只會在 reconcile/finalize
確認 endpoint 不再監聽後釋放。若 startup 沒留下 exact identity，reconcile 不會退化成 PID-only；
startup grace 後 endpoint 仍為 free 才標記 offline 並釋放。已保存 exact identity 的 Instance 只在
inspector 明確確認 PID 不存在且 loopback port 可 bind 時標記 stopped 並釋放 allocation。Inspector
failure、identity mismatch、PID reuse 或 occupied port 一律保留 quarantine，且不能 Stop foreign process。

## Launcher API

Launcher routes 只接受 Manager 設定的 `127.0.0.1:<port>` authority、拒絕任何 browser
`Origin`，並要求 `x-omw-launcher-token`。Browser Basic auth 不能呼叫這些 routes；launcher token
也不能授權 browser routes。未啟用 launcher integration 時 routes 不存在。

上述三個 routes 已由 Manager 提供，並由 `omw-opencode` launcher client 依 reserve、register、
finalize lifecycle 呼叫；它們不是尚未實作的 endpoint，也不提供任意 endpoint 登錄或 process kill。

### Reserve

`POST /api/v1/launcher/reservations`

```json
{
  "clientInvocationId": "launcher 產生的 UUID",
  "directory": "actual invocation cwd",
  "requestedPort": 42001
}
```

`requestedPort` 可省略。response 只含 reservation ID、固定 hostname `127.0.0.1`、port、expiry
與狀態。同一 invocation ID、canonical directory 與 port preference 為冪等；任何差異都回
`INVOCATION_CONFLICT`。request schema 明確拒絕 executable、command、remote endpoint、kill 等
額外欄位。

### Register

`POST /api/v1/launcher/reservations/:id/register`

```json
{ "clientInvocationId": "同一 UUID", "pid": 1234 }
```

launcher 在 foreground child spawn 後呼叫。Manager 從 trusted config 與 reservation 決定
directory、executable、endpoint 與 port；`Describe` 必須證明 PID、creation time、real
executable，且 creation time 不得早於 reservation。readiness、`/path` 與 port-owner 查核在背景
繼續，因此 response 不等待 15 秒 readiness window，也不阻塞 TTY。同一 invocation/PID 重送
為冪等。

### Finalize

`POST /api/v1/launcher/reservations/:id/finalize`

```json
{ "clientInvocationId": "同一 UUID", "pid": 1234 }
```

launcher 會在 child completion 的 `finally` 呼叫；callback failure 只記診斷，不改 TUI exit
code。Manager 絕不 kill Local TUI；只有已登錄 PID 符合且 loopback endpoint 關閉時才釋放
allocation。Manager outage 後由 startup reconcile 使用相同的 exact identity 與 endpoint 規則。

## Remote URL 與 ownership

Local TUI 只可 observe/open，固定回報 `stopAllowed=false`。沒有 launcher route 能 kill process 或
登錄任意 endpoint。若既有 Local TUI port 不在已確認的 remote same-port mapping，UI 保留
loopback record 並顯示 remote URL unavailable 原因，不產生假的 Tailnet URL。

Headless Instance 仍只在 exact PID creation time、executable 與安全 port-owner proof 成立時才是
OMW-owned/stoppable；不可恢復 PID-only 或 broad descendant cleanup。

## 時間界線

- Launcher HTTP request timeout：每次 reserve/register/finalize 1,500 ms。
- Reservation TTL 與 occupied-port quarantine：10,000 ms。
- Pool search：完整候選集合，最多 128 ports。
- Runtime readiness：既有 15,000 ms；Local TUI 在背景執行，headless Start 維持同步。
