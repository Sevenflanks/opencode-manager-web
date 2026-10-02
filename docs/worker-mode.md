# Linux Worker：Docker Compose 操作與驗收

本文件涵蓋 #100 的單一 Linux Worker deployment，以及 #101 的原生 OpenCode Web 入口與手動 ChatGPT 驗收。Compose 不是 Desktop launcher；本輪不包含 #102 的 Kubernetes。

## 版本與執行模型

- Image：`deploy/worker/Dockerfile`，Node **24.14.0** / Debian bookworm，OpenCode **1.18.34** 固定版本，build 時核對 `opencode --version`。預設 tag `omw-worker:1.18.34`。
- 在 build stage 執行 `npm ci`、`npm run build`，包含真正的 Vue Web `apps/web/dist`，`OMW_WEB_ROOT=/opt/omw/apps/web/dist`。Desktop launcher workspace 的 `os: win32` 僅由 `scripts/worker/prepare-build.mjs` 在 build stage 的 manifest／lockfile **副本**移除，不修改 repo，也不在 Worker 執行 desktop launcher。
- 基本工具有 Git、Bash/POSIX shell、Node/npm/npx、curl、OpenSSH client、ripgrep、jq、unzip、procps。需要 Python、Java、Go 等專案工具時，自行擴充 image 並 pin 版本；不預裝龐大語言工具鏈。
- `manager`：直接 `node apps/manager/dist/src/server.js`，管理 DB、directory/shortcut/instance/session/readiness 投影。
- `execution`：直接 `node apps/manager/dist/src/worker/execution-server.js`。`init: true` 的 Docker init 是 PID 1，Node 是其直接 child。OpenCode 與所有工具由 supervisor 的專用 PID namespace ownership 覆蓋，Stop 不只終止 root／process group。
- 一個 Worker 同時管理一個 OpenCode Instance。manager restart 保留 execution 的 epoch／Instance identity，不能 restart execution 來模擬 manager restart。
- execution recreate／退出後舊 epoch inspect 為 unknown，OMW 可顯示 unreachable；不把未知狀態當成 stopped 或自動恢復工作。

不要改成 `npm start`／shell wrapper 啟動 execution，不設定 `pid: host`、shared PID、`privileged`，不掛 Docker socket，不在 live execution 執行 healthcheck、`docker exec` 或外部測試程序；namespace Stop 的範圍包括所有非 init／supervisor 的程序。Compose 只在 manager 做 HTTP healthcheck。

## Ports、origins 與持久化

| 服務 | container port | host 預設 | 用途 |
| --- | --- | --- | --- |
| manager | 4174 | `127.0.0.1:4174` | OMW UI/API，Browser Basic auth |
| execution native gateway | 4180 | `127.0.0.1:4180` | OpenCode root-origin UI、HTTP stream／WebSocket，Browser Basic auth |
| execution control | 4175 | **不 publish** | manager → execution，外部檔案 token，拒絕 Browser Origin |
| OpenCode | 4096 | **不 publish** | execution container 的 `127.0.0.1`，內部隨機 credential |

`worker.env` 可設定 `OMW_MANAGER_HOST_PORT` / `OMW_NATIVE_HOST_PORT`；同時更新 `OMW_PUBLIC_ORIGIN` / `OMW_NATIVE_ORIGIN`，兩個 origins 必須不同。origin 是無子路徑、query、fragment 的 root URL；HTTP 只接受 `127.0.0.1`，遠端須 HTTPS。Publish 固定在 host loopback；若另有 operator-owned HTTPS ingress，兩個 root origins 與 Host/Origin 必須保留，支援 streaming 與 WebSocket，不把 internal control／runtime 暴露出去。此部署不包含 ingress／cluster 設定。

| named volume | mount | 保留內容 |
| --- | --- | --- |
| `manager-data` | manager `/data/manager` | OMW SQLite、shortcuts、instance identity/history |
| `execution-home` | execution `/home/node` | HOME、XDG data/config/cache、原生 provider auth 與 sessions |
| `workspace` | **兩服務相同** `/workspace` | repositories、工具輸出、未提交檔案 |

HOME `/home/node`、XDG_DATA_HOME `/home/node/.local/share`、XDG_STATE_HOME `/home/node/.local/state`、XDG_CONFIG_HOME `/home/node/.config`、XDG_CACHE_HOME `/home/node/.cache`。Image 使用非 root `node` (UID/GID 1000)，上述目錄連同 `.local` 由 image 預先配置 ownership，新 named volumes 繼承該權限，避免 OpenCode 首次啟動因無法建立 state 而退出。固定 image 的 recreation 不會刪 volumes；process identity 不持久化成可重新使用的 authority。

## 外部秘密初始化

先安裝 Docker Desktop（Linux engine）／本機 Linux Docker Engine、Compose v2 與 Node 24。所有命令在 repository root 執行。範例 PowerShell：

```powershell
# 目錄必須不存在，且在 repo 外；setup 不覆寫既有設定。
node scripts/worker/setup.mjs "C:/Users/<user>/AppData/Local/omw-worker-local"
$envFile = "C:/Users/<user>/AppData/Local/omw-worker-local/worker.env"
docker --context desktop-linux compose --project-name omw-worker-local --env-file "$envFile" -f deploy/worker/compose.yaml build manager
docker --context desktop-linux compose --project-name omw-worker-local --env-file "$envFile" -f deploy/worker/compose.yaml up -d --no-build --wait --wait-timeout 120
```

`setup.mjs` 產生 cryptographic random `execution-token`（64 字元）、`browser-password`（43 字元）與 `worker.env`，username 預設 `worker`；只輸出路徑，不輸出 secret。Linux 檔案 mode 0600、目錄 0700；請以能讓 container UID 1000 讀取 bind-mounted secret 的 operator UID 初始化（Compose file-backed secrets 的 uid/gid/mode 不會替 host 檔案調整 ownership）。Windows 請使用自己的 user-profile 私有目錄與既有 ACL，不放共用目錄。若改用自行管理檔案，token 至少 32 字元、browser password 至少 16 字元，檔案需 absolute regular、單行；env example 是 `deploy/worker/.env.example`。

`worker.env` 只存外部檔案路徑，Compose secrets 分別 mount 至 `/run/secrets/execution_token` 與 `/run/secrets/browser_password`。不要把 host OpenCode/ChatGPT credentials mount 進來，不傳 provider token 於 env、命令列或 Git，不公開 `compose config`、secret 檔案或帳密。根 `.dockerignore` 採 source allowlist，排除 host auth、秘密、runtime／測試資料。

本地 manager URL `http://127.0.0.1:4174`；由自己的終端私下讀取 `browser-password`，在 browser Basic prompt 使用 `worker` 與該 password。需要自訂 username/ports 可在啟動前修改 `worker.env`。OMW 與 native 都須 Browser Basic；不要在 URL 內嵌帳密。

部署長跑 owner 是啟動服務的 operator，Stop 方法：

```powershell
# OMW UI 的 Stop 僅停 Instance／工具，不停 Compose。
# Compose down 停服務且保留使用者 named volumes；不要加 --volumes。
docker --context desktop-linux compose --project-name omw-worker-local --env-file "$envFile" -f deploy/worker/compose.yaml down --timeout 15
```

## 正常使用與原生 ChatGPT 認證

1. 開啟 OMW，瀏覽 `/workspace`。使用自己的 repository URL 取得專案：首次可在尚無 Instance 的 execution 使用 bounded one-shot `compose run --rm --no-deps execution git clone <repository-url> /workspace/<project>`，或由已啟動的原生 OpenCode 使用工具取得專案。不要複製 host auth、將 credentials 放 URL，或在 live execution 用 `docker exec` 改工作內容。
2. 建立 Directory Shortcut，選擇 `/workspace/<project>`，Start。OMW 顯示 readiness/version；建立 session，再用 Open URL 開啟不同 root origin 的原生 Web。
3. 在原生 Web 的 provider/connect 流程選 **OpenAI → `ChatGPT Pro/Plus (headless)`**。1.18.34 的 `packages/opencode/src/plugin/openai/codex.ts` 明確提供這個 method：原生 flow 取得 device user code，使用者在自己的 browser 開啟 **`https://auth.openai.com/codex/device`**，輸入畫面上的 code，登入並完成授權，再回原生 Web等待連線成功。
4. 不選 `ChatGPT Pro/Plus (browser)` 的 container localhost callback flow；那個 method 使用 `localhost:1455/auth/callback`，本部署沒有 publish 1455。Headless method 無需追加 callback port。
5. Provider credentials／refresh 由原生 OpenCode plugin 管理並寫入 execution XDG data。不得擷取 auth JSON、refresh/access token、provider response 或 device code 作為證據。若有 UI 版本差異，以固定 image 的實際畫面為準；本 agent 未登入，UI 的完整互動仍須使用者最後驗收。
6. 選訂閱授權可用 model，執行真實聊天，再要求一項會在 `/workspace/<project>` 寫入檔案的工具操作，核對輸出與檔案。此步須有真實 LLM 回覆與工具結果才可算 #101 的真實工作驗收。

固定版本 source：<https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/plugin/openai/codex.ts>。這是認證方式的靜態核對，不是實際帳號／LLM 成功證據。Browser auth secrets 是 OMW gateway 登入用，與 provider OAuth 是不同資料。

原生 Web 在手機版可由 Home → Settings → Providers → OpenAI 那列的 Connect 進入方法清單。固定 backend `1.18.34` 本次提供的官方 Web assets 在 Settings 顯示 `v1.18.33`；驗證時應分別記錄 backend 與 Web 顯示版本，不將兩者當成同一個版本證據。

原生 root origin 代表此 Worker 的唯一 current Instance，不是永久綁定某個 execution generation 的網址。Stop 後舊頁面／bookmark 不再綁定舊 Instance；再次 Start 後可能連到目前 Instance。請從 OMW 重新開啟並確認 Project／Session；可見舊 Session 不代表舊工作已恢復。

## 自動 bounded Compose 驗證

```powershell
node scripts/worker/verify-compose.mjs --context desktop-linux
# 來源 tree 穩定後，加上真實 mobile browser／native UI 證據（使用已安裝 Chrome，不下載 browser）。
node scripts/worker/verify-compose.mjs --context desktop-linux --browser
# 其他 Chrome/Chromium 路徑可明確指定：--browser-executable "C:/path/to/chrome.exe"
```

必須傳 explicit local context，runner 拒絕 TCP／SSH 遠端 context，不依賴 `docker context use`，也清除 child 的 `DOCKER_*` / `COMPOSE_*` / `OMW_*` override。Runner 逐輪 random `omw-verify-<16hex>` project/image、動態 host loopback ports、外部合成秘密與全新的 named volumes，不讀取 operator 設定／provider auth。HTTP／Docker 驗證使用 Node built-ins；`--browser` 使用專案既有 `playwright-core`，新建隔離 context 與 OS temp HOME/XDG/profile，不接觸人類 browser profile；合成 Basic password 只在記憶體中套用到本輪兩個 loopback origins，不輸出命令列、URL、storage state 或環境快照。

預設 build deadline 12 分鐘、Compose readiness 120 秒、HTTP request 20 秒、整輪工作 20 分鐘上限；每個 Docker CLI 有 deadline。Owner 透過 Compose project label／本輪 image tag 清理，`finally` 執行 scoped down，確認本 project 的 containers/networks/volumes 與 image tag 都已移除。獨立 watchdog 在 22 分鐘後再次 scoped cleanup，供 parent／tool 被中斷的情況；正常成功 cleanup 後 runner 停掉自己的 watchdog。若 cleanup unresolved，保留 watchdog ownership record、secret path 供該 owner 重試，不可報清理成功。

測項：

- Config boundary：init、直接 node entrypoint、隔離 PID、只有 manager/native loopback publish、control 私有、volume layout。
- 從當時 worktree build image；保存 source hashes、HEAD 與 dirty paths，證據只代表該輪 tree，不代表並行 agent 之後的最終修改。
- 專用 `docker run --init --network none` execution fixture：**直接** `node apps/manager/dist/test/worker-supervisor-linux.test.js`，要求 2 pass、0 skip、0 fail；驗證 detached orphan cleanup、stale Stop 不能碰 replacement，以及 startup failure 清除殘留工具。禁止改成 `node --test` 使 test worker 不再是 init 直接 child。
- 真正 OMW HTTP API：browse、shortcut、Start、inspect、session create/list、Open URL、Stop；native `/global/health` 核對真 OpenCode 1.18.34。
- native `/event` live SSE：在有界 deadline 收到 `server.connected` 第一事件、核對 `text/event-stream` 後取消 reader，不記錄 event payload。固定版本契約見 [event handler](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts)。
- `--browser`：真 Compose mobile OMW browse／Start／New Session／原生 session app（真 JS/CSS assets）／Stop，並只檢視 native OpenAI／ChatGPT headless 方法清單，**不點 OAuth method**。保留 `omw-ready.png`、`native-session.png`、`native-openai-methods.png`；記錄真 UI 的 SSE response 與 WebSocket call/frame 計數（沒有 WS call 時不宣稱已驗證 WS）。browser 有 150 秒工作期、context/browser 有界 `finally` close；若失敗仍清理 Docker，本輪結果為 failed。
- Basic unauthenticated、cross-origin、CSRF、control 無 auth／帶 Browser Origin 拒絕。
- manager restart 前後 live execution identity 相同；wrong Instance/epoch Stop 拒絕，correct Stop inspect confirmed not-found。
- execution exit／recreation 舊 epoch unknown、OMW unreachable、不自動復活。
- 同 image／volumes recreation 後合成非 auth 的 HOME/XDG/workspace 檔案、未提交檔案與 manager DB 保留；從 **OMW 公開 resume API** 明確手動接續已有 primary Session，取得不同 Instance id／epoch；舊歷史仍 unreachable、舊 Stop 拒絕且不能碰新工作。在原生 session/list/message HTTP API 看見原 Session 與相同 message history（無自動 prompt replay），最後透過 OMW Stop 確認停止。這裡是未送 prompt 的新 Session，evidence 記錄實際 message 數量；不代表真實聊天內容或 provider auth 持久化證據。
- authenticated `GET /api/v1/worker/capacity` 是 `no-store`：新 epoch 空 namespace available、活躍 Instance occupied、execution 不可達 unknown；occupied／unknown 的 Start 拒絕。Same-epoch pending／lost-response 與 recreation orphan 的 fail-closed 行為另由 backend／Linux fixture 驗證。

Runner 不向 live execution 插入外來程序；需要控制探測時，`control.mjs` 在 manager container 透過正式 private HTTP control API 呼叫，token 只在該 process 記憶體中使用。Seed／檔案持久化 probe 是獨立 one-shot container；不污染 live supervisor namespace。

輸出顯示 evidence JSON 的 OS temp path，含逐項結果、sanitized failure message／stack、source hashes、image/version、lifecycle／cleanup 查詢、`screenshotReferences`（未指定 `--browser` 時為空，並明確記錄 gap）。圖檔位於同一 OS temp evidence directory；逐步 screenshot 只代表其標示的 outcome，前一步成功不會掩蓋後續 provider UI 或 cleanup failure。合成秘密不輸出，正常 cleanup 後刪除；保留 JSON、截圖與 ownership metadata 供整合驗收。Runner 不 global prune、不刪 operator project 的資料 volumes、不移除 base images／build cache。

## 最後手動驗收與已知證據缺口

自動 runner 通過不等於 #101 完成。最後必須在 frontend/backend 最終 tree rebuild 後，使用者於自己的 browser 完成：

1. OMW browse/shortcut/Start/Open URL／Stop 主要 UI；native protected root UI、HTTP streaming／WebSocket 正常。
2. 上述真實 ChatGPT headless device auth、model reply、實際工具修改檔案；證據只記 provider/model label、success 與檔案內容摘要，避開任何 auth 畫面/code/token。
3. **真實聊天或工具仍執行中**時 `compose restart manager`，execution identity/session不中斷，回 OMW 仍可觀察；idle process identity 證據不能替代 in-flight 工作。
4. 同 image container recreation，確認原生 provider 仍已連線、session 及未提交檔案保留；必要時正常原生 refresh，不讀 auth 檔案。
5. 正常 Stop 與 orphan 工具 Stop 的實際完成；execution 退出後 unknown/unreachable、無自動續跑。

若 execution recreated，舊 epoch 的 Instance 保留為 unknown／unreachable 歷史，不把它改成 stopped。確認新 epoch namespace 為 available 後，使用者可在 OMW 明確選擇「啟動全新 Instance」，或對已有入口 Session 的舊紀錄選「接續對話」；manager 在這次手動操作中核對 allocation 並建立新 id／epoch。接續只重新綁定既有 Session，不自動重送 prompt／恢復工作。Same-epoch pending／lost-response 或 namespace 尚有 orphan 時容量仍 unknown／occupied，Start／resume fail closed。不要刪 DB／volume、猜 PID 或繞過 OMW private control start。

## 擴充與更新

可建立自有 Dockerfile `FROM omw-worker:1.18.34`，以 root 安裝 **專案必要且固定版本**工具後切回 `USER node`；自建時修改 `OMW_WORKER_IMAGE`，維持 `/opt/omw` 路徑、entrypoint、UID/GID 與 volumes 契約。不要加 Docker socket、host credential mount 或 host/shared PID。升級 OpenCode/Node 應更新固定版本與重新跑上述 namespace、native、session、真實 auth/work tests，不用浮動 `latest`。
