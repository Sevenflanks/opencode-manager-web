# 開發說明

## 邊界

OMW MVP 與 Manager-launched OpenCode 都只監聽 `127.0.0.1`。Remote mode 有 Basic auth、
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
| `GET` | `/api/v1/overview?q=&filter=all` | Shortcut 與 Instance 清單；filter 為 `all`、`active`、`attention`、`unreachable` |
| `GET` | `/api/v1/directories?path=` | 回傳 canonical current、parent 與可存取 direct child directories |
| `POST` | `/api/v1/shortcuts` | 新增 `{ name, directory }` |
| `PATCH` | `/api/v1/shortcuts/:id` | 修改 `{ name, directory }` |
| `DELETE` | `/api/v1/shortcuts/:id` | 只刪捷徑，不影響 Instance |
| `POST` | `/api/v1/instances` | 從 `{ directory }` 啟動全新 Instance，不復用既有 Instance |
| `POST` | `/api/v1/instances/:id/stop` | 只停止 OMW-owned 且當下 identity 仍吻合的程序 |
| `GET` | `/api/v1/instances/:id/sessions` | Project-scoped roots 與 unknown-parent sessions |
| `GET` | `/api/v1/instances/:id/sessions/:sessionId/children` | 載入 direct children；count 只代表本次已載入筆數 |
| `POST` | `/api/v1/instances/:id/open-url` | 由 adapter 產生受控 official Web URL；optional `{ sessionId }` |
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
每次 registry 驅動的 summary、Session、children 與 Open URL 都會先重新核對 exact process identity 與
port owner；不符時不查詢該 endpoint、不顯示其 metadata，也不產生 URL。Health 失聯但 identity 仍
吻合時保留安全 Stop authority。

Session root 僅限沒有 `parentID` 的 metadata。`parentID` 存在但 parent 尚未載入時放在
`unknownParent`，不提升為 root，也不推論 agent provenance 或 Instance ownership。
Open URL 由 1.18.31 adapter 集中產生 `/<base64url(directory)>/session/<session-id>`；UI 不組 route，
沒有明確選擇 Session 時也不猜 latest。

## Runtime data

- `OMW_DATA_DIR`：預設 `<cwd>/.omw`
- SQLite：`<OMW_DATA_DIR>/omw.sqlite`
- OpenCode child stdout/stderr：production 預設 `ignore`，不寫入 OMW data directory、SQLite 或 API
- Runtime diagnostics：不執行為 redaction 目的的全表批次清除或資料 migration。讀取 free-form
  diagnostics 時一律視為不可信；API 僅投影 allowlisted error codes 或 generic error。既有
  `stderr_summary` 不送至 UI，也不由診斷清理流程改寫。`error` 是 Instance 的目前診斷狀態，不是
  歷史 audit log；因此 reconcile、啟動或停止等正常狀態更新會同步更新 `error`。需要隔離開發資料時
  請改用新的 `OMW_DATA_DIR`
- `OMW_OPENCODE_EXECUTABLE`：必填；不接受 API 傳入 executable
- `OMW_INSTANCE_PORT_MIN/MAX`：成對設定的本機 fixed pool；預設 `42000-42099`，最多 128 ports
- `OMW_ALLOWED_ORIGINS`：可選、逗號分隔的 loopback origins；remote mode 另只接受核准的 public HTTPS origin
- `<OMW_DATA_DIR>/credentials.dpapi`：互動式 `npm run credentials:setup -w @omw/manager` 建立的 current-user DPAPI ciphertext

未設定 `OMW_REMOTE_ACCESS=1` 時仍是未啟用 production auth 的 loopback development mode。Remote
mode 需要 DPAPI credentials、明確的 expected loopback origin、tailnet DNS host、Manager HTTPS port、
bounded same-port Instance range 與 `OMW_REMOTE_MAPPING_READY=1`。Fastify 不信任 forwarded headers；
固定 `Host`/`Origin` 對照仍適用。Remote mode 的 `OMW_INSTANCE_PUBLIC_PORT_MIN/MAX` 同時就是
internal fixed pool；OMW 不執行 Tailscale Serve CLI。Launcher token 與 browser Basic auth 是不同
audience。

## Local TUI launcher

先以目前 Windows 使用者建立開發用 DPAPI credential store；setup 會互動詢問 OMW Basic、
OpenCode Basic 與獨立 launcher token，不可把正式 credentials 放入 tracked 檔案：

```powershell
$env:OMW_DATA_DIR = 'C:\absolute\path\to\omw-data'
npm run credentials:setup -w @omw/manager
$env:OMW_LAUNCHER_INTEGRATION = '1'
$env:OMW_OPENCODE_EXECUTABLE = 'C:\absolute\path\to\opencode.exe'
npm run dev
```

build 後可直接呼叫 workspace bin，不安裝或修改使用者／系統 `PATH`：

```powershell
# PowerShell
.\node_modules\.bin\omw-opencode.cmd --port=42001 C:\work\project
```

```bat
rem cmd.exe
.\node_modules\.bin\omw-opencode.cmd --port 42001 C:\work\project
```

Manager 與 launcher 必須使用相同 `OMW_DATA_DIR`、Windows 使用者及
`OMW_OPENCODE_EXECUTABLE`。`omw-opencode` 不取代原本的 `opencode`。Known subcommands、
`--help`、`--version` 與 non-loopback hostname 會原始透傳且不登錄；Manager/DPAPI 不可用則
fail-open 原始 argv，`OMW_REQUIRED=1` 才以 exit 70 fail-closed。每次 launcher HTTP request 最多
1,500 ms；reservation TTL 為 10,000 ms；Local TUI 的 15,000 ms readiness 在背景執行。
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

Start 後先保留原生 `ChildProcess` handle，但這不會單憑 PID 授予 tree Stop authority。Describe
只有在原 spawn handle 仍存活，且 PID 與明示的 real executable 都吻合時，才保存 creation time
及 executable 作為 exact identity；readiness 或後續 gate 失敗時才能以此 identity bounded tree Stop。
若 Describe 前 root 已退出或無法取得 exact identity，只能透過原生 handle bounded 停止仍存活的
root；不掃描 PID ancestry、不猜測 descendants，並以安全的 `STARTUP_CLEANUP_UNRESOLVED` error
code 記錄無法證明 descendant cleanup。
