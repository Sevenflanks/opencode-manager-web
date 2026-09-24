# #55 OpenCode 相容性 inventory 與重構前成本基線（2026-09-23）

範圍：`refactor/54-agent-foundation` 的 `c6db95a3e01d431cfa94ce2437541a81be0feb51`，以目前 OpenCode adapter 的使用方式建立可追溯清單。以下「controlled」是 Manager 真實 public HTTP handler／SQLite／OpenCodeRuntime HTTP parser 接受自有 loopback protocol fixture 的證據，**不是**原生 OpenCode、真實 Windows process 或瀏覽器 E2E。`#52` 的 `scripts/benchmark-overview-inspect.mjs` 使用真實 Windows Inspect，但其 Summary 為 fixture、直接呼叫 `ManagerService.overview`；不能用來宣稱端對端效能或 OpenCode HTTP 相容。

## 相容性 inventory（現有契約與驗證界線）

| 邊界／OpenCode 能力 | 生產路徑與可觀察契約 | 現有證據；本次證據層級 | #55 未取得的證據／後續驗證 |
| --- | --- | --- | --- |
| CLI／Local TUI 轉發與 Manager boot | `packages/launcher/src/cli.ts`、`packages/launcher/src/manager-cli.ts`；明示 `--port`/`--session` 保留，無 Manager 可 fail-open，`OMW_REQUIRED` fail-closed，既有 Manager 身分核對後才升級 | `packages/launcher/test/cli.test.ts:21-200`、`packages/launcher/test/manager-cli.test.ts:182-305`、`:514-616`；controlled argv／CLI tests | 真實 global shim 或 TUI 中斷需實機；`packages/launcher/test/global-shim.test.ts:33` 為 Windows shim 測試 |
| Headless launch／readiness／process identity／Stop | `apps/manager/src/runtime.ts` 的 `OpenCodeRuntime.launch`, `readiness`, `inspect`, `stop`；精確 PID + creation ticks + executable + port owner；`apps/manager/src/service.ts:962-975` 以 identity gate 保護 Session 操作，`unreachable` 不等同 process 已停止 | `apps/manager/test/api.test.ts:1221-1269`、`:1880-1908`、`apps/manager/test/process-cleanup.test.ts:254-282`；controlled + Windows helper；`apps/manager/test/real-process.test.ts:14-59` 為明示 opt-in 原生 OpenCode | 本次成本 fixture 的 Inspect 是 5ms fake；不得推論 Windows helper 耗時或 Stop 安全性；真 process test 需設 `OMW_REAL_OPENCODE_TEST=1` + `OMW_OPENCODE_EXECUTABLE` |
| Project/Session HTTP 與部分失敗 | `apps/manager/src/runtime.ts:237-247`（`/session`, `/session/{id}/children`），`:283-365`（並行 `/session`, `/session/status`, `/question`, `/permission`；任何失敗降級有型別錯誤），`:368-377`（base64url directory Web URL） | `apps/manager/test/runtime-contract.test.ts:10-51`、`:92-177`、`:245-437`（controlled protocol），`apps/manager/test/api.test.ts:1172-1220`（Manager API）；本次 script 通過真 OpenCodeRuntime parser + loopback HTTP fixture | fixture 未驗證 OpenCode 未來 protocol schema、真實 session latency；重新採樣真 binary 前要隔離 config/data 與 private credentials |
| Primary Session、活動及 Session tree | `apps/manager/src/service.ts:870-959` 將 Summary 限於 instance-bound root；缺失／不明不猜測 idle；由原生活動證據固定 root；children 只按需展開 | `apps/manager/test/api.test.ts:818-1138`、`:1374-1739`；`apps/manager/test/primary-session-real.test.ts:77-100` 為 opt-in real OpenCode SSE；本次 fixture: busy 2、idle 2、status 失敗 1、identity mismatch 1；真 API `/sessions`、`/children` | 本次未開 `/event` SSE，亦未驗證原生 Session 建立或 busy event race；真 SSE test 需 real binary + mock provider |
| Overview／瀏覽器互動／安全 URL | `apps/manager/src/app.ts:106-115` Overview filter；`apps/manager/src/service.ts:62-69` 探測；`apps/manager/src/runtime.ts:368-389` 官方 Web URL 與 remote reason；auth/Origin/CSRF 保護寫入 | `apps/manager/test/api.test.ts:720-754`、`:797-817`、`:1139-1171`；`apps/manager/test/browser.test.ts:42-2205` controlled backend browser（須明示 opt-in）；`apps/web/test/overview-refresh.test.mjs:77-492` 有 browser refresh/競速情境；本次真 Manager route 使用 `inject`，沒有啟動 browser | 本次是 loopback fake protocol，remote Verify 是 1ms fake，未驗證 Tailnet/Serve、真 browser render 或真 OS socket Manager listener |
| 遠端連線 gating | `apps/manager/src/service.ts:919-927` runtime probe 後再驗證 remote URL；`apps/manager/test/connectivity.test.ts:244-433` 涵蓋 TTL/競速/fail-closed | controlled Tailscale CLI fixture；本次只量成本與 calls，不驗證 Serve mapping | 真 Tailnet mapping 必須隔離並明示網路與 credentials；不以 fixture 推論可達性 |

原生／browser 驗證入口參照 `docs/development.md:368-375`，針對同一 checkout 的 `npm run build` 後：browser 設 `OMW_BROWSER_TEST=1` 與 `OMW_BROWSER_EXECUTABLE`；OpenCode 設 `OMW_REAL_OPENCODE_TEST=1` 與 `OMW_OPENCODE_EXECUTABLE`。原生路徑應用專屬 sandbox config/data，既有在用 Instance 及 secrets 不能用作 fixture。這些 opt-in 在本次沒有執行。

## 可重複測量：受控 public API workflow

在 repo root 執行：

```powershell
npm ci
npm run build -w @omw/manager
node scripts/benchmark-manager-workflow.mjs 6
```

Node >=24（`import.meta.dirname`）、可用 localhost loopback port 與編譯後 Manager dist／SQLite native binding 是前提；`npm ci` 僅在此 worktree 未安裝依賴時執行。每次 run 建立專屬 OS temp SQLite／六筆 Instance／六個 root binding／動態 loopback protocol server，結束關閉 app、repository、server 並刪除它**自建**的 temp root。Manager route 透過 Fastify `inject`（public HTTP handler，非 Manager 實際 TCP listener），其餘 `/session` 等以原版 `OpenCodeRuntime` 連 loopback server；不啟動／查詢／停止任何 OpenCode process。OS Inspect fixture 5ms、remote Verify fixture 1ms、OpenCode protocol response 3ms，均為設計輸入，不是實際 OS 或遠端效能。四筆可驗證身份，兩 busy、兩 idle；一筆身份不符、一筆 status HTTP 503。保留 primary scope 部分失敗與健康狀態分離的真 service 路徑。

一次 round 順序：`GET /api/v1/overview?filter=all`、`active`、`unreachable`，`GET /api/v1/instances/busy-a/sessions`，`GET /api/v1/instances/busy-a/sessions/root-busy-a/children`，`POST /api/v1/instances/busy-a/open-url`（明示既有 root、合法 loopback Origin/CSRF）。每 round 斷言全部 6、ready 4／active 2／unreachable 2／stopped 0、root 與 direct child 各一筆、Open URL 既有 root。首 round「cold」是**同一 process** 內第一次 API flight；後續「warm」重用同一 service/database/server/connection，**不是**每輪 fresh process／OS page cache 冷啟動。輸出 JSONL 第一筆記 Git HEAD、branch、dirty entries、OS、CPU、RAM、Node、fixture；之後每 round 記 `wallMs`、6 個 `phases`、`steps` 各自 calls/HTTP、`calls`、`http`、`runtimeMs`（本 round 所有呼叫的累加耗時，並行時不可當 wall time 加總）。JSONL 本身即重新量測可用的原始資料，不需安裝新 benchmark dependency。

### 此次執行結果（#55 重構前）

執行環境：Windows `10.0.26200`、Node `v24.15.0`，Intel Core Ultra 7 255H（16 logical CPUs）、63.2 GiB RAM；HEAD `c6db95a3e01d431cfa94ce2437541a81be0feb51`、branch `refactor/54-agent-foundation`；執行時 dirty entries：`?? docs/acceptance/issue55-opencode-inventory-baseline-2026-09-23.md`、`?? scripts/benchmark-manager-workflow.mjs`；production source 為未修改的該 HEAD。`npm ci` 後 `npm run build -w @omw/manager` 成功。正式執行 `node scripts/benchmark-manager-workflow.mjs 6`，六輪全部 public route HTTP 200，且全部可觀察狀態與 Session assertion 通過。正式結果量測時還有診斷性 HTTP/Inspect 成本 assertion，之後已移除，以便比較優化後的數量；這不影響本次量測路徑與資料。

| round | 類型 | workflow wall ms | Overview all / active / unreachable ms | Roots / Children / Open URL ms |
| --- | --- | ---: | --- | --- |
| 1 | first/cold | 394.371 | 121.809 / 84.543 / 77.469 | 31.869 / 31.233 / 46.314 |
| 2 | warm | 344.194 | 77.755 / 77.763 / 78.853 | 32.564 / 31.686 / 45.388 |
| 3 | warm | 312.964 | 66.639 / 74.918 / 63.790 | 30.271 / 31.078 / 46.139 |
| 4 | warm | 357.162 | 77.504 / 78.632 / 92.388 | 31.988 / 31.051 / 45.392 |
| 5 | warm | 359.235 | 78.011 / 95.116 / 77.834 | 31.259 / 30.315 / 46.542 |
| 6 | warm | 341.596 | 77.169 / 76.774 / 77.889 | 31.890 / 32.068 / 45.657 |
| warm 中位數 | 五輪 | **344.194** | **77.504 / 77.763 / 77.889** | **31.890 / 31.078 / 45.657** |

本次最慢 warm round 為 359.235ms、最快為 312.964ms；不可視為吞吐量或原生 process latency。第六輪的 `runtimeMs` 各自的呼叫數／累加耗時：inspect 21 / 304.156ms、summary 15 / 255.779ms、sessions 17 / 283.650ms、children 1 / 17.209ms；summary 內含 sessions 且 probes 並行，**不可相加**。留存每輪 phase + calls JSONL 可再次跑相同命令獲得；跨機器／版本比較時應同時記輸出的 `head`、`dirtyEntries`、fixture 和環境，只有相同 workload 才比較成本差異。

本次成本計數每 round：三次 Overview 合計 18 inspect + 15 summary、15 `/session` + 15 `/session/status` + 15 `/question` + 15 `/permission`；Roots/Children/Open URL 合計 3 inspect、2 `/session` + 1 `/session/{id}/children`。整輪 21 inspect、19 remoteVerify、15 summary、17 session 讀取、63 次 loopback protocol HTTP（`17+15+15+15+1`）。腳本只斷言可觀察狀態／API 結果，**不**鎖定這些成本數值，重構後的同一 workload 才能測出下降。同一頁三種 filter 仍各自取得新 snapshot、各重複對五筆 verified endpoint 執行四個 HTTP；Open URL 又讀一次 `/session`。這是 #59 可追蹤重複讀取的成本點；不可僅憑計數移除 identity gate、fresh remote verification 或把 status 部分失敗變成 idle。

## 已執行檢查與原生驗證前提

- `node --check scripts/benchmark-manager-workflow.mjs`、`npm run build -w @omw/manager` 通過；`node scripts/isolated-entry.mjs test node --test apps/manager/dist/test/runtime-contract.test.js apps/manager/dist/test/api.test.js`：75 passed / 0 failed。這是 controlled fixture 測試，不代表 native/browser 已跑。測試框架回報保留一份 fresh isolation root 以待 owner-verified cleanup，勿以本票腳本自動刪除。
- 本次 Windows `win32` 可執行 Windows helper 類測試，但本票未執行原生 OpenCode：`opencode.exe` 不在 PATH，`OMW_REAL_OPENCODE_TEST` 與 `OMW_OPENCODE_EXECUTABLE` 均未設定。原生 opt-in 需明示可執行的 Windows PE OpenCode binary、建置完成，並由測試自有 sandbox 與 process cleanup owner 管理生命週期。
- `playwright-core` 為既有 Manager dev dependency；`chrome.exe`/`msedge.exe` 不在 PATH，但此機預設 Chrome `C:\Program Files\Google\Chrome\Application\chrome.exe` 與 Edge `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe` 均存在。`OMW_BROWSER_TEST`／`OMW_BROWSER_EXECUTABLE` 均未設定；瀏覽器測試要先 build 並明示 browser executable，才有真實 browser 的證據。Browser + real OpenCode 聯合鏈還要額外設定兩個 real OpenCode opt-in。所有這些檢查只看存在性和 opt-in 是否設定，未讀取任何 credentials。
