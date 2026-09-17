# Local TUI launcher 與固定 port pool 契約

## 範圍

`omw-opencode` 是 OpenCode root TUI 的 opt-in launcher。它不取代 `opencode`、不修改
`PATH`、不設定 Tailscale Serve 或 Firewall，也不讓 OMW 取得 Local TUI 的 Stop authority。
Manager-launched headless Instance 與已登錄的 Local TUI Instance 共用一個以 registry 為準的
loopback fixed port pool。

Manager 只有在 `OMW_LAUNCHER_INTEGRATION=1` 時提供 launcher API。本機開發使用與 remote
access 相同的 Windows current-user DPAPI 檔案；啟用 launcher 不會同時啟用 browser Basic
auth 或 public Manager listener。

## 命令與參數透傳

- `OMW_OPENCODE_EXECUTABLE` 必須是存在的 absolute real executable，且不可解析回 launcher。
  Manager 登錄 PID 時會獨立核對同一 executable。
- `completion`、`mcp`、`run`、`serve` 等已知 OpenCode subcommand，以及 `--help`、`--version`，
  都以原始 argv 直接執行，不登錄。只有 root TUI invocation 可進 managed flow。
- `--port 42001` 與 `--port=42001` 都會保留原形式與數值。explicit port 衝突或不在 fixed pool
  時不會偷偷替換；未提供 port 才附加 `--port <reserved-port>`。
- 未提供 hostname 時附加 `--hostname 127.0.0.1`。兩種形式的 explicit
  `--hostname 127.0.0.1` 都原樣保留。其他 hostname（包含 `0.0.0.0`）會明示 bypass，使用
  原始 argv 啟動且不登錄，絕不呈現為 managed remote endpoint。
- Managed child 使用實際 invocation cwd、`stdio: "inherit"`、`shell: false`、
  `detached: false`、`windowsHide: false`。OpenCode Basic credentials 只放在 child environment，
  不進 argv 或 diagnostics。一般 exit code 原樣回傳；只有 child 以 signal 結束時換算成
  `128 + signal number`。

若 DPAPI、authentication、reservation 或 Manager 連線失敗，launcher 只輸出一則有長度上限
且已遮蔽敏感值的診斷，然後用原始 argv/environment 啟動 real executable。這個 process 不登錄、
不對外宣告，也不可由 OMW Stop。`OMW_REQUIRED=1` 只把此 Manager integration failure 改成
exit 70；它不會把 unsupported hostname 或 subcommand 強制納入 managed flow。

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
