# Issue #12 真 Manager process A/B isolation 有界驗收

- 驗收日期：2026-09-20
- Worktree：repository root（checkout path supplied by the caller）
- Branch：`feat/issue12-isolation`
- 基準 HEAD：`4ef0b53c55599be6ed7fc92a0fafbf1ac58c2f7a`
- 實作 brief：GitHub Issue #12 comment `5750008578`
- Harness：[`issue12-ab-isolation-acceptance.mjs`](issue12-ab-isolation-acceptance.mjs)
- 結論：**通過**。A、B 是兩個同時存在的真 Manager OS processes，不是同一個 Node process 內的兩個 `ManagerService`。

## Lifecycle 與範圍

Harness 直接執行 source build 的官方 `runManagerCli()` bootstrap contract。唯一注入的是 acceptance-local `spawnManager` owner adapter：仍以 contract 傳入的 `entry`、`detached`、`windowsHide`、`stdio`、`env` 執行 `spawn(process.execPath, [entry], options)`，但保留 current-run `ChildProcess`，讓驗收可在 official bootstrap `preserve()` 後繼續負責 finally cleanup。

每個成功 Manager 在 readiness 後，使用既有 `apps/manager/scripts/process-control.ps1 Describe` 固定 PID、creation-time ticks、executable 與 Manager port owner。正常 Stop 先呼叫該 Manager 自己的 `/api/v1/manager/shutdown`，再等待同一個 retained child exit；若 graceful path 失敗，只允許既有 helper 對同一份 exact binding 執行 Stop。OpenCode Instance 正常走 Manager API Stop；finally fallback 只接受該次 Manager SQLite 內已持久化的 exact PID、creation ticks、executable、port。沒有依 process name、單獨 PID 或廣泛掃描猜測 owner，也沒有把前景 command timeout 當成 background。

- Manager bootstrap deadline：15 秒（產品內部 readiness deadline 10 秒）
- 一般 API deadline：5 秒；Instance startup deadline：25 秒
- exact Stop deadline：10 秒；整體 deadline：120 秒
- 最終通過 run：68,519 ms

Harness 沒有修改 ACL、global environment、profile、firewall、日常 OMW/OpenCode 目錄、UI/TUI、model 或 provider。所有 synthetic root 只在 A/B Manager、OpenCode Instance 與本次 listener owner 都確認停止後刪除。

## A/B 與 active observations

| Check | 結果 | 實際證據 |
| --- | --- | --- |
| 真 Manager A/B | 通過 | 官方 bootstrap 各 spawn 一個不同 PID 的 `apps/manager/dist/src/server.js`；A/B 同時在不同 generated `OMW_PORT` readiness，exact Manager process/port owner 都 matched。 |
| Private data/config/DB | 通過 | A/B root、`OMW_DATA_DIR`、private `OPENCODE_CONFIG`、OpenCode DB、Temp、XDG cache/state、Manager port 與 Instance port range 不同。 |
| Shared-config private snapshot | 通過 | 使用本次 Temp 內 synthetic shared config，`prepareIsolatedEnvironment({ mode: "development", sharedConfigFile })` 複製到兩個 private targets。真 Manager/OpenCode bootstrap 後 shared source hash 不變；A private config baseline 在 A 自己 bootstrap 後擷取，所有 B cases 後仍相同。沒有讀取日常 config。 |
| Real DPAPI/auth identity | 通過 | A/B 各以 Windows current-user DPAPI 保存不同 synthetic username/password/launcher token；兩份 store 都可 round-trip。兩個真 Manager 都從自己的 store bootstrap。Local loopback browser API 依產品設計不啟用 Basic challenge，因此沒有宣稱 cross-Basic rejection。 |
| Launcher identity/token | 通過 | A token 對 A、B token 對 B 的 `/api/v1/launcher/identity` 均辨識為 `omw`；A token 對 B、B token 對 A 均 HTTP 401，`probeManager()` 分類為 `foreign`。 |
| A active baseline | 通過 | 透過真 A Manager `POST /api/v1/instances` 啟動真 OpenCode 1.18.31，再由 `POST /sessions` 建立 synthetic root Session；overview 的 target 為 `ready/stopAllowed`，Session roots API 可讀到該 Session。 |
| B startup success/Stop | 通過 | 真 B Manager 啟動真 OpenCode、建立另一個 Session；B Instance 走 Manager API exact Stop，B Manager 走 authenticated self-shutdown 並確認 retained exact child 與 port 關閉。 |
| B failed startup | 通過 | 對 B private environment 移除 `OMW_INSTANCE_PORT_MAX`，讓真 Manager child 在 server config validation 階段失敗。官方 bootstrap 在 readiness deadline 後失敗，且只清理這次 `spawnManager` 回傳的 current-run owner；B port closed。這不是 fake `ManagerService` 或 post-readiness injection。 |
| B foreign listener collision | 通過 | 在 B Manager port 建立本次 owned foreign TCP listener；官方 bootstrap 回報非 OMW、spawn count 不變、foreign listener 仍活著，沒有停止或取代它。 |
| B startup-lock collision | 通過 | 依 B canonical data directory 的官方 hash contract 建立本次 owned `manager-start.lock` named pipe；官方 bootstrap 在 10 秒 deadline 後拒絕，spawn count 不變、B Manager port仍 closed。 |
| A 不受 B 影響 | 通過 | B success、B Instance/Manager Stop、真 Manager failed startup、foreign listener、startup lock 全部完成後，A Manager exact owner仍 matched；A Instance PID/port/endpoint、Session target、DPAPI ciphertext hash/reload credentials+token、private config hash與 content hash均不變。 |
| 數量與 cleanup | 通過 | A Instances `1 -> 1`、A Sessions `1 -> 1`；A/B Instances、A/B Managers、B failed owner、foreign listener、lock owner全數 stopped，`rootsRemoved=true`。 |

本驗收不比較 live SQLite bytes，也不宣稱它永久不變。SQLite/WAL 可因 A 自身正常 activity 改變；跨環境隔離是由 live Manager health、exact owner、Instance identity、Session target 與 stable credentials/config/content 共同觀察。

## 實際命令與結果

### Target build

```powershell
npm run build --workspace @omw/manager && npm run build --workspace @sevenflanks/omw && npm run build --workspace @omw/web
```

結果：exit `0`。Manager、Launcher TypeScript build 與 Web `vue-tsc`/Vite build 通過；Vite 轉換 2,182 modules，產出 JS 209.67 kB（gzip 71.89 kB）、CSS 39.72 kB（gzip 8.79 kB）、HTML 0.52 kB。

### 最終 target syntax/runtime

```powershell
$env:OMW_OPENCODE_EXECUTABLE='<absolute-path-to-opencode-1.18.31>'
node --check "docs/acceptance/issue12-ab-isolation-acceptance.mjs"
node "docs/acceptance/issue12-ab-isolation-acceptance.mjs"
```

結果：exit `0`；`status=passed`；OpenCode `1.18.31`；elapsed `68,519 ms`。所有 11 個 dynamic checks 與 overall deadline 通過；A Instances `1 -> 1`、A Sessions `1 -> 1`；8 個 cleanup flags 全為 `true`。

### 前一輪交付節點（未重跑）

依使用者指示沿用本次 worktree 前一輪有效證據，不重跑 full suite/typecheck：Manager `127 tests / 121 pass / 0 fail / 6 skip`，Launcher `37 / 37 / 0 / 0`，合計 `164 tests / 158 pass / 0 fail / 6 skip`；`@omw/contracts`、`@omw/manager`、`@sevenflanks/omw`、`@omw/web` typecheck 全通過。

## Harness 開發期間的 lifecycle reconciliation

一個中間版本的 foreign-listener socket 沒有 consume `ECONNRESET`，Node 發生 unexpected exit，導致該 run 的 finally 沒有執行。沒有以 port/PID 猜測清理：先只讀該次 `omw-issue12-manager-ab-*` root 的 Manager SQLite，使用其中持久化的 exact OpenCode PID/creation ticks/executable/port 執行既有 helper Stop；再以該 root 的 DPAPI launcher token probe exact Manager identity，呼叫 official Manager shutdown API。所有 target ports 關閉後，只刪除兩個確認屬於 acceptance 的 exact roots。Harness 隨後加入 socket error consumption 與 `Connection: close`，最終 run cleanup 全綠。

## 未驗證／不宣稱

- 沒有使用真正日常 OMW/OpenCode 環境作為 A；A/B 都是本次 synthetic substitute。
- 驗證了 source-build `runManagerCli()` contract 與真 Manager child；沒有另外驗證 packaged npm artifact 的 path layout，也沒有讓獨立 CLI parent wrapper process exit 後再跨 process handoff ownership。
- 真 bootstrap 有消費 private config snapshot且 shared source hash不變；本 run 沒有觀察到 OpenCode 實際改寫 private snapshot，因此不宣稱動態 write-back case 已發生。
- Browser UI、TUI、model/provider、plugin/MCP side effects、remote/Tailnet Basic auth、自然機器 crash、ACL/VM/container/global interception均未驗證；屬本輪明示排除或 Issue #12 之外。

本次 verifier 只修改上述兩個 `docs/acceptance/issue12-*` 檔案，沒有修改產品來源、測試或設定，也沒有 commit、push 或 PR。
