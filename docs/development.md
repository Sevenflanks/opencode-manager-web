# 開發說明

## 邊界

OMW MVP 與 Manager-launched OpenCode 都只監聽 `127.0.0.1`。Remote mode 的 OMW 有 Basic auth、
current-user DPAPI credential store 與固定 remote URL validation，但不會設定 Tailnet、TLS、
Firewall、PATH、ACL 或 production secrets。完整 contract 見
[Tailnet access contract](security/tailnet-access.md)。

Directory Shortcut 只提供操作入口，不是 allowlist。Manager 可瀏覽及啟動其 OS identity
原本可存取的既有目錄；所有路徑都先解析成 canonical path，並以結構化 argv 傳給程序。

## Manager API contract

所有 response 都是 JSON。錯誤格式為
`{ "error": { "code": string, "message": string, "details"?: unknown } }`。
所有 API 與靜態資源 request 都必須符合啟動時設定的 `127.0.0.1:<actual-port>` authority；
不從來訪 `Host` 推導 trusted authority。request 若帶 `Origin`，必須是同 origin 或明示的
loopback development origin。Browser 的 `POST`、`PATCH`、`DELETE` 另須帶受信任 `Origin` 與
`x-omw-csrf: 1`。Launcher routes 則拒絕任何 `Origin`，只接受 configured loopback authority
與獨立 `x-omw-launcher-token`。前端只呼叫 Manager API，不直接讀 SQLite 或探測程序。

| Method | Path | 用途 |
|---|---|---|
| `GET` | `/api/v1/overview?q=&filter=all&includeHidden=true` | Shortcut 與 Instance 清單；filter 為 `all`、`active`、`attention`、`unreachable`；`includeHidden=true` 時包含停止追蹤的紀錄 |
| `GET` | `/api/v1/directories?path=` | 回傳 canonical current、parent 與可存取 direct child directories |
| `POST` | `/api/v1/shortcuts` | 新增 `{ name, directory }` |
| `PATCH` | `/api/v1/shortcuts/:id` | 修改 `{ name, directory }` |
| `DELETE` | `/api/v1/shortcuts/:id` | 只刪捷徑，不影響 Instance |
| `POST` | `/api/v1/instances` | 從 `{ directory }` 啟動全新 Instance，不復用既有 Instance |
| `POST` | `/api/v1/instances/:id/stop` | 只停止 OMW-owned 且當下 identity 仍吻合的程序 |
| `POST` | `/api/v1/instances/:id/recheck` | 單次重新核對 exact identity 與 health；不自動 retry |
| `POST` | `/api/v1/instances/:id/resume` | 使用者明確確認後，以新 headless Instance 接續既有 primary；不停止舊 Instance |
| `POST` | `/api/v1/instances/:id/tracking` | 更新 `{ hidden: boolean }`；停止或恢復 OMW tracking |
| `DELETE` | `/api/v1/instances/:id` | 只在確認 stopped 且沒有未驗證 allocation 時刪除 OMW tracking record 與 binding |
| `GET` | `/api/v1/instances/:id/sessions` | Project-scoped roots 與 unknown-parent sessions |
| `POST` | `/api/v1/instances/:id/sessions` | OMW New Session：建立新的 root Session，成功後設為此 Instance 的 primary |
| `GET` | `/api/v1/instances/:id/sessions/:sessionId/children` | 載入 direct children；count 只代表本次已載入筆數 |
| `POST` | `/api/v1/instances/:id/open-url` | 由 adapter 產生受控 official Web URL；optional `{ sessionId }` |
| `POST` | `/api/v1/instances/:id/primary-session` | Advanced 手動指定 `{ sessionId }`；只能指定已確認存在的 root Session |
| `POST` | `/api/v1/launcher/reservations` | 以 invocation ID、cwd 與 optional port preference 保留 fixed pool port |
| `POST` | `/api/v1/launcher/reservations/:id/register` | child spawn 後送 PID；202 後背景核對 readiness/path/port owner |
| `POST` | `/api/v1/launcher/reservations/:id/finalize` | child exit callback；不 kill，port 關閉後才釋放 allocation |

Instance summary 分開回傳 `busySessions`、`pendingQuestions` 與
`pendingPermissions`。三者可同時存在；每個 pending entry 必須包含非空 `id` 與 `sessionID`，再依
request ID 去重。同 Session 的不同 request 仍分別計數；任一 malformed entry 使該 endpoint 結果為
unknown，不部分計數。成功取得空 status map
時 `activity="none-reported"`；合法的 idle／retry entry 為 `reported-non-busy`；未知 type、無效
shape 或查詢失敗為 `activity="unknown"`，不得猜 idle 或 latest Session。
四個 OpenCode 查詢獨立保留成功結果；例如 question 失敗不會抹除已成功取得的 status 或 permission。
Overview 的 process helper 與 summary probe 全程使用非阻塞 I/O，每輪最多同時處理四個 Instance；重疊的
poll 共用同一輪結果，避免慢 probe 持續堆積。Start／Stop 等 mutation 不排在 overview probe 佇列後方。
每次 registry 驅動的 summary、Session、children 與 Open URL 都會先重新核對 exact process identity 與
port owner；不符時不查詢該 endpoint、不顯示其 metadata，也不產生 URL。Health 失聯但 identity 仍
吻合時保留安全 Stop authority。

Session root 僅限沒有 `parentID` 的 metadata。`parentID` 存在但 parent 尚未載入時放在
`unknownParent`，不提升為 root，也不推論 agent provenance 或 Instance ownership。
Open URL 由 1.18.31 adapter 集中產生 `/<base64url(directory)>/session/<session-id>`；UI 不組 route，
沒有明確選擇 Session 時也不猜 latest。

## Instance recovery and tracking contract

Overview 以完整 `Project` 目錄分組；group header 同時顯示資料夾名稱與完整 path。每個 Instance
子列顯示 `#PID` 與 primary 最新 title。PID 未知時顯示 unknown，不造出 PID；UI 不使用
`sessionowner` 稱呼。

### 手機導覽與歷史紀錄

- 860px 以下初始顯示列表，選取 Instance 後才顯示詳細內容；桌面維持雙欄。手機列表與詳細內容使用
  namespaced History state，頁內「返回列表」、瀏覽器返回／前進與重新整理都保留搜尋、篩選、歷史展開偏好、
  捲動位置及有效的詳細目標，並將焦點還給原列；原列不存在時退回搜尋欄。成功套用列表條件後才同步目前
  list entry，捲動位置則在進入詳細內容、頁面 hidden 或 pagehide 時快照，不在每次 scroll 寫入 History。
  初次 Overview 失敗不會銷毀詳細目標；成功取得未篩選 Overview 且確認該 Instance 已不存在後，才返回列表
  並提示使用者。非同步 fallback 只有在原 detail target 與導覽 generation 仍相符時才能改寫 History 或詳細頁。
- 只有 `stopped` 收入各 Project 的「已停止紀錄」，預設收合；已失聯、啟動失敗與停止追蹤是不同概念。
  成功套用的非空搜尋會展開符合結果的歷史，清除搜尋成功後回復原展開偏好；未送出、pending 或
  失敗的查詢不會自行改變既有結果的展開狀態。選取過歷史 Instance 不會阻止使用者再次收合。
- 詳細頁將主 Session 操作放在技術識別欄位前；手機摘要採緊湊三欄。狀態層級保留原始 lifecycle，
  不把摘要未知當成 idle，也不把失聯歸入已停止。列表切換與 polling 不加進場動畫。
- UI 顯示 Overview 最後成功更新時間。更新失敗或頁面回到前景開始 fresh check 時，保留最後成功的 Instance
  紀錄並標示資料已過期；初次即失敗則標示尚未取得，不把所有 Instance 改判為失聯。資料過期期間，依賴
  Overview capability 或 lifecycle 的 mutation 必須等 fresh refresh 成功後才能執行；後端 recovery flags 仍是
  唯一權限來源。Overview 與 Connectivity 的背景 polling 在頁面 hidden 時都略過，回到前景則立即更新兩者。

`Managed` response 的 lifecycle metadata 包含 `trackingHidden` 與四個 recovery flags：
`recheckAllowed`、`resumeAllowed`、`hideAllowed`、`removeAllowed`。

### Recheck 與狀態邊界

- 每次 recheck 都是單次 fresh check，須以 exact process identity 與 health 共同判斷；API 不做自動 retry。
- 只有 process inspector 明確證實 process missing，且 recorded loopback port 同時確認 free，才能標記
  `stopped`、清除 process identity 並釋放 allocation。
- HTTP health failure、缺少 exact identity、inspector failure、PID reuse、port 被占用或仍在 grace
  window，都不能推論 `stopped`；Instance 維持 `unreachable` 或其他未確證狀態。
- `unreachable` 不等於 `stopped`。`unreachable` 可保留 OMW record、primary binding 與 allocation，不能
  當成 process 已消失的證據。

Online identity、health 與 metadata 都確認後，才以 Project metadata 的 primary title 更新 title snapshot；
即使 activity 是 idle 也可更新。更新以既有 `sessionId`、`source`、`boundAt` 作 CAS，競爭時不覆蓋新的
binding；identity、health 或 metadata 失敗時保留最後已知的 binding 與 title。

### Explicit continuation

- 「啟動」與「接續對話」使用綠色正向操作樣式。已停止且沒有 primary 的 Instance 提供「啟動」，
  沿用一般 start API 在相同目錄建立新 Instance；不建立 Session，也不改寫舊紀錄。
- 已停止或已失聯且具有 primary 時，依後端 `resumeAllowed` 提供「接續對話」；沒有對話時不呼叫 resume。
- UI 標示「已失聯」時，使用者可明確確認啟動新的 headless Instance 接續相同 primary Session。新 Instance
  一定取得新的 Instance ID，不是復活舊 PID；OMW 不 Stop old Instance，也不自動導向 LLM 或 TUI。
- 每次「明確確認啟動新 Instance 接續」都可建立新的 Instance；不隱式重用已有 replacement。
- 若新 Instance 已建立但 binding 接續失敗，API 回傳 `newInstanceId` 並明示不要重複啟動；此 partial create
  failure 不會由 API 自動 retry。

### 確認與操作面板

- 「執行個體操作」的展開偏好在目前頁面內保留；切換 Instance、刷新資料、啟動或接續不重設，只有使用者
  主動展開／收起才變更。此偏好不持久化至下次載入頁面。
- 確認操作共用 Reka UI AlertDialog；取消不發出 mutation。巢狀於啟動面板時，關閉確認框仍保持父面板與有效焦點。
- New Session 與手動換綁必須在確認按鈕的 user activation 內同步預留新分頁，再等待 API；不可為退場動畫
  延遲 `window.open`。確認框的文字保留至退場完成，避免內容先清空而閃爍。

### Tracking 與移除

- `POST /tracking` 的 `hidden=true` 是停止追蹤，不是 Stop：Instance 仍保留在 DB 與 allocation，不 kill
  process。預設 overview 隱藏它；`GET /api/v1/overview?includeHidden=true` 可恢復追蹤。
- 只有已確認 `stopped` 且沒有 unverified allocation 時，`DELETE /api/v1/instances/:id` 才能刪除 OMW
  tracking metadata 與 primary binding。它不刪 OpenCode Session，也不刪 Project files。
- Stopped Instance 預設仍保留既有 binding；只有上述明確移除追蹤操作才會一併刪除 OMW binding。

## Primary Session Binding contract

Primary Session Binding 是每個 Instance 各自維護的主要 root Session 關聯。Overview 會回傳
`primarySession`；其 `source` 會標示為 `activity`、`new-session` 或 `manual`，`boundAt` 是綁定時間，
`title` 是最近一次 online verified metadata 的標題 snapshot；即使標題後續過期，也不代表 Session 內容消失或被複製。
Binding 不等於 Project 對 Session 的獨佔 ownership；同一 Project 的 Session metadata 可以被不同 Instance 看見。

同步邊界（本輪 user 已接受的現況）：手機 Local TUI 與 Web 的雙向 live update 必須使用同一個
OpenCode Instance；先以 `omw` 啟動 TUI，再由手機對該 Local TUI「進入主 Session」可通過。Web
先建立 headless Instance 後，另起 TUI 以 `-s` 讀取相同 Session，不保證 live event 同步。`-s`
只選擇 Session，不是 attach 到既有 Instance；OMW 不新增跨 Instance 同步。此為目前 accepted
limitation，非待修 bug。

### 建立與切換規則

- Instance 第一次透過 session activity SSE 取得自身活動的有效 evidence 時，OMW 會沿 Session
  parent chain 找到 root，並在尚未綁定時以 first-writer-wins 方式 pin；同一 Instance 後續的
  idle 或其他 activity 不會換綁。
- 活動 evidence 不是獨佔 ownership 證明。其他 Instance 的活動、同 Project 的歷史 metadata、
  單獨存在的 root，或「看起來像最新」的 Session 都不能自動成為 primary。
- SSE 在首次連線前漏掉，或 observer 用盡 retry budget 後仍沒有可用 evidence 時，binding 保持
  `null`；OMW 不猜歷史。使用者要在 Advanced 明確指定 root Session，才會建立 `manual` binding。
- OMW New Session 明確呼叫 `POST /api/v1/instances/:id/sessions` 建立新的 root；建立成功且
  response 是 root 後才設為 `new-session` primary。建立失敗、response 不是 root 或 runtime 不可用
  時，原 binding 保持不變。
- Advanced 明確呼叫 `POST /api/v1/instances/:id/primary-session`，只接受目前 Project metadata
  中已確認存在且沒有 `parentID` 的 Session，成功後以 `manual` 覆寫既有 binding。
- `POST /api/v1/instances/:id/open-url` 只有在呼叫端明確提供 `sessionId` 時才使用該 Session；
  否則使用該 Instance 的 primary binding，沒有 binding 就不猜 Session。這不代表 native TUI
  直接建立的新 Session 會自動換綁，也不代表 native TUI 知道 OMW 的 selected Session。

### Instance 生命週期與升級

- Stopped Instance 保留既有 binding，但不能 open 或變更 primary。可用「接續對話」建立並綁定新 Instance，
  或另行啟動後透過 Advanced 明確選擇歷史 root；不能把原 Instance ID 或原 binding 視為可 resurrect 的
  執行環境。
- 升級前已存在的 legacy Instance 若沒有 binding row，升級後維持 `primarySession: null`。
  只有升級後觀測到新的有效活動或使用者明確手動選擇，才可建立 binding；不做 retroactive guess。

### 驗證證據與限制

已用真 OpenCode 1.18.31、兩個 Instance 共用同一測試資料庫驗證窄鏈：各 Instance 的第一次
busy-session SSE evidence 會歸到自身活動所屬的 root 並各自 pin；後續 status 為空、idle 或另一
Instance 的活動不會改綁；未使用 UI polling；另一 Instance 的歷史 Session 不會被自動填入；
cleanup 通過。這些證據只支持 OMW 已觀測到的活動與 explicit mutation 行為，不支持宣稱 native
TUI 直接建立 Session 會自動改綁、native TUI 知道 selected Session，或 SSE 漏接後 OMW 能從歷史
metadata 還原 binding。

## 隔離的開發、測試與驗收入口

Repository 內的 `npm run dev`、`npm run dev:credentials`、`npm run dev:omw -- ...`、`npm test` 與
`npm run acceptance:isolated -- <bounded-command>` 都透過同一套 child environment policy 執行，不修改
呼叫端 shell、使用者 profile、`PATH` 或全域設定。該 policy 只保留 child 啟動所需的 Windows process
keys、`PATH`、locale、CI/color、明示的 executable/test opt-in，以及唯讀使用的
`NODE_EXTRA_CA_CERTS`。它刻意不繼承 `NODE_OPTIONS`，避免 host 透過 preload 或其他 Node flags 將 code
注入隔離 child；也不自動繼承 provider credentials 或其他企業環境設定。Policy 並覆寫：

- OMW data、credentials、launcher token 與 SQLite 所在的 `OMW_DATA_DIR`
- OpenCode 的 `HOME`、`USERPROFILE`、`OPENCODE_TEST_HOME`、XDG directories、absolute
  `OPENCODE_DB`、config directory、`TEMP` 與 `TMP`
- Manager port 與固定 Instance port pool；port 由 isolation root 穩定導出，但不是全域 reservation，hash
  仍可能碰撞。若被 foreign process 佔用只會失敗，不停止或取代該 process

開發環境固定保存在 worktree 的 `.omw/development`，因此同一 worktree 重啟會保留自己的 OMW
與 OpenCode data，但不會讀取日常 `%LOCALAPPDATA%\OMW`、OpenCode DB、credentials、token 或 API target。
每次 launch 都會先 canonicalize isolation root 最近的既存 ancestor，並拒絕 root 或已知可寫 endpoint
中的 symlink、junction、其他 canonical alias 或 `nlink > 1` 的 mutable file，避免既存 reparse point
或 NTFS hard link 將寫入導向日常資料。明示的
`OMW_DEV_SHARED_CONFIG` source 是唯一例外：entry 可經 alias 讀取其 canonical regular file，但只將該檔案
當下的 bytes 寫入受 guard 保護的 private snapshot；read-only source 即使有其他 hard link也不會成為
mutable target，`OPENCODE_CONFIG` 只會指向 snapshot。
第一次啟動前，需在 isolated data root 建立專用 OMW credentials：

```powershell
# 互動式 masked setup，只寫入此 worktree 的 .omw/development
npm run dev:credentials

# 後續啟動重用同一份 worktree-local data
npm run dev

# 啟動或重用同一份 worktree-local Manager
npm run dev:omw

# 透過同一份隔離 context 啟動目前 Project 的 Local TUI；-- 後參數原樣交給 omw
npm run dev:omw -- opencode (Get-Location).Path
```

預設 OpenCode config 是自建的最小 `plugin: []`、`mcp: {}` config，且停用 default plugins、external
skills、model fetch、autoupdate、LSP download 與 Claude Code integration。只有明確設定 absolute
`OMW_DEV_SHARED_CONFIG` 才會 opt in 共用 config：

```powershell
$env:OMW_DEV_SHARED_CONFIG = (Resolve-Path 'C:\path\to\opencode.json').Path
npm run dev
```

此 opt-in 只 snapshot 所選檔案本身，不複製同目錄其他設定、secret 或 plugin 檔案；若 secret 直接寫在
所選檔案內，則它屬於明示選取的 bytes，仍會進入 snapshot。可寫的 `OPENCODE_CONFIG`、
`OPENCODE_CONFIG_DIR`、DB、cache、state 與 temp 全部位於 `.omw/development`，OpenCode 即使 write back
也只會改 private snapshot，原檔不會成為 mutable target。Entry 不轉傳宿主的 API keys、tokens、
passwords 或 auth variables。

Snapshot 位於 isolated config directory；entry 不實作 OpenCode config parser，也不重寫相對路徑，
因此依賴原始 config 所在目錄作為基底的相對引用不受支援，應改用 absolute path 或不依賴該基底的
package identifier。Snapshot 內明示的 plugin／MCP 仍會照 OpenCode 行為執行並可能產生外部副作用；
snapshot 只防止 source write-back，不代表 plugin 安全。使用者必須先檢查內容，需要 provider credential
時應另建 development-only credential，不可依賴自動複製日常 secret。

每次 `npm test` 與 `acceptance:isolated` 都建立不重用的 fresh temporary root，先建立 `OPENCODE_DB`
parent。Generic entry 不會因 direct child exit 就推論 descendants 已全部退出，因此成功或失敗都保留 root
並輸出路徑供診斷；只有知道 process exact identity 的 test/harness owner 證明其 descendants 已結束後，
才能清理該次 root。Test/acceptance 另設定
`OPENCODE_TEST_MANAGED_CONFIG_DIR`；這是綁定 OpenCode 1.18.31 的 test-only capability，不是產品契約，
也不是偵測到 managed config 就拒絕執行。`acceptance:isolated` 只負責 environment、fresh root allocation 與
保留診斷；
傳入的 bounded harness 仍須以 exact identity 管理自己啟動的 process，不能用 port 或 timeout 猜 ownership：

```powershell
npm run acceptance:isolated -- node '<bounded-acceptance-harness.mjs>'
```

## Runtime data

- `OMW_DATA_DIR`：產品／明示 configured startup 預設 `%LOCALAPPDATA%\OMW`；repository 的隔離
  dev/test/acceptance entry 一律傳入 owned override
- SQLite：`<OMW_DATA_DIR>/omw.sqlite`
- OpenCode child stdout/stderr：production 預設 `ignore`，不寫入 OMW data directory、SQLite 或 API
- Runtime diagnostics：不執行為 redaction 目的的全表批次清除或資料 migration。讀取 free-form
  diagnostics 時一律視為不可信；API 僅投影 allowlisted error codes 或 generic error。既有
  `stderr_summary` 不送至 UI，也不由診斷清理流程改寫。`error` 是 Instance 的目前診斷狀態，不是
  歷史 audit log；因此 reconcile、啟動或停止等正常狀態更新會同步更新 `error`。需要隔離開發資料時
  請改用新的 `OMW_DATA_DIR`
- `OMW_OPENCODE_EXECUTABLE`：可選；未設定時依序從已知安裝目錄與 `PATH` 尋找真正的 `opencode.exe`，不接受 API 傳入 executable
- `OMW_INSTANCE_PORT_MIN/MAX`：成對設定的本機 fixed pool；預設 `42000-42099`，最多 128 ports
- `OMW_ALLOWED_ORIGINS`：可選、逗號分隔的 loopback origins；remote mode 另只接受核准的 public HTTPS origin
- `<OMW_DATA_DIR>/credentials.dpapi`：第一次在互動式終端執行 `omw` 時建立的 current-user DPAPI ciphertext，只保存 OMW Basic credential 與 random launcher token

未設定 `OMW_REMOTE_ACCESS=1` 時仍是未啟用 production auth 的 loopback development mode。Remote
mode 需要 DPAPI credentials、明確的 expected loopback origin、tailnet DNS host、Manager HTTPS port、
bounded same-port Instance range 與 `OMW_REMOTE_MAPPING_READY=1`。Fastify 不信任 forwarded headers；
固定 `Host`/`Origin` 對照仍適用。Remote mode 的 `OMW_INSTANCE_PUBLIC_PORT_MIN/MAX` 同時就是
internal fixed pool；OMW 只讀取 Tailscale 狀態與 Serve mapping，不變更 Serve 設定。Launcher token 與 browser Basic auth 是不同
audience。Manager-launched OpenCode 不設定獨立 Basic auth，Manager internal OpenCode API calls 也不送
`Authorization`。因此 OMW Basic 不是 OpenCode endpoint 的 gate；remote deployment 必須以 #9 的
Tailnet policy 將 OpenCode ports 限制為 user devices。

## Local TUI launcher

Repository development 不可直接執行 local package 的裸 `omw`，因為它會使用日常
`%LOCALAPPDATA%\OMW`。請用實際的 development wrapper；它與 `dev:credentials` 共用
`.omw/development`、相同 ports 與相同 child environment policy，`--` 後的 `omw` arguments 原樣傳遞：

```powershell
# PowerShell，工作目錄為 repository root
npm run dev:credentials
npm run dev:omw
npm run dev:omw -- opencode (Get-Location).Path
```

`@sevenflanks/omw` 尚未確認已發布至 public npm registry。只有驗證日常／configured product flow 時，
才從 repository root 建立 local package 並執行下列命令；它們刻意使用日常 data，不是 development entry。
不可把正式 credentials 放入 tracked 檔案：

```powershell
# PowerShell，工作目錄為 repository root
npm ci
$packageDir = Join-Path $env:TEMP 'omw-local-package'
New-Item -ItemType Directory -Force -Path $packageDir | Out-Null
npm pack --pack-destination $packageDir -w @sevenflanks/omw
$omwPackage = Join-Path $packageDir 'sevenflanks-omw-0.1.0.tgz'

# 日常 configured flow：第一次互動建立 credentials；之後重用既有 Manager。
npm exec --yes --package="$omwPackage" -- omw
npm exec --yes --package="$omwPackage" -- omw opencode (Get-Location).Path
```

沒有提供 Project 時，`omw opencode` 使用目前工作目錄；需要既有 Session 時可在實際命令後加上
`-s` 與真實 Session ID。若 `opencode.exe` 不在已知
安裝目錄或 `PATH`，再以 `OMW_OPENCODE_EXECUTABLE` 指定可信任 `.exe` 的絕對路徑。

Manager 與 launcher 必須使用相同 `OMW_DATA_DIR` 與 Windows 使用者。`omw opencode` 不取代原本的 `opencode`。Known subcommands、
`--help`、`--version` 與 non-loopback hostname 會原始透傳且不登錄；Manager/DPAPI 不可用則
fail-open 原始 argv；`OMW_REQUIRED=1`、使用者主動取消初始化，或缺少設定且不在互動式 TTY 時
會以 exit 70 fail-closed。每次 launcher HTTP request 最多 1,500 ms；reservation TTL 為 10,000 ms；
Local TUI 的 15,000 ms readiness 在背景執行。
成功的 managed headless/TUI launch 會明確移除 parent environment 的
`OPENCODE_SERVER_USERNAME` 與 `OPENCODE_SERVER_PASSWORD`；native bypass 與 fail-open 則保留 user
原始 environment，讓獨立原生流程仍可自行明示 OpenCode auth。舊 DPAPI payload 的 `openCode`
欄位可繼續讀取但會被忽略，不會自動 rotation、migration 或刪除檔案，因此升級不需重跑 setup。
要讓已在執行的 OpenCode 套用無 auth 政策，仍須由 user 重啟該 process；OMW 不會自動停止它。
完整 forwarding、ownership 與 reconcile 契約見
[Local TUI launcher contract](security/launcher-contract.md)。

Local TUI 永遠是 observe/open only。Remote mapping 未啟用，或既有 instance port 不在已確認的
same-port range 時，UI 顯示原因且不產生假的 remote URL。

真瀏覽器 integration 需先完成 `npm run build`，再明示本機瀏覽器：
`OMW_BROWSER_TEST=1`、`OMW_BROWSER_EXECUTABLE=<browser executable>`。測試使用 390px viewport，
由 Vue 覆蓋 Shortcut、目錄 traversal、搜尋篩選、Session scope 與 Stop 錯誤。另同時設定
`OMW_REAL_OPENCODE_TEST=1` 與明示 `OMW_OPENCODE_EXECUTABLE` 時，會執行真 Manager runtime 的
Start／Open URL／Stop 窄鏈。每個測試都在同一 test process 的 `finally` 關閉自有 browser、Manager
與已核對身分的 OpenCode process。
Browser 與 OpenCode child 都使用獨立 sandbox environment；只複製必要 Windows runtime keys，
不把宿主的 `OPENCODE*`、`OTUI*`、credential、token、password 或 auth variables 傳給 child。

Manager 正常退出不停止背景 Instance。啟動時所有未停止紀錄都重新核對 PID、creation time、
real executable、port owner、health 與 `/path.directory`；舊 `ready` 不會直接恢復。
若 identity 仍吻合但 endpoint 已失聯，Instance 保持 unreachable 且仍可安全 Stop；若 port 已由
其他 PID 使用則拒絕 Stop。
若 process inspector 明確回報 PID 不存在，且 recorded loopback port 已可 bind，reconcile 會標記
Instance stopped、清除 Stop authority 並釋放 allocation。Inspector 失敗、identity mismatch、PID reuse
或 port 仍被占用都維持 quarantine，不可推論 process 已退出，也不可 Stop foreign process。

Start 後先保留原生 `ChildProcess` handle，但這不會單憑 PID 授予 tree Stop authority。Describe
只有在原 spawn handle 仍存活，且 PID 與明示的 real executable 都吻合時，才保存 creation time
及 executable 作為 exact identity；readiness 或後續 gate 失敗時才能以此 identity bounded tree Stop。
若 Describe 前 root 已退出或無法取得 exact identity，只能透過原生 handle bounded 停止仍存活的
root；不掃描 PID ancestry、不猜測 descendants，並以安全的 `STARTUP_CLEANUP_UNRESOLVED` error
code 記錄無法證明 descendant cleanup。
