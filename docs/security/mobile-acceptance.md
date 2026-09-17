# 手機驗收操作手冊

## 目的與目前狀態

本文件記錄目前由 user 選定的「先完成 PR 部署，再另行進行真實手機驗收」方案。它是操作
步驟，不是 `new deployment automation` 或 `subsystem`。

本輪 agent 尚未執行本機 Tailscale、Firewall、PATH 或 credentials 變更，也未啟動 server。
這是目前工作範圍與狀態，不是永久禁止 agent 協助。未來若 user 對明確且對等的範圍授權，
agent 可在該授權內協助 Serve 操作；password 仍必須由 user 在本機 masked TTY 輸入，agent
不得查看或代持真正 secret。

目前可宣稱的範圍：

| 項目 | 狀態 |
|---|---|
| loopback root-per-port PoC | 已有證據；不是 real Tailscale 驗證 |
| Manager launcher API | 已實作：`/api/v1/launcher/reservations`、`/api/v1/launcher/reservations/:id/register`、`/api/v1/launcher/reservations/:id/finalize` |
| 真實 Windows Tailscale Serve/TLS | UNKNOWN，尚未驗證 |
| 真實手機端到端 | UNKNOWN，尚未驗證 |
| CMD／PowerShell TTY、Ctrl+C、resize、ANSI、exit code | UNKNOWN；#7 的交互 manual check 尚未完成 |
| Firewall、PATH、ACL 與 production secret | NOT VERIFIED；本輪未修改 |

不可把 loopback proxy PoC 說成 real Tailscale 已驗證，也不可把桌面 browser、模擬 viewport
或既有測試證據當成真實手機驗收。

## 部署順序

以下順序是未來由 user／operator 依當時授權執行的規劃流程。本輪只修正文檔，不執行
其中任何 command。

### 1. 讀取既有 Serve mappings 並核對 target ports

任何變更前先讀取既有 mappings，並保存遮蔽後的核對結果：

```powershell
tailscale serve --help
tailscale serve status -json
tailscale serve get-config --all
```

`tailscale serve --help` 確認 `--bg`、`--https`、`status`、`get-config` 與 `off` 的 CLI
介面；官方文件確認 `http://127.0.0.1` 是 local reverse-proxy target。保存結果時遮蔽
裝置 DNS、username、credentials 與 private path。

先查核預定的對外 HTTPS ports `443`、`42000-42003` 及其 target：

- 既有 entry 若位於預定 port，先比對 target；target 不符時停止，不覆寫。
- 只有不存在且不衝突的 entry 才可在下一步新增；既有 Serve mappings 必須完整保留。
- 不使用 `tailscale serve reset`、`clear` 或任何清整整個 node 的指令。

官方參考：

- [Tailscale `serve` CLI reference](https://tailscale.com/docs/reference/tailscale-cli/serve.md)
- [Tailscale Services configuration](https://tailscale.com/docs/features/tailscale-services.md)

### 2. 以同一 `OMW_DATA_DIR` 建立 credentials

user 先明示同一個 `OMW_DATA_DIR` 與實際的 OpenCode 執行檔，再由 user 在本機 masked TTY
執行 credentials setup：

```powershell
$env:OMW_DATA_DIR = '<OMW_DATA_DIR>'
$env:OMW_OPENCODE_EXECUTABLE = '<absolute-opencode.exe>'
npm run credentials:setup -w @omw/manager
```

`credentials:setup` 會以 masked input 取得 OMW 與 OpenCode passwords，隨機產生 launcher
token 且不顯示，並將 Windows 目前使用者的 DPAPI ciphertext 寫入同一個
`<OMW_DATA_DIR>/credentials.dpapi`。之後啟動 Manager 或 launcher 時，必須再次明示相同的
`OMW_DATA_DIR`；若在不同 shell 或不同 current working directory 執行，仍要重新設定，避免
credentials 寫到一個目錄而執行環境從另一個目錄載入。

本流程不查看、不寫入、不回報真正 password、launcher token 或 DPAPI plaintext；不得將它們
放入 command argv、受版本控制的檔案、URL、log 或未清理的 HAR。

### 3. 新增沒有衝突的 Serve entries

確認既有 mappings 已保留，且 user 已對這個明確範圍授權後，才可用官方 CLI 形式新增
不存在的 entries：

```powershell
tailscale serve --bg --https=443 http://127.0.0.1:4310
tailscale serve --bg --https=42000 http://127.0.0.1:42000
tailscale serve --bg --https=42001 http://127.0.0.1:42001
tailscale serve --bg --https=42002 http://127.0.0.1:42002
tailscale serve --bg --https=42003 http://127.0.0.1:42003
```

OMW 使用對外 HTTPS port `443`，Manager loopback example 使用 `4310`；OpenCode 使用
`42000-42003` 的 fixed same-port pool。這些 commands 只可新增不存在的 mapping，不得重新
指向原有 entry，也不開啟 Funnel、公開網際網路或 Firewall rule。

### 4. 從 Serve config 核對 `OMW_REMOTE_MAPPING_READY`

新增完成後，重新讀取 Serve config：

```powershell
tailscale serve status -json
tailscale serve get-config --all
```

只有在每個預定 public port、`http://127.0.0.1:<port>` target、HTTPS 與 `tailnet only` 狀態
都已由 user／operator 核對後，才可在即將啟動 Manager 的同一 shell 設定：

```powershell
$env:OMW_REMOTE_MAPPING_READY = '1'
```

這個 flag 只表示 Serve mapping 已核對，不表示 Basic auth、CSRF、手機、TTY 或整體安全
驗收已通過。它必須在 Manager startup 前設定，避免 Manager 先因缺少 flag fail closed 而
形成循環；若 mapping 尚未核對，就不要啟動 remote mode Manager。

### 5. 設定 remote mode 與 launcher integration

在同一 shell 明示完整 remote mode 設定，並保持與 credentials setup 相同的 data directory：

```powershell
$env:OMW_DATA_DIR = '<OMW_DATA_DIR>'
$env:OMW_OPENCODE_EXECUTABLE = '<absolute-opencode.exe>'
$env:OMW_PORT = '4310'
$env:OMW_REMOTE_ACCESS = '1'
$env:OMW_EXPECTED_LOOPBACK_ORIGIN = 'http://127.0.0.1:4310'
$env:OMW_TAILNET_DNS_HOST = '<device>.<tailnet>.ts.net'
$env:OMW_MANAGER_PUBLIC_HTTPS_PORT = '443'
$env:OMW_INSTANCE_PUBLIC_PORT_MIN = '42000'
$env:OMW_INSTANCE_PUBLIC_PORT_MAX = '42003'
$env:OMW_REMOTE_MAPPING_READY = '1'
# 若這次 remote flow 要使用 launcher，才必須加入：
$env:OMW_LAUNCHER_INTEGRATION = '1'
```

`OMW_PORT` 的 server default 是 `4174`；上例使用 `4310`，所以必須明示設定，不能把
`4310` 當成 default。若一般 remote flow 需要 launcher API，`OMW_LAUNCHER_INTEGRATION=1`
也必須加入；不使用 launcher 時不要誤稱 launcher routes 已啟用。所有 required env、DPAPI
file、real executable、authority 與 mapping gate 都要在啟動前完成。

### 6. 在設定完成後啟動 Manager

這是規劃 command，僅由 user／operator 在前述步驟完成且取得授權後執行；本輪 agent 不
啟動 server：

```powershell
npm run dev -w @omw/manager
```

### 7. 逐項進行 positive、negative、UI 與手機驗收

每一項都要在真實手機、受控 Tailnet 與實際 device 上記錄 `PASS`、`FAIL` 或 `UNKNOWN`。
沒有證據就保持 `UNKNOWN`，不可由 PoC 或 desktop 結果推導 PASS。

| 檢查項目 | 預期 | 結果 |
|---|---|---|
| Tailnet membership | 手機是受控 Tailnet member，能以 HTTPS 連到 OMW | UNKNOWN |
| TLS 與 authority | public origin 與 certificate/hostname 符合預期，不接受 loopback URL | UNKNOWN |
| 正確 Basic auth | 使用正確 OMW Basic credentials 可登入 browser route | UNKNOWN |
| 缺少 Basic auth | 沒有 `Authorization` 的 browser request 被拒絕並回 `401`／challenge | UNKNOWN |
| 錯誤 Basic auth | 錯誤 username/password 被拒絕並回 `401`，不洩露內部細節 | UNKNOWN |
| 錯誤 `Origin` | browser mutation 帶不受信任 `Origin` 時被拒絕 | UNKNOWN |
| 缺少或錯誤 CSRF | mutation 缺少或帶錯 `x-omw-csrf` 時被拒絕 | UNKNOWN |
| launcher audience 分離 | Browser Basic auth 不能呼叫 launcher routes；launcher token 不能呼叫 browser routes | UNKNOWN |
| Secret handling | 不保存或公開含敏感 header 的 network HAR 或 log；若必須保留 HAR，先移除 `Authorization`、`x-omw-launcher-token` 等敏感 headers | UNKNOWN |
| Funnel 與 public internet | 未啟用 `tailscale funnel`；入口只可由 Tailnet 存取 | UNKNOWN |
| Firewall | 沒有新增或修改 Firewall rule | UNKNOWN |
| Manager UI | 手機可看到真實 Shortcut、Instance lifecycle、health 與 unknown state | UNKNOWN |
| Instance endpoint isolation | 一個 Instance 的 endpoint 運行態不可與另一個 Instance 混用；同一 Project 的 Session metadata 合法共享，不算跨 Instance 洩漏 | UNKNOWN |
| Session 與 Open Web | 明確選擇 Session 後才開啟 official Web；沒有 Session 時不猜 latest | UNKNOWN |
| Local TUI observe-only | 手機看得到 Local TUI，但不出現或執行 Stop | UNKNOWN |
| Mobile cleanup | 結束時只停止本次由 user／operator 啟動且已核對 identity 的 process，不停止既有 Instance | UNKNOWN |

OMW Basic password 一定會在需要驗證的 HTTP request 中以 `Authorization` 的 Basic auth
header 傳送；不能把「HAR 不含 `Authorization` header」寫成可保證的條件。驗收時應不保存、
不公開含敏感 header 的 network HAR；若確實需要 HAR，先移除 `Authorization`、
`x-omw-launcher-token` 與其他敏感欄位，再保存或分享。不要把 credentials、完整 HAR 或
敏感 headers 納入 issue、commit、文件或回報。

## #7 TTY 交互 manual check

這一節不是 automated acceptance。user／operator 需在 CMD 與 PowerShell 各自以真實
interactive TTY 手動檢查 `omw-opencode`：原生 stdin／stdout／stderr、ANSI、輸入、Ctrl+C、
resize、child exit code、known subcommand、`--help`、`--version`、explicit `--port`、
explicit hostname、fail-open 與 recursion prevention。結果必須獨立記為 `PASS`、`FAIL` 或
`UNKNOWN`；未實際操作前不能宣稱 #7 完成。

## 失敗處理與回復

任何 mapping、startup、positive、negative、UI、phone 或 TTY check 失敗時，先停止驗收並保留
實際證據，不把失敗改寫成 PASS。只停止本次流程由 user／operator 啟動、且 identity 已核對的
process；不可停止既有 Instance 或以 broad cleanup 代替 identity check。

回復不是 node reset。只對本次新增、且回復前仍確認 target 完全相同的 entries 逐一移除：

```powershell
tailscale serve --bg --https=443 off
tailscale serve --bg --https=42000 off
tailscale serve --bg --https=42001 off
tailscale serve --bg --https=42002 off
tailscale serve --bg --https=42003 off
```

若某 public port 在第一步已存在原 entry，本流程沒有覆寫它，回復不得移除它。若 target 已被
改變，或無法證明 entry 是本次新增，停止並由 user／operator 調查，不執行 `off`。回復後再次
執行 `tailscale serve status -json` 與 `tailscale serve get-config --all`，確認只移除本次新增
entries，且既有 mappings 仍存在。
