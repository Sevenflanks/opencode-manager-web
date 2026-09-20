# 手機驗收操作手冊

## 目的與目前狀態

本文件記錄 #7／#9 既有驗收的操作步驟與目前證據。它是 runbook，不是 `new deployment
automation` 或 `subsystem`。目前由 user 維持已啟動 Manager 的 ownership；本輪只校正文檔，
不執行其中任何 command。

既有部署 mapping 已是：Manager `HTTPS 40443 -> 127.0.0.1:40443`，Instances 為
`40444-40463` 的同號 loopback 20 slots。每次 Serve 變更前仍須核對 exact mapping、實際
bind 與 Windows excluded port range；不使用 `reset`、`clear`，不開啟 Funnel，不修改
Firewall、PATH 或 global 設定，也不將真 credentials／DB 放入文件。

目前可宣稱的範圍：

| 項目 | 狀態 |
|---|---|
| Manager／Instance loopback mapping | 已部署：Manager `40443`；Instance `40444-40463`，同號 loopback 20 slots |
| Manager launcher API | 已實作：`/api/v1/launcher/reservations`、`/api/v1/launcher/reservations/:id/register`、`/api/v1/launcher/reservations/:id/finalize` |
| Windows Tailscale Serve/TLS | 已有實際 Serve 與 Windows HTTPS 證據；不等同真手機驗收 |
| Windows 未認證 negative probes | PASS：root、`/api/v1/overview` 未認證均 `401`／Basic challenge；明示錯誤 Basic 亦同 |
| Windows 真部署認證後 probes | PASS（user 回報）：HTTPS／loopback 正確認證、缺少／錯誤 CSRF、錯誤 Origin、空 body validation、Browser Basic → launcher 拒絕，共 7/7；不涵蓋有效 launcher token 的反向測試 |
| 真實手機基本流程 | PASS（user 前輪回報）：已有入口、NewSession、送出第一則訊息、安全停止；非本輪自動化 |
| fixture／隔離測試 | 28/28 PASS；僅為 fixture 證據，不等同 deployed live 驗收 |
| 真實手機端到端其餘項目 | 部分仍 UNKNOWN，見下方驗收表與未驗證清單 |
| Directory Shortcut／Instance／Session 真人回報 | PASS（上輪測試 #1 的 Directory Shortcut 新增／瀏覽同一 Project 的兩個新背景 Instance；本輪兩個 Instance、兩個 Session 各自綁定與單一 Stop 隔離亦通過） |
| 同一 Instance 的手機 Local TUI／Web 同步 | PASS（user 真人回報）；跨 Instance 的 live event 同步為已接受限制，不作跨 Instance 同步承諾 |
| PowerShell TTY、輸入／顏色、resize、Ctrl+C 退出與 `-s` | PASS（本輪 user 回報）；實際 exit code 數值未提供 |
| 真實 PowerShell fail-open | PASS：Manager 連線失敗仍啟動原生 TUI、不新增 OMW 登錄，退出碼 `0`（user 回報） |
| CMD TTY | PASS（本輪 user 回報）：顯示／輸入／resize、手機 Local TUI 登錄且不可 Stop、Ctrl+C 正常退出；未提供 exit code 數值 |
| 手機 Tailnet 斷線與恢復 | PASS（user 回報）：斷線顯示最後更新時間、另開私密分頁無法連線、重新連線後恢復更新；不等同其他未授權 Tailnet 裝置的隔離 |
| Tailnet device policy 負面測試 | 獲准延後／`NOT RUN`（user 已確認目前能接該 Windows PC 的 Tailnet devices 都由本人控管；不是 `PASS`，也不宣稱已 audit 所有 ACL） |
| Firewall、PATH、ACL 與 production secret | NOT VERIFIED；本輪未修改 |

摘要：必要的真手機基本流程、多 Instance、TTY 與 server guards 已取得分層證據；延伸矩陣
不增加新的 gate。裝置負面測試已由 user 准予延後，記為 `NOT RUN`，不是 `PASS`。
user 已明確確認「是，都是本人裝置，接受此限制」；這是本輪的 user trust scope confirmation，
不代表已 audit 所有 ACL。

不可把 loopback proxy PoC 說成 real Tailscale 已驗證，也不可把桌面 browser、模擬 viewport
或既有測試證據當成真實手機驗收。

## 部署順序

以下順序是由 user／operator 依當時授權執行的規劃流程。本輪只修正文檔，不執行其中任何
command。

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

先查核預定的對外 HTTPS ports `40443`、`40444-40463` 及其 target，並在每次變更前確認
本機實際 bind 與 Windows excluded range：

```powershell
Get-NetTCPConnection -State Listen |
  Where-Object { $_.LocalAddress -eq '127.0.0.1' -and $_.LocalPort -ge 40443 -and $_.LocalPort -le 40463 } |
  Sort-Object LocalPort
netsh interface ipv4 show excludedportrange protocol=tcp
```

預期 mapping 是 Manager `40443 -> http://127.0.0.1:40443`，以及每個 Instance
`40444-40463 -> http://127.0.0.1:<same-port>`；不得以 port range 或未核對的 target 代替
逐項核對。

上面的 listener 與 excluded range 查詢只是前置檢查，不是空 port 可 bind 的證明。
新增尚未使用的 port 前，仍須短暫執行 loopback bind 測試並立即釋放測試 listener；
已使用的 port 則核對既有服務，不停止或搶占它。

- 既有 entry 若位於預定 port，先比對 target；target 不符時停止，不覆寫。
- 只有不存在且不衝突的 entry 才可在下一步新增；既有 Serve mappings 必須完整保留。
- 不使用 `tailscale serve reset`、`clear` 或任何清整整個 node 的指令。

官方參考：

- [Tailscale `serve` CLI reference](https://tailscale.com/docs/reference/tailscale-cli/serve.md)
- [Tailscale Services configuration](https://tailscale.com/docs/features/tailscale-services.md)

### 2. 以同一 `OMW_DATA_DIR` 使用既有 credentials

user 已以同一個 `OMW_DATA_DIR`、同一 Windows user 沿用既有 DPAPI file 並啟動 Manager。`credentials:setup`
只在第一次建立 credentials 時由 user 在本機 masked TTY 執行；開新 shell 只重新設定環境變數，
不重跑 setup。升級自含舊 `openCode` 欄位的 DPAPI file 時也不需重跑 setup：

```powershell
$env:OMW_DATA_DIR = '<OMW_DATA_DIR>'
$env:OMW_OPENCODE_EXECUTABLE = '<absolute-opencode.exe>'
# 僅第一次、尚無 credentials.dpapi 時才執行；既有部署不要重跑：
# npm run credentials:setup -w @omw/manager
```

`credentials:setup` 只會以 masked input 取得 OMW Basic password，隨機產生 launcher token
且不顯示，並將 OMW Basic credential 與 token 的 Windows 目前使用者 DPAPI ciphertext 寫入同一個
`<OMW_DATA_DIR>/credentials.dpapi`。OpenCode password 不再帶入，OC auth 已取消，但 OMW Basic
仍保留。之後在不同 shell 或不同 current working directory 執行時，只需重新明示相同的
`OMW_DATA_DIR`，避免執行環境從另一個目錄載入。

本流程不查看、不寫入、不回報真正 password、launcher token 或 DPAPI plaintext；不得將它們
放入 command argv、受版本控制的檔案、URL、log 或未清理的 HAR。

### 3. 新增沒有衝突的 Serve entries

確認既有 mappings 已保留、實際 bind 與 Windows excluded range 沒有衝突，且 user 已對這個
明確範圍授權後，才可用官方 CLI 形式逐一新增不存在的 entry。當前 21 個 mapping 已部署，
以下只表示同號 target 的形式，不應對已存在的 entry 重跑：

```powershell
tailscale serve --bg --https=<PORT> http://127.0.0.1:<PORT>
```

`<PORT>` 只可逐一替換為缺少的 `40443` 或 `40444-40463`；不得重新指向原有 entry，也不
開啟 Funnel、公開網際網路或 Firewall rule。當前穩定 deployment 不應被拆除或重建。

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

在同一 Manager shell 明示完整 remote mode 設定，並保持與 credentials setup 相同的 data
directory。QuickStart 的 `OMW_MANAGER_ORIGIN` 不在此 shell 設定，必須另開 launcher 視窗：

```powershell
$env:OMW_DATA_DIR = '<OMW_DATA_DIR>'
$env:OMW_OPENCODE_EXECUTABLE = '<absolute-opencode.exe>'
$env:OMW_PORT = '40443'
$env:OMW_REMOTE_ACCESS = '1'
$env:OMW_EXPECTED_LOOPBACK_ORIGIN = 'http://127.0.0.1:40443'
$env:OMW_TAILNET_DNS_HOST = '<device>.<tailnet>.ts.net'
$env:OMW_MANAGER_PUBLIC_HTTPS_PORT = '40443'
$env:OMW_INSTANCE_PUBLIC_PORT_MIN = '40444'
$env:OMW_INSTANCE_PUBLIC_PORT_MAX = '40463'
$env:OMW_REMOTE_MAPPING_READY = '1'
# 若這次 remote flow 要使用 launcher，才必須加入：
$env:OMW_LAUNCHER_INTEGRATION = '1'
```

另開 launcher 視窗後設定：

```powershell
$env:OMW_MANAGER_ORIGIN = 'http://127.0.0.1:40443'
```

`OMW_PORT` 必須明示為 `40443`。若一般 remote flow 需要 launcher API，`OMW_LAUNCHER_INTEGRATION=1`
也必須加入；不使用 launcher 時不要誤稱 launcher routes 已啟用。所有 required env、DPAPI
file、real executable、authority 與 mapping gate 都要在啟動前完成。

QuickStart wrapper 建議使用以下既有入口，不依賴不存在的 npm shim：

```powershell
# PowerShell
. '<repo>\scripts\omw-shell.ps1'
omw

# CMD；不可使用 PowerShell dot-source
node "<repo>\packages\launcher\dist\src\cli.js"
```

`omw` 不帶 port 時使用 OMW reserve／default cwd；`-s` 透傳。此入口不讀模型、不發訊息。

### 6. 在設定完成後啟動 Manager

這是規劃 command，僅由 user／operator 在前述步驟完成且取得授權後執行；本輪不啟動 server：

```powershell
npm run start:configured -w @omw/manager
```

`start:configured` 是此 deployed acceptance 明確使用上方既有 `OMW_DATA_DIR`、remote mapping 與
credentials 的 opt-in 入口；一般 repository 開發應使用隔離的 `npm run dev`，不可用
`start:configured` 連入日常環境。

## 已核對證據（依平台與日期）

| 日期／平台／證據類型 | 已核對結果 | 邊界 |
|---|---|---|
| `2026-09-18T15:15:13Z`，Windows main；只讀 Tailscale status／Serve status | Tailscale `Running`／`Online`；Manager mapping 正確；Instance `20/20`；`AllowFunnel` 中值為 `true` 的 entry 數為 `0` | 只代表當時 Windows／Serve snapshot，不代表手機驗收 |
| 同一過程的 Windows HTTPS probe | 未認證與錯誤認證曾回 `502`，且 loopback `40443` 當時無 listener；該真實過程已記錄，不作 all-time PASS | 這是當時 failure evidence，不覆寫後續 fresh probe |
| `2026-09-18T17:36:29.8426312Z`，Windows；fresh `HttpClient`、無 cookie／default credentials／proxy／redirect，正常 TLS validation | `GET /` 未認證 `401`／Basic challenge；`GET /api/v1/overview` 未認證 `401`／challenge；明示 dummy wrong Basic 亦 `401`／challenge；Tailscale `Running`／`Online` | 是實際 Serve HTTPS 的 Windows 證據，不宣稱手機或認證後 CSRF 已測過 |
| 前輪 user 真手機回報 | 已有手機入口、NewSession、第一則訊息成功、安全停止可用 | 非本輪自動化；不延伸宣稱 Shortcut、isolation、CMD／PowerShell 全矩陣 |
| 上輪 user 提供的測試 #1 | Directory Shortcut 新增／瀏覽同一 Project 的兩個新背景 Instance 通過 | user 已通過；只記錄此測試涵蓋範圍，不延伸為完整 Manager UI state／hierarchy 通過 |
| 本輪 user 真 PowerShell／手機回報 | `omw` 不指定 port 正常啟動；TUI 顯示、輸入、resize、Ctrl+C 退出通過；手機可見 Local TUI 與 PID，不能從 OMW 停止；另以 `-s` 指定 Session 啟動成功 | 人工驗收，不是 fixture；managed 啟動未提供 exit code 數值，不臆測為 `0`；fail-open 與 CMD 證據另列 |
| 後續 user 真 PowerShell fail-open 回報 | 暫將 launcher origin 指向無 listener 的 loopback port，出現 `OMW launcher unavailable; running native OpenCode: fetch failed` 後正常進入 TUI；未新增 OMW 登錄；退出後 `$LASTEXITCODE` 為 `0` | 測試未停止 Manager，透過無服務 endpoint 模擬不可用；原 origin 由 `finally` 恢復。此退出碼只屬於本次 fail-open，不回填其他未記錄的測試 |
| 後續 user 真 CMD／手機回報 | 從相同 PowerShell 進入 CMD，直接以 Node 執行 launcher；TUI 顯示／輸入／resize 正常，手機可見 Local TUI／PID 且不能 Stop，Ctrl+C 正常退出 | 三項皆由 user 回報通過；未提供 `%ERRORLEVEL%` 數值，不臆測為 `0`；不延伸為 CMD 各種參數／fail-open 全矩陣已測 |
| 後續 user 真手機 Tailnet 斷線／恢復回報 | 暫停手機 Tailscale 後，原頁提示最後更新時間；另開私密分頁無法連到相同 HTTPS 入口；重新連線後原頁成功恢復 | 三項皆由 user 回報通過；沒有停止 Manager／Instance。這是離開 Tailnet 的存取限制，不是 Tailnet 內其他裝置的 ACL 負面測試 |
| 本輪 user 真兩 Instance／兩 Session／手機同步回報 | 兩個 Instance 可同時運作；兩個 Session 各自綁定對應 Instance；同一 Instance 的手機 Local TUI 與 Web 雙向更新；停止其中一個不影響另一個 | 先啟 TUI 再由手機該 Local TUI「進入主 Session」可通過；Web 先建立 headless 後另起 TUI 以 `-s` 讀相同 Session 不保證 live event 同步。這是 user 接受的現況限制，不是待修 bug；不新增 feature，也不推論 #7／#9 或完整 UI 已完成 |
| 後續 user 在 Windows 執行真部署 `check-deployed-security.ps1` | `public-connectivity=200`、`mutation-missing-csrf=403`、`mutation-wrong-csrf=403`、`mutation-invalid-origin=403`、`mutation-valid-guard=400`、`loopback-connectivity=200`、`launcher-browser-audience=401`，7 項皆 PASS | 使用者自行於本機隱藏輸入真帳密；非 fixture。mutation 同時核對固定錯誤碼；未執行有效資料修改，不讀取有效 launcher token，不能推論反向 audience 或其他裝置隔離 |
| fixture／隔離測試 | `28/28`：launcher 13、API 8、security config 2、runtime contract 3、Tailnet PoC 1、process cleanup 1；包含 fake cert、wrong CSRF／Origin `403`、audience `401`、recursion rejection | fixture，不等同 deployed live |

### 7. 逐項進行 positive、negative、UI 與手機驗收

手機相關項目仍要在真實手機、受控 Tailnet 與實際 device 上記錄 `PASS`、`FAIL` 或 `UNKNOWN`。
Windows HTTPS 或 fixture 證據只能標註其平台與類型，不可推導成真實手機 PASS。

| 檢查項目 | 預期 | 結果 |
|---|---|---|
| Tailnet membership | 手機連入 Tailnet 後能以 HTTPS 連到 OMW | PASS（user 真手機斷線／恢復回報）；其他裝置的 policy 另驗 |
| TLS 與 authority | public origin 與 certificate/hostname 符合預期，不接受 loopback URL | Windows HTTPS PASS；手機 UNKNOWN |
| 正確 Basic auth | 使用正確 OMW Basic credentials 可登入 browser route | Windows 真部署 HTTPS／loopback API PASS（user 執行腳本）；非新一輪手機登入測試 |
| 缺少 Basic auth | 沒有 `Authorization` 的 browser request 被拒絕並回 `401`／challenge | Windows HTTPS PASS；手機 UNKNOWN |
| 錯誤 Basic auth | 錯誤 username/password 被拒絕並回 `401`，不洩露內部細節 | Windows HTTPS PASS；手機 UNKNOWN |
| 錯誤 `Origin` | browser mutation 帶不受信任 `Origin` 時被拒絕 | Windows 真部署 PASS：`403 UNTRUSTED_ORIGIN` |
| 缺少或錯誤 CSRF | mutation 缺少或帶錯 `x-omw-csrf` 時被拒絕 | Windows 真部署兩項皆 PASS：`403 MUTATION_ORIGIN_REJECTED` |
| launcher audience 分離 | Browser Basic auth 不能呼叫 launcher routes；launcher token 不能呼叫 browser routes | Browser Basic → launcher 真部署 PASS：`401 LAUNCHER_AUTH_REQUIRED`；有效 launcher token → browser 仍未真部署驗證 |
| OpenCode direct access policy | OpenCode 無獨立 auth；只有 #9 Tailnet policy 核准的 user devices 能直接連到 Instance ports，且未啟用 Funnel | device-policy 負面測試獲准延後／`NOT RUN`（user 已確認目前能接該 Windows PC 的 Tailnet devices 都由本人控管；不是 `PASS`，不宣稱已 audit 所有 ACL） |
| Secret handling | 不保存或公開含敏感 header 的 network HAR 或 log；若必須保留 HAR，先移除 `Authorization`、`x-omw-launcher-token` 等敏感 headers | UNKNOWN |
| Funnel 與 public internet | 未啟用 `tailscale funnel`；入口只可由 Tailnet 存取 | Windows Serve snapshot 的 `AllowFunnel` 中值為 `true` 的 entry 數為 `0`；不等同手機 policy PASS |
| Firewall | 沒有新增或修改 Firewall rule | UNKNOWN |
| Directory Shortcut | 可新增／瀏覽同一 Project 的兩個新背景 Instance | PASS（依上輪提供的測試 #1，user 已通過） |
| Manager UI | 手機可看到真實 Shortcut、Instance lifecycle、health 與 unknown state | 部分已測 PASS（Shortcut、Instance 與 Local TUI 可見）；完整 state／hierarchy 未逐項回覆，維持 UNKNOWN |
| Instance endpoint isolation | 一個 Instance 的 endpoint 運行態不可與另一個 Instance 混用；同一 Project 的 Session metadata 合法共享，不算跨 Instance 洩漏 | UNKNOWN |
| Primary Session Binding isolation | 兩個 Instance 各自維護自己的 primary binding；同一 Project 的 Session metadata 可共享，不是 Session exclusive owner | PASS（本輪 user 真人回報）；此項不代表完整 endpoint isolation |
| 單一 Stop 隔離 | 停止其中一個 Instance 不影響另一個 Instance | PASS（本輪 user 真人回報） |
| Session 與 Open Web | 明確選擇 Session 後才開啟 official Web；同一 Instance 的 TUI 與 Web 可雙向更新；沒有 Session 時不猜 latest | PASS（同一 Instance 真人測試足夠）；Web headless 後另起 TUI 以 `-s` 讀相同 Session 的跨 Instance live event 同步不保證，為已接受限制，不新增 feature |
| Local TUI／Web live update | 手機對同一 Local TUI「進入主 Session」後，TUI 與 Web 雙向更新 | PASS（本輪 user 真人回報）；不新增跨 Instance 同步或 feature |
| Local TUI observe-only | 手機看得到 Local TUI，但不能執行 Stop | PASS（本輪 user 真手機回報） |
| 真手機基本 workflow | 已有入口、NewSession、送出第一則訊息、安全停止 | PASS（前輪 user 回報；非本輪自動化） |
| 手機斷線與恢復 | 斷線顯示過期資料／最後更新時間；新私密分頁無法連線；重新連入 Tailnet 後恢復更新 | PASS（user 三項回報）；不推導未授權 Tailnet 裝置隔離 |
| Mobile cleanup | 結束時只停止本次由 user／operator 啟動且已核對 identity 的 process，不停止既有 Instance | 安全停止 PASS（前輪 user 回報）；完整 cleanup matrix UNKNOWN |

Origin／CSRF 與 Browser Basic → launcher 已取得 Windows 真部署證據，不需要以相同請求重跑
手機來宣稱伺服器 guard 通過。仍未涵蓋的是有效 launcher token → browser 的真部署驗證、
手機端完整 UI／isolation，以及尚未逐項記錄的 CLI 行為。#9 devices policy 的負面隔離已由
user 准予延後，記為 `NOT RUN`（不是 `PASS`），且不宣稱已 audit 所有 ACL。
文件列為 UNKNOWN 的延伸矩陣不自動新增 issue 未要求的交付 gate；收尾時依 #7／#9 acceptance
criteria 判定證據是否足夠，未驗證與獲准延後須分別記錄，不改寫成 PASS。

OMW Basic password 一定會在需要驗證的 HTTP request 中以 `Authorization` 的 Basic auth
header 傳送；不能把「HAR 不含 `Authorization` header」寫成可保證的條件。驗收時應不保存、
不公開含敏感 header 的 network HAR；若確實需要 HAR，先移除 `Authorization`、
`x-omw-launcher-token` 與其他敏感欄位，再保存或分享。不要把 credentials、完整 HAR 或
敏感 headers 納入 issue、commit、文件或回報。

OMW Basic 不是 OpenCode endpoint 的 gate。Managed OpenCode 不要求帳密，但仍只 bind loopback，
並依賴 Tailnet-only Serve 與 #9 device policy；「無帳密」不表示允許 public internet。變更後由
user 重啟既有 OpenCode process 才會生效，本流程不自動 stop process 或 reload 真 credentials。

## 認證後安全檢查（使用者在本機執行）

保持既有 Manager 執行，在另一個 PowerShell 視窗執行：

```powershell
pwsh -NoLogo -NoProfile -File .\scripts\check-deployed-security.ps1
```

腳本從本機 Tailscale 的 `Self.DNSName` 取得 HTTPS 目標，預設 public／loopback port
都是 `40443`。username 預設 `omw`，password 以隱藏輸入取得，不讀取 DPAPI file，
不重建 credentials，也不保存或輸出密碼、headers、回應 body 或裝置網址。
若只檢查計畫，加上 `-Plan`；此分支不讀取憑證、不執行 Tailscale、不送 HTTP。
若要檢查本機環境，加上 `-Preflight`（別名 `-CheckEnvironment`）：只讀取本機 Tailscale
狀態並驗證目標 URL 格式，不詢問帳密、不送 HTTP；成功輸出
`PREFLIGHT stage=TARGET_URI code=NONE`。

| Probe | 預期 HTTP／語意 |
|---|---|
| `public-connectivity` | `200`，正確 Basic 可通過真實 HTTPS 入口 |
| `mutation-missing-csrf` | `403`，缺少 CSRF header 被拒絕 |
| `mutation-wrong-csrf` | `403`，錯誤 CSRF header 被拒絕 |
| `mutation-invalid-origin` | `403`，不受信任 Origin 被拒絕 |
| `mutation-valid-guard` | `400`，認證與 guard 通過後，空 body 由 schema 拒絕 |
| `loopback-connectivity` | `200`，正確 Basic 可通過 loopback 入口 |
| `launcher-browser-audience` | `401`，Browser Basic 不能取代 launcher token |

所有 mutation 都送出缺少必要欄位的 `{}`，不含可供啟動 Instance 或 reserve 的有效資料，
也不呼叫停止或刪除路徑。腳本同時核對固定錯誤碼，不僅判斷任意 `403`；正向 baseline
失敗就停止，不能把錯誤密碼造成的拒絕當成安全防護通過。

HTTP 維持正常 TLS 驗證，不跟隨 redirect；每次請求含 body 的 deadline 為 8 秒，buffer
上限為 64KB。只分享 probe 名稱、狀態碼與 PASS／FAIL。靜態檢查及 `-Plan` 已通過，
修正後使用者在真部署執行亦回報上列七項全 PASS。此腳本不讀取有效 launcher token，
因此不涵蓋 launcher token → browser 的反向測試，也不取代 Tailnet 裝置隔離驗收。

首次執行曾回報 `ERROR SECURITY_PROBE_FAILED`。已重現為腳本本身的 PowerShell 回傳值污染：
等待 async task 的兩個 `VoidTaskResult` 混入 DNS 字串，使目標 URL 在帳密輸入前就無法建立。
修正後隔離回歸驗證回傳恰好一個字串且 URL 有效，本機 `-Preflight` 亦通過。
後續錯誤只回報固定 `stage`／安全錯誤碼，避免再次隱藏失敗階段；不輸出真網址或憑證。
這次失敗不算部署認證 FAIL；七項 HTTP probes 的 PASS 來自後續使用者完整執行的結果，
而不是僅因 preflight 修好就推論成功。

## #7 TTY 交互 manual check

這一節不是 automated acceptance。user／operator 需在 CMD 與 PowerShell 各自以真實
interactive TTY 手動檢查 `omw-opencode`：原生 stdin／stdout／stderr、ANSI、輸入、Ctrl+C、
resize、child exit code、known subcommand、`--help`、`--version`、explicit `--port`、
explicit hostname、fail-open 與 recursion prevention。結果必須獨立記為 `PASS`、`FAIL` 或
`UNKNOWN`；未實際操作前不能宣稱 #7 完成。

目前 PowerShell 的免 port 啟動、TUI 顯示／輸入／resize、Ctrl+C 正常退出，以及 `-s` 指定
Session，已由 user 回報通過。手機同步顯示 Local TUI／PID 且不可 Stop 也已通過。
後續 PowerShell 真實 fail-open 亦通過：連線失敗提示後正常啟動原生 TUI、不新增 OMW 登錄，
且退出碼為 `0`。CMD 的顯示／輸入／resize、手機 Local TUI 登錄與不可 Stop、Ctrl+C 退出，
也已由 user 回報通過。PowerShell 與 CMD 正常 managed 啟動的 exit code 數值仍未記錄；
上述結果不替代尚未逐項確認的其他 CLI 行為。

驗收分工以 #7 的可觀察契約為準：真終端覆蓋互動與 fail-open；參數逐字透傳、拒絕 recursion、
明示 port 與 child exit code 傳遞，另有 Windows 隔離 launcher／shell 測試。
不要求使用者在兩種 shell 重複所有故障排列，亦不因缺少某次正常退出的數值就抹去已取得的
exit-code 傳遞證據；需要補測時應指出尚未覆蓋的具體行為。

## 失敗處理與回復

任何 mapping、startup、positive、negative、UI、phone 或 TTY check 失敗時，先停止驗收並保留
實際證據，不把失敗改寫成 PASS。只停止本次流程由 user／operator 啟動、且 identity 已核對的
process；不可停止既有 Instance 或以 broad cleanup 代替 identity check。

回復不是 node reset。只對本次新增、且回復前仍確認單一 entry target 完全相同、並確認該 entry
由本次操作 owned 的 port 逐一移除；不可用 batch loop 當成一次刪除既有 21 個 entries，也不拆
現有穩定 deployment。40443 僅為示例，目前不要執行：

```powershell
tailscale serve status -json
# 只有確認本次新增、owned、且 target 仍是 http://127.0.0.1:40443 才可執行；目前不要執行
tailscale serve --bg --https=40443 off
```

若某 public port 在第一步已存在原 entry，本流程沒有覆寫它，回復不得移除它。若 target 已被
改變，或無法證明 entry 是本次新增，停止並由 user／operator 調查，不執行 `off`。其他 port
也必須一次只處理一個，先完成同樣的 exact mapping／ownership 核對。回復後再次
執行 `tailscale serve status -json` 與 `tailscale serve get-config --all`，確認只移除本次新增
entries，且既有 mappings 仍存在。
