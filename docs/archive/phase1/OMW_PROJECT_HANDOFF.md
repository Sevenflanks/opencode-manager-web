# OpenCode Manage Web（OMW）專案 Handoff

> **歷史歸檔**：以下內容是 2026-09-17 的早期設計 handoff，不是現行 OMW 契約。
> 其中預設 port、API、資料模型、安全與部署方案可能已被後續實作取代。請以 repository
> root `README.md`、`docs/development.md` 與 `docs/security/` 為準。原始未完成 checklist
> 保持未完成；本歸檔不代表事後驗收通過。

> 文件目的：交接給本地 Agent，作為當時設計、實作、測試與後續演進的主要依據。

> 更新日期：2026-09-17

> 目標環境：Windows 11、本機 OpenCode、手機透過 Tailscale 存取

---

## 1. 背景與目標

使用者平常會在多個本機專案、Terminal 與 OpenCode TUI instance 間工作。希望人在電腦前時維持原本的 TUI 操作習慣，離開電腦後則能用手機統一查看、開啟或建立 OpenCode 工作環境。

理想使用方式：

1. 電腦上常駐一個 OpenCode Manage Web（以下簡稱 OMW）。
2. 使用者照常在 CMD／PowerShell 輸入 `opencode`。
3. PATH 中的 wrapper／launcher 向 OMW 取得 instance ID 與 port，再以前景模式啟動真正的 OpenCode TUI。
4. 這個 TUI 使用其內建 HTTP server，不另外啟動第二個 `opencode web` process。
5. OMW 自動偵測 server 就緒與存活狀態，並在 Dashboard 列出所有 instance。
6. 手機經 Tailscale 開啟 OMW，再由卡片連到各 instance 的官方 OpenCode Web UI。
7. 使用者也能從 OMW 選擇已登錄的專案，啟動新的 headless OpenCode server，之後回到電腦可用 `opencode attach` 接管。

核心定位：

- **OMW 是薄型 control plane**：管理 project、process、port、health、URL 與 lifecycle。
- **官方 OpenCode Web 是主要操作 UI**：MVP 不重做聊天、檔案、permission 等完整介面。
- **Launcher 管啟動；OMW 管真實狀態**：wrapper 的 exit 回報只是加速清理，server health 才是 instance 是否在線的依據。

---

## 2. 成功情境

### 2.1 本機啟動 TUI

```text
使用者在 repo-a 執行 opencode
  → launcher 向 OMW reserve instance/port
  → launcher 啟動真正的 OpenCode TUI + 內建 server
  → OMW probe OpenCode health endpoint
  → Dashboard 顯示 repo-a / READY / Open
  → TUI 結束後 launcher 通知 OMW
  → 即使未通知，OMW 也會因 probe 失敗而標記 OFFLINE
```

### 2.2 手機進入既有 instance

```text
手機 → Tailscale → OMW Dashboard
  → 點 repo-a 的 Open
  → 新分頁開啟 http://<可從 Tailnet 存取的主機>:<instance-port>
  → 使用官方 OpenCode Web 操作原本的 server/session
```

### 2.3 手機啟動新專案

```text
手機 → OMW Projects → 選 repo-b → Start
  → OMW 分配 port
  → 以 repo-b 為 cwd 啟動 opencode serve
  → health probe 成功
  → 顯示 READY 與 Open
  → 回到電腦時可 opencode attach 該 server
```

注意：「啟動 OpenCode instance/server」和「在 server 裡建立 OpenCode logical session」是兩件事。MVP 先完成前者；logical session 仍由官方 Web 建立。後續階段才由 OMW 呼叫 OpenCode API 直接建立 logical session。

---

## 3. 已確定的架構決策

### 3.1 元件

```text
手機 Browser
    │
    │ Tailscale
    ▼
OMW Server + Web UI :4300
    ├─ Project Registry
    ├─ Instance Registry
    ├─ Port Allocator
    ├─ Process Manager
    ├─ Health Monitor
    └─ REST API（必要時再加 SSE）
        │
        ├──────── OpenCode A :51001（本機 TUI 啟動）
        ├──────── OpenCode B :51002（本機 TUI 啟動）
        └──────── OpenCode C :51003（OMW headless 啟動）

本機 shell
    └─ opencode.cmd / shim
         └─ omw-launcher
              └─ 真正的 opencode executable
```

### 3.2 責任切割

| 元件 | 必要責任 | 第一版不負責 |
|---|---|---|
| `omw-server` | project/instance registry、port 配置、process 啟停、health probe、REST、Web 靜態資源 | 完整重做 OpenCode UI |
| `omw-web` | 手機優先 Dashboard、Projects、Start、Open、狀態顯示 | 聊天、檔案編輯、permission UI |
| `omw-launcher` | 判斷是否為 TUI 啟動、reserve、執行真正 OpenCode、轉交 stdin/stdout/stderr、exit 通知、降級 | 判斷 server 是否真正健康、持續 heartbeat |
| OpenCode plugin（後續） | session、model、permission 等豐富事件 | instance discovery、port allocation、process lifecycle |

### 3.3 不採用的設計

- 不在同一個專案同時啟動 `opencode` TUI 與另一個 `opencode web` process。
- 不由 OpenCode plugin 尋找 port 或承擔 instance 註冊。
- 不以 launcher heartbeat 當在線狀態的唯一依據。
- 不用 PID、port 或 project path 當 instance ID。
- 不讓手機 API 任意提交 cwd 或 shell command；只能啟動預先登錄的 project。
- 不直接把服務透過 Router port forwarding 暴露到公開 Internet。

---

## 4. MVP 範圍

### 4.1 必做

1. OMW 常駐於固定 port（預設 `4300`）。
2. 專案登錄：名稱、canonical absolute path、啟用狀態。
3. instance port pool（預設 `51000-51999`）。
4. launcher 能攔截一般 TUI 啟動，取得 port 並以前景模式執行真正 OpenCode。
5. OMW 主動 probe health，維護 `STARTING → READY → OFFLINE/FAILED`。
6. Dashboard 顯示 instance、project、port、啟動方式、啟動時間、最近健康時間。
7. `Open` 以新分頁打開官方 OpenCode Web。
8. OMW 能從登錄 project 啟動 headless OpenCode server。
9. OMW 重啟後能清理過期 registry，並重新辨識由自己啟動且仍存活的 process（至少不能誤顯示 READY）。
10. Tailscale 存取與基本安全設定文件。

### 4.2 明確延後

- OMW 內直接聊天。
- logical session 清單、建立、刪除、abort。
- permission request 推播與批准。
- Git/File/MCP/模型管理。
- 跨多台主機的 distributed registry。
- 排程任務與背景 agent scheduler。
- WebSocket/SSE 即時事件（若 polling 已足夠，MVP 不必做）。
- 完整 PWA 與 push notification。

---

## 5. 執行前必做的相容性驗證

OpenCode CLI 與 HTTP API 可能隨版本變動。本地 Agent 在寫主要程式碼前，必須針對**目前實際安裝版本**完成一次 capability spike，記錄結果與版本，不可只相信本文件中的命令名稱。

至少驗證：

1. `opencode --version`。
2. `opencode --help`、`opencode serve --help`、`opencode attach --help`。
3. 一般 TUI 是否接受 `--hostname` 與 `--port`，且該 process 同時提供 Web/API。
4. headless 模式的正確命令是否仍為 `opencode serve`。
5. health endpoint 是否仍為 `/global/health`，其 response/schema 為何。
6. project metadata endpoint 是否仍為 `/project/current`；需要時確認 `/path`、`/vcs`。
7. OpenCode Web 是否能從手機直接打開指定 server port。
8. server authentication 的實際環境變數、username 預設值與瀏覽器登入行為。
9. `attach` 所需的 URL、directory 參數與 authentication 行為。
10. Windows 下 TUI 的 stdin/stdout/ANSI/resize/signal 是否能透過 launcher 完整運作。

把版本差異封裝在 `OpenCodeAdapter`，不要把 endpoint、CLI flags 與 response parsing 散落在整個專案。

建議介面：

```ts
interface OpenCodeAdapter {
  buildTuiCommand(input: TuiLaunchInput): CommandSpec;
  buildHeadlessCommand(input: HeadlessLaunchInput): CommandSpec;
  probeHealth(baseUrl: string, auth: AuthConfig): Promise<HealthResult>;
  readProject(baseUrl: string, auth: AuthConfig): Promise<ProjectMetadata | null>;
}
```

若實測與本 handoff 不同，以實測的已安裝版本為準，並更新 README 與測試 fixture。

---

## 6. Instance Lifecycle

### 6.1 狀態模型

不要把 availability 與 activity 混成同一欄位。

```text
lifecycleStatus:
  RESERVED | STARTING | READY | STOPPING | OFFLINE | FAILED

activityStatus:
  UNKNOWN | IDLE | BUSY | WAITING_PERMISSION
```

MVP 只保證 `lifecycleStatus` 正確；`activityStatus` 預設 `UNKNOWN`，後續再由 API polling 或 plugin 補齊。

建議 transition：

```text
RESERVED → STARTING → READY → STOPPING → OFFLINE
                  └→ FAILED
READY ──連續 health failure──→ OFFLINE
```

### 6.2 本機 TUI 啟動流程

1. launcher 取得 current working directory 並 canonicalize。
2. 產生 `invocationId`（UUID/ULID），向 OMW reserve。
3. OMW 在 transaction 中分配 instance ID 與 port，建立 `RESERVED` 記錄與短 TTL。
4. launcher 使用 OMW 回傳的 bind host/port，啟動真正 OpenCode child process。
5. child 保持前景並繼承 terminal I/O；launcher 不得破壞互動式 TUI。
6. OMW 將 instance 視為 `STARTING`，每 250-500 ms probe，最長約 15 秒；實作可採 bounded backoff。
7. health 成功後可讀 project metadata，確認 cwd/project 與 reservation 一致，再標記 `READY`。
8. `READY` 後每 10 秒 probe；連續 3 次失敗標為 `OFFLINE`。
9. child 正常離開後 launcher 送 exit/unregister 通知；即使通知失敗，probe 仍會收斂狀態。
10. 離線 runtime record 可保留供歷史/診斷；Dashboard 預設隱藏或折疊，無須立刻 hard delete。

### 6.3 OMW 啟動 headless instance

1. 手機只能提交 `projectId`，不可提交任意 filesystem path。
2. OMW 讀取已登錄且 enabled 的 project path。
3. 分配 instance ID/port，cwd 設為 project path。
4. 啟動 headless OpenCode server，將 stdout/stderr 寫入有大小上限與 rotation 的 log。
5. OMW probe 至 READY 或 timeout。
6. Manager-owned instance 可由 OMW Stop；停止時須確認 PID 仍對應原 process，避免 PID reuse。
7. Windows 結束 process 時應處理 child process tree；只允許停止 `launchMode=manager_headless` 的 instance，除非之後另行設計本機 TUI 的安全終止機制。

### 6.4 Probe 與 source of truth

- launcher 活著不代表 OpenCode server 活著。
- launcher 死掉也不必然代表 server 已死。
- OMW 以 OpenCode health endpoint 的結果判斷 readiness/liveness。
- wrapper exit callback 是 optimization，不是 correctness requirement。
- health timeout、HTTP status、parse error 與最近 response 摘要需留下診斷資訊，但不可記錄密碼/token。

---

## 7. Port Allocation

### 7.1 規則

- 預設 pool：`51000-51999`，必須可設定。
- 分配動作需有 SQLite transaction/unique constraint，避免多個 Terminal 同時 reserve 同一 port。
- 分配前檢查 registry，並嘗試確認 OS port 當下可用。
- OS 可用檢查與 child bind 之間仍有 TOCTOU race；不可宣稱完全消除。
- 若 OpenCode 因 port collision 快速失敗，launcher/OMW 應釋放 reservation，最多重新 reserve/啟動有限次，之後回報明確錯誤。
- `RESERVED/STARTING` 記錄需有 TTL；launcher crash 或未 spawn 時可自動釋放。
- instance ID 使用 UUID/ULID；port 可重用，但 identity 不可重用。

### 7.2 使用者自訂 port/hostname

launcher 不可盲目附加第二組 `--port`/`--hostname`。

建議政策：

- 一般 managed TUI：由 OMW 完全管理 network flags。
- 使用者明確傳 `--port`：reserve request 帶 `requestedPort`，由 OMW 驗證與保留；失敗時說明，不偷偷改 port。
- 使用者明確傳 `--hostname`：先驗證可被手機/OMW 存取；否則要求使用 `--no-omw` bypass。
- 提供 `--no-omw` 或環境變數，讓使用者可完整 passthrough 到真實 OpenCode。

---

## 8. Launcher / Wrapper 規格（Windows）

### 8.1 PATH 與避免遞迴

預期：

```text
PATH 前段：%USERPROFILE%\bin\opencode.cmd
opencode.cmd → omw-launcher.exe（或 node/bun entry）
omw-launcher → 已解析並保存之 real-opencode absolute path
```

禁止 launcher 內再次以裸字串 `opencode` 啟動，否則會叫回 wrapper 造成遞迴。安裝時以 `where opencode` 找出真實 executable，排除 wrapper 本身，將 absolute path 寫入設定；亦可用 `OMW_REAL_OPENCODE` 覆寫。

`.cmd` 應保持極薄：

```cmd
@echo off
@omw-launcher %*
```

不得在 batch 內自行解析 JSON 或實作 lifecycle。

### 8.2 只攔截 TUI 啟動

wrapper 名稱雖是 `opencode`，但不能破壞其他 CLI subcommand。

- `opencode`、`opencode <existing-directory>`、一般 TUI flags：進入 managed launch。
- `auth`、`models`、`attach`、`run`、`serve`、`web` 等已知 subcommand：原樣 passthrough，除非未來明確加入管理。
- subcommand 清單需由目前版本的 `--help` 驗證並寫測試。
- 未知但看似 directory 的第一個 positional argument，應按 path 處理；其餘不確定情況寧可 passthrough 並提示，而非竄改命令。

### 8.3 I/O 與 exit code

- child 必須使用目前 console，繼承 stdin/stdout/stderr。
- Ctrl+C、terminal resize、ANSI color 與互動輸入不可失效。
- launcher 最終 exit code 應等於 OpenCode child exit code；OMW 通知失敗不得蓋掉原 exit code。
- launcher 自己的診斷訊息精簡寫到 stderr，避免污染 TUI。

### 8.4 OMW 無法使用時的降級

預設採 **fail-open**：

```text
OMW 無法連線/timeout
  → stderr 顯示一行警告
  → 直接啟動真實 OpenCode，不附 managed port
  → 本次 instance 不會出現在 OMW
```

可提供 `OMW_REQUIRED=1` 作 strict 模式，reserve 失敗就中止。這可確保 OMW 維護或故障時不會阻止正常開發。

---

## 9. API 草案

統一 prefix：`/api/v1`。以下是當時產品 contract 草案，可依實作框架微調 naming，但不可改變當時記錄的安全邊界。

### 9.1 Launcher reserve

```http
POST /api/v1/instance-reservations
```

```json
{
  "invocationId": "01K...",
  "cwd": "D:\\workspace\\foo",
  "clientPid": 12345,
  "terminal": "cmd",
  "requestedPort": null
}
```

```json
{
  "instanceId": "01K...",
  "port": 51237,
  "bindHost": "0.0.0.0",
  "publicBaseUrl": "http://100.x.y.z:51237",
  "reservationExpiresAt": "2026-09-17T01:23:45Z"
}
```

實作注意：

- OMW 自己產生 `instanceId`。
- 不信任 client 傳入的 host/public URL。
- canonical cwd 由 server 驗證與保存。
- reserve endpoint 使用專屬 launcher token，且優先只監聽 loopback 或限制來源。
- response 絕不可包含 OpenCode server password。

### 9.2 Launcher 回報 spawn/exit（輔助）

```http
POST /api/v1/instances/{instanceId}/spawned
POST /api/v1/instances/{instanceId}/exited
```

spawned payload 可包含 child PID 與 process start timestamp；exited 可包含 exit code。兩者不取代 OMW probe。

### 9.3 Dashboard

```http
GET /api/v1/instances
GET /api/v1/projects
```

### 9.4 Project 管理

```http
POST   /api/v1/projects
PATCH  /api/v1/projects/{projectId}
DELETE /api/v1/projects/{projectId}
POST   /api/v1/projects/{projectId}/start
```

`start` 不接受任意 command/cwd，只使用 project registry 中的設定。

### 9.5 Stop

```http
POST /api/v1/instances/{instanceId}/stop
```

MVP 僅允許停止 `manager_headless` instance。須有 authentication、CSRF 防護/同源策略與操作確認。

### 9.6 前端更新

MVP 可每 3-5 秒 polling `GET /instances`。若之後加入 permission/streaming event，再增設 SSE，例如：

```http
GET /api/v1/events
```

---

## 10. 資料模型草案

建議 SQLite + migration，啟用 WAL。實際 ORM/driver 可依本地 Agent 選定技術棧。

### 10.1 `projects`

| 欄位 | 說明 |
|---|---|
| `id` | UUID/ULID，PK |
| `name` | 顯示名稱 |
| `cwd_canonical` | Windows canonical absolute path，unique |
| `enabled` | 是否允許從 Web 啟動 |
| `created_at` / `updated_at` | 時間 |
| `last_used_at` | 最近啟動時間 |

### 10.2 `instances`

| 欄位 | 說明 |
|---|---|
| `id` | UUID/ULID，PK |
| `project_id` | nullable FK |
| `cwd_canonical` | 啟動 cwd 快照 |
| `port` | instance port；活動狀態下 unique |
| `bind_host` | OpenCode listener bind host |
| `public_base_url` | 手機可用 URL，由可信設定組合 |
| `pid` | child PID，nullable |
| `process_started_at` | 防 PID reuse 的識別資訊之一 |
| `launch_mode` | `local_tui` / `manager_headless` |
| `lifecycle_status` | 見狀態模型 |
| `activity_status` | MVP 預設 UNKNOWN |
| `opencode_version` | probe 取得則保存 |
| `created_at` / `ready_at` | lifecycle 時間 |
| `last_health_at` | 最後成功 probe |
| `consecutive_failures` | 連續失敗次數 |
| `exit_code` | nullable |
| `failure_reason` | sanitized 診斷摘要 |
| `reservation_expires_at` | STARTING 前 TTL |

可以直接用 `instances` 的 `RESERVED` 記錄實作 reservation；不一定要另建 table。

### 10.3 Settings

非機密設定可放 config file 或 table：

- OMW bind address / port。
- OpenCode instance bind address。
- 手機可存取的 `publicHost`（建議明確設定 Tailscale IP/DNS，不取用任意 HTTP Host header）。
- port range。
- health timeout/interval/failure threshold。
- real OpenCode executable path。

密碼/token 不可明文放前端 bundle、URL、log 或 Git；優先使用 environment/OS secret storage。

---

## 11. Web UI 規格

### 11.1 Mobile-first Dashboard

每張 instance 卡片至少顯示：

```text
● insurance-core
D:\workspace\insurance-core
READY · local_tui · :51001
Started 12m ago · health 4s ago
[Open]
```

Manager-owned instance 可再顯示 `[Stop]`。顏色之外必須有文字/圖示，不能只靠顏色表達狀態。

### 11.2 Projects

```text
insurance-core
D:\workspace\insurance-core
[Start]
```

- 相同 project 可允許同時存在多個 instance。
- Start 後顯示 STARTING，READY 後提供 Open。
- 若已有 instance，不要擅自復用；可提示使用者選「開啟既有」或「啟動另一個」。MVP 若要簡化，可預設顯示既有 instance 並另提供明確的 `Start another`。

### 11.3 Open URL

- 由 OMW server 依可信 `publicHost + allocatedPort` 產生。
- 使用新分頁開啟官方 Web。
- 不從 browser 的 `Host` header 或使用者 payload 直接拼 URL，避免 host-header injection。
- 若使用 Tailscale MagicDNS，將 hostname 設為明確設定值。

### 11.4 錯誤呈現

顯示人可理解的分類：

- OMW 無法 spawn OpenCode。
- port bind conflict。
- health timeout。
- authentication/config mismatch。
- project path 不存在或無權限。
- process 已離開及 exit code。

不要把完整環境變數、token 或未清理的 raw stack trace 回傳前端。

---

## 12. 安全設計

OpenCode server 能存取 shell、filesystem、Git credentials、MCP 與 LLM provider，遠端控制權接近本機 shell，安全要求不可視為一般唯讀 Dashboard。

### 12.1 網路

- 僅透過 Tailscale/LAN 受控網路使用，不做公開 Internet port forwarding。
- 優先將 OMW 與 OpenCode bind 到 Tailscale interface/IP；若因 Windows/版本限制使用 `0.0.0.0`，Windows Firewall 必須限制只允許 Tailnet/private profile。
- `publicHost` 必須由設定指定。
- 所有 instance 都應啟用 OpenCode server authentication；credentials 透過 environment 傳遞，不放 CLI args。

### 12.2 OMW authentication/authorization

- Web UI 與 start/stop API 至少需要登入或長隨機 token；不能因為有 Tailscale 就完全無認證。
- mutation endpoint 必須防 CSRF，並檢查 Origin/同源。
- launcher 使用獨立 machine-local credential，不共用 Web token。
- project start 僅能引用 registry ID，並在 server 再驗證 project enabled/path。
- 不提供「任意 shell command」、「任意 executable」或「任意 cwd」的手機 API。

### 12.3 SSRF/Path/Process

- health monitor 只能 probe OMW 自己配置的 host 與 port range，不能接受任意 URL。
- Windows path 要 canonicalize；project registry 儲存 canonical absolute path。
- 停止 process 前同時核對 PID、process start time、launch mode 與 instance record。
- OMW 只自動 kill 自己啟動的 manager-owned process。

### 12.4 Log

- 禁止記錄 password、Authorization header、provider token、完整 environment。
- child log 需 rotation/size cap。
- API error 經 sanitization 後才回前端。

---

## 13. OMW 重啟與恢復

OMW 啟動時：

1. 讀取所有非終止狀態 instance。
2. 對其 configured base URL 做 health probe。
3. health 成功者標 READY，並刷新 metadata。
4. health 失敗者不能因 DB 舊資料維持 READY；標 OFFLINE 或 FAILED。
5. 對 manager-owned process，若 PID 與 start time 仍匹配，可重新接管監控；不匹配就視為 offline。
6. 清理過期 reservation。

注意：若 OpenCode server 需要 ephemeral secret 才能 probe，必須先設計可恢復的 secret 管理；不要將 plaintext secret 為求方便寫入 SQLite。MVP 可採整台機器共用、由 OMW 與 launcher process environment 取得的固定 server credential。

---

## 14. 建議技術方向（非硬性）

若從零開始，建議採 TypeScript monorepo，因 OpenCode 生態與未來 SDK/plugin 整合較直接：

```text
apps/
  server/       OMW API、process、probe、SQLite
  web/          mobile-first SPA
packages/
  launcher/     Windows launcher
  opencode-adapter/
  shared/       DTO/schema/status types
```

可選：Node.js LTS + Fastify/Hono/Express、React/Vite、SQLite。具體框架不是產品需求；優先選本地環境熟悉、能穩定處理 Windows child process 與單檔部署的方案。

第一版避免導入微服務、message broker、Kubernetes 或分散式鎖。這是一台 Windows 開發機上的 local control plane。

---

## 15. 實作順序

### Phase 0：Capability spike

- 驗證 CLI flags、subcommands、HTTP endpoints、auth、Windows TTY。
- 產出 `docs/opencode-compatibility.md`。
- 建立 `OpenCodeAdapter` contract 與測試 fixture。

### Phase 1：OMW core

- config、SQLite migration、project CRUD。
- instance/reservation model。
- transaction-safe port allocator。
- health monitor 與 lifecycle transition。
- `GET /instances`。

### Phase 2：Launcher

- 真實 executable resolution 與 recursion protection。
- TUI vs passthrough 判斷。
- reserve/spawn/exit 流程。
- TTY、Ctrl+C、exit code 測試。
- fail-open 與 strict mode。

### Phase 3：Web MVP

- Dashboard、Projects、Start、Open。
- status polling、mobile layout、錯誤訊息。
- authentication 與 CSRF/Origin policy。

### Phase 4：Headless lifecycle

- project start。
- manager-owned process tracking、log、Stop。
- OMW restart reconciliation。

### Phase 5：可選增強

- OpenCode session list/create/abort。
- plugin/event bridge，補 activity/model/permission。
- SSE、notification、PWA。

---

## 16. 測試計畫

### 16.1 Unit

- 多 concurrent reservation 不會得到同 port。
- reservation TTL 釋放。
- lifecycle transition 合法性。
- Windows path canonicalization 與相同 path 去重。
- CLI argument classification/passthrough。
- user-provided `--port` 不會產生重複 flag。
- public URL 不受 Host header 污染。
- log/response secret redaction。

### 16.2 Integration

- fake OpenCode HTTP server：health 成功、timeout、500、invalid JSON、auth failure。
- server 延遲啟動後由 STARTING 轉 READY。
- READY 連續 3 次失敗轉 OFFLINE，短暫單次失敗不抖動。
- launcher child 快速因 port collision 離開，reservation 被釋放並有限重試。
- launcher exit callback 丟失時，probe 仍正確收斂。
- OMW restart 後不會保留假的 READY。
- manager-owned process stop 不會終止錯誤 PID。

### 16.3 Windows E2E

1. CMD 啟動 `opencode`，TUI 正常互動。
2. PowerShell 啟動 `opencode .`，TUI 正常互動。
3. 手機經 Tailscale 看見 instance 並打開官方 Web。
4. 手機從 Projects 啟動 headless instance。
5. PC 使用 `opencode attach` 接上 headless instance。
6. 關閉 Terminal、Ctrl+C、OpenCode crash、OMW crash/重啟等情境。
7. 同時開 5-10 個 Terminal，port/identity 不衝突。
8. OMW 停機時 launcher fail-open，仍能正常使用 OpenCode。

---

## 17. MVP 驗收條件

- [ ] 平常輸入 `opencode` 的操作習慣不變，互動式 TUI 無明顯退化。
- [ ] 本機開啟的每個 managed TUI 在 15 秒內出現在 Dashboard，並有獨立 instance ID/port。
- [ ] 同一 project 可同時開兩個 instance，且兩者不互相覆蓋。
- [ ] 手機透過 Tailscale 能從 OMW 一鍵開啟指定 instance 的官方 Web。
- [ ] 手機能對已登錄 project 啟動 headless instance。
- [ ] health 失敗會自動從 READY 收斂到 OFFLINE；不依賴 launcher heartbeat。
- [ ] TUI 正常/異常退出都不會永久占用 port reservation。
- [ ] OMW 無法使用時，預設不阻止使用者啟動原始 OpenCode。
- [ ] 非 TUI subcommand 不被 wrapper 破壞。
- [ ] Web 端無法提交任意 command、executable、host、URL 或 cwd。
- [ ] OMW/OpenCode 服務沒有直接暴露到公開 Internet，且具備 authentication。
- [ ] OMW restart 後不顯示 stale READY。

---

## 18. 待確認事項

本地 Agent在 capability spike 或實作中，若以下選項會明顯改變設計，應先向使用者確認；其餘可依本文件合理決策。

1. OMW 與各 OpenCode instance 要 bind Tailscale IP，還是 `0.0.0.0` + Windows Firewall？偏好前者。
2. OMW Web authentication 採單一密碼、Tailscale identity-aware proxy，或兩者並用？MVP 至少需一層明確認證。
3. 真正 OpenCode executable 的安裝來源與實際 path（npm/bun/Scoop/其他）。
4. Headless instance 是否需要電腦重開機後自動恢復；MVP 可先不自動重啟，只做狀態 reconciliation。
5. UI 的 Stop 是否只限 OMW 啟動的 headless instance（本 handoff 預設是）。
6. 專案 registry 要手動加入，或掃描指定 workspace roots；MVP 建議手動加入，避免掃描過廣。
7. 是否要把 OMW 安裝成 Windows Service/Task Scheduler 自動啟動；產品目標是常駐，但部署方式可在 MVP 後段決定。

---

## 19. 參考資料

- OpenCode CLI：<https://opencode.ai/docs/cli/>
- OpenCode Server：<https://opencode.ai/docs/server/>
- OpenCode SDK：<https://opencode.ai/docs/sdk/>
- OpenCode Plugins：<https://opencode.ai/docs/plugins/>
- 架構相近但僅供參考的 PoC：<https://github.com/justinmoon/opencode-ui>
- 功能較重的既有 Manager：<https://github.com/chriswritescode-dev/opencode-manager>

不要直接複製第三方專案而忽略其授權、維護狀態與安全模型。優先保留本設計的薄 control-plane 邊界。

---

## 20. 給接手 Agent 的歷史工作指令

以下保留原 handoff 的歷史指令，僅供理解當時意圖；目前 agent 應遵循 repository 現行
`AGENTS.md` 與權威文件。

1. 先檢查工作目錄是否已有 repo、README、AGENTS.md、未提交修改與既有技術棧；保留使用者變更。
2. 不要立即開寫完整 UI。先完成 Phase 0，提交/呈現實測相容性結果與最小 vertical slice：`reserve → spawn → health READY → list`。
3. 遇到 OpenCode 實際 CLI/API 與文件不一致時，以本機版本實測為準，將差異集中在 adapter。
4. 不要把 password/token 寫進 repo、CLI argument、URL 或 log。
5. 每一階段都以 Windows 實機與手機 Tailnet 路徑驗證，不只做 mock。
6. 任何會開放任意 shell/cwd/URL、公開 Internet 存取或大幅擴張 MVP 的做法，先停下來向使用者確認。
7. 完成 MVP 後，再評估是否真的需要 OpenCode plugin；plugin 只補事件與 metadata，不接管 instance discovery。
