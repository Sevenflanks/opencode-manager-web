# #59 效率與相容性驗收（2026-09-23）

## 方法及可歸因界線

以 `docs/acceptance/issue55-opencode-inventory-baseline-2026-09-23.md` 的六步 public HTTP workflow、同一 `scripts/benchmark-manager-workflow.mjs`、同機兩組各六輪比較。基線為 HEAD `c6db95a3e01d431cfa94ce2437541a81be0feb51`，當時 dirty 僅 `?? docs/acceptance/issue55-opencode-inventory-baseline-2026-09-23.md`、`?? scripts/benchmark-manager-workflow.mjs`，production source 未修改；現況 HEAD `f618ce5fe06288182b8155e69c426c560d8b075e`，branch `refactor/54-agent-foundation`。實測於 Windows `10.0.26200`、Node `v24.15.0`、Intel Core Ultra 7 255H（16 logical CPUs）、63.2 GiB RAM，同一 worktree、build 並完成相關測試後**順序**執行 `node scripts/benchmark-manager-workflow.mjs 6` 兩次，兩組 benchmark 未彼此並行。每組首輪 cold 是同一 process 第一次 API flight，不是 fresh OS process；後五輪 warm 重用 Manager／SQLite／loopback fixture。

後測量測時 worktree dirty：`M apps/manager/src/runtime.ts`、`M apps/manager/src/service.ts`、`M apps/manager/test/api.test.ts`、`M apps/web/src/App.vue`、`M packages/contracts/src/index.ts`、`M packages/launcher/THIRD_PARTY_NOTICES.md`、`M packages/launcher/src/cli.ts`、`M packages/launcher/test/global-shim.test.ts`、`?? apps/manager/src/agents/opencode/runtime.ts`、`?? apps/manager/src/capabilities.ts`、`?? apps/manager/src/overview.ts`、`?? apps/manager/src/process-control.ts`、`?? apps/manager/src/session-projection.ts`、`?? apps/manager/test/manager-process-lifetime.fixture.ts`、`?? apps/manager/test/manager-process-lifetime.test.ts`、`?? apps/web/src/overview-refresh.ts`、`?? packages/launcher/src/agents/opencode/executable.ts`。上述包含其他 agent 的工作；測量時間無同時起動本 agent 的其他測試，但不能證明整台主機當時完全無其他執行負載。#59 實作前在整合後 worktree 曾量得 warm median 340.769 ms（單組來源為任務交接，無逐輪原始資料），相較 #55 的 344.194 ms 並不足以聲稱重構本身改善。

量測 scope 為 Fastify `inject` 真 Manager public handler + 原版 OpenCodeRuntime HTTP parser 對 loopback protocol fixture，isolated SQLite 六個 Instance／六個 root、四個 verified／一個 identity mismatch／一個 summary status 503，兩 busy、兩 idle。OS Inspect 5 ms、remote Verify 1 ms、protocol response 3 ms 均為假 fixture；未量真 OS helper、真 Tailscale、原生 OpenCode latency、Browser／手機或 TCP Manager listener。`runtimeMs` 是各呼叫累加耗時，並行呼叫不可作 wall time 加總。原始 JSONL 可用下方命令重產；下表保存兩組所有 round 的 wall 及 phase 值。

## 瓶頸及實作

整合後 `apps/manager/src/overview.ts` 對同筆已 Inspect 的 Instance，原本 `await runtime.summary(record)` 完成後才開始 `verifyRemoteUrl(record.port)`；三次 Overview filter 各有五個 verified Instance summary，串行尾端會疊加 remote 等候。現於 Inspect 返回／失敗後立即啟動**本次** remote 驗證，立即接上 rejection handler，與已核對身分之 summary 獨立等待；完成兩者後才投影 HTTP response。Inspect gate 不跳過、summary 仍需身分核對才讀取、identity 失敗仍走原本 remote verification；failed remote 仍呈現「Tailscale Serve 映射尚未通過驗證。」；snapshot 和 cross-request freshness 不加 cache，既有四個 probe worker 不增加。停止／remote operation 的安全策略未修改。HTTP controlled regression 實測 blocked summary 時 remote 已啟動、兩種完成先後仍等雙方，remote 先失敗也不使回應提前，identity 不符仍有新 remote check。

## 前後數據（ms）

| 來源／輪 | workflow wall | Overview all / active / unreachable | Roots / Children / Open URL |
| --- | ---: | --- | --- |
| #55 基線 1 cold | 394.371 | 121.809 / 84.543 / 77.469 | 31.869 / 31.233 / 46.314 |
| #55 warm 中位數（2–6） | **344.194** | **77.504 / 77.763 / 77.889** | **31.890 / 31.078 / 45.657** |
| 後測 A 1 cold | 347.986 | 117.517 / 61.611 / 60.731 | 28.489 / 31.389 / 47.877 |
| 後測 A 2 warm | 295.912 | 61.902 / 62.177 / 61.084 | 32.484 / 30.834 / 47.272 |
| 後測 A 3 warm | 301.634 | 64.746 / 63.047 / 62.095 | 31.705 / 33.099 / 46.827 |
| 後測 A 4 warm | 296.666 | 62.783 / 62.382 / 63.179 | 31.228 / 31.526 / 45.446 |
| 後測 A 5 warm | 296.907 | 63.728 / 62.098 / 62.834 | 30.767 / 31.185 / 46.172 |
| 後測 A 6 warm | 295.832 | 62.645 / 62.270 / 62.494 | 30.779 / 31.344 / 46.177 |
| 後測 A warm 中位數 | **296.666** | **62.783 / 62.270 / 62.494** | **31.228 / 31.344 / 46.177** |
| 後測 B 1 cold | 325.072 | 96.631 / 58.133 / 63.596 | 29.057 / 31.011 / 46.320 |
| 後測 B 2 warm | 296.854 | 62.976 / 65.794 / 58.808 | 31.007 / 31.444 / 46.665 |
| 後測 B 3 warm | 301.062 | 64.310 / 64.306 / 61.032 | 31.693 / 31.348 / 48.230 |
| 後測 B 4 warm | 300.643 | 65.409 / 62.730 / 61.859 | 30.620 / 32.074 / 47.824 |
| 後測 B 5 warm | 301.790 | 65.687 / 64.482 / 63.158 | 28.702 / 31.670 / 47.933 |
| 後測 B 6 warm | 299.821 | 63.555 / 63.089 / 62.883 | 31.753 / 31.771 / 46.643 |
| 後測 B warm 中位數 | **300.643** | **64.310 / 64.306 / 61.859** | **31.007 / 31.670 / 47.824** |

相對 #55 warm median 344.194 ms，A 下降 47.528 ms（13.81%）、B 下降 43.551 ms（12.65%）；相對交接中的整合後 warm median 340.769 ms，下降 44.103／40.126 ms（12.94%／11.77%）。此為受控相同流程兩次後測的**觀察值**，不將整個差距歸因於這一行為變更，亦不推論原生系統的百分比；每組只有五筆 warm，不計算或宣稱穩定 p95。Overview phase warm median 對基線三個 filter 均下降，非 Overview phase 沒有一致下降。

每 round 後測 A/B 均為 inspect **21**、remoteVerify **19**、summary **15**、sessions **17**、children **1**、Open URL **1**、loopback HTTP **63**（`/session` 17、`/session/status` 15、`/question` 15、`/permission` 15、children 1），與 #55 完全相同；節省來自等待重疊而非跳檢、快取資料或降低 request 成本。六個 phase 的值見表；可重產完整每輪 `steps`、`calls`、`http`、`runtimeMs` 原始 JSONL：

```powershell
npm run build -w @omw/manager
node scripts/benchmark-manager-workflow.mjs 6
node scripts/benchmark-manager-workflow.mjs 6
```

## OpenCode inventory 對照與驗證層級

本表依 #55 inventory 逐項對照；先前 baseline 未改動，未取得實證的項目仍記為未驗證。

| 能力 | 已取得證據 | 尚未證實 |
| --- | --- | --- |
| CLI／Local TUI／Manager boot | 先前完整 launcher 61/62，唯一失敗是 global-shim fixture 少複製新 `agents/opencode/executable.js`；此次在 `packages/launcher/test/global-shim.test.ts` 複製 build `src` 完整 tree，獨立 Windows global junction cmd/PowerShell shim **1/1 pass**。其他 CLI argv、bypass、fail-open 為原 launcher tests 之 controlled 證據。 | 不把 fixture 視為真 TUI 中斷或 CLI 原生 passthrough 實測；修復後尚無完整 launcher suite 重跑證據。 |
| Headless／Inspect／Stop／Manager shutdown-restart | 針對性 API／connectivity／runtime-contract **135/135 pass**（含 Stop identity mismatch、unreachable、readiness 及 shutdown tests）。初次完整 Manager **185/185 pass**，使用原生 OpenCode `1.18.32`；補充的 `manager-process-lifetime.test.ts` **1/1 pass、0 skip**，確認兩個 Manager fixture OS process 真正退出、同 registry 重啟後 exact identity 未變，再由 public HTTP Stop。 | Manager fixture 使用正式 service／repository／HTTP handler，但不是 production CLI bootstrap；沒有把 fixture 啟停當作所有部署方式的證據。 |
| Session／summary／activity／child／partial failure | API 和 runtime-contract 同上；benchmark 用真 parser + protocol fixture 每輪 15 summary、17 session、1 children，status 503 仍保持 unavailable。 | fixture 不代表原生 SSE、provider、真實 Session latency。 |
| Overview／HTTP／URL／Web refresh | 新 controlled HTTP gate regression、API、connectivity 同上；交接驗證首次完整 Web **14/14 pass**；每輪 workflow 六個 public HTTP route status 200 且可觀察數量正確。 | 沒有此次變更後的 Browser 操作或手機／Tailnet 真機驗證。 |
| Remote policy／auth／release／packaging | connectivity regression 含 fail-closed、TTL、同一 refresh；API 保護 Origin/CSRF；交接首次 release **15/15 pass**，global shim 更新後獨立測試 pass。 | fake remote Verify 不代表真 Tailscale Serve 可達；首次 release pass 不等於此次修改後完整發布驗證。 |

初次完整 suite 的 **185 Manager + 14 Web + 15 release pass、launcher 61/62（缺 fixture build tree）** 僅作交接證據，並非本 agent 在此輪重新執行的全套結果，亦不將 native opt-in 的通過等同 OS cleanup／exit 已通過。這次測試並未操作使用中的 Instance、Session 或 production data。

### 原生 Manager OS 生命週期補驗證

使用既有 `OMW_REAL_OPENCODE_TEST=1` 與 `OMW_OPENCODE_EXECUTABLE`（明示本機 Windows PE binary）後執行 `npm run build -w @omw/manager`，再執行 `node --test apps/manager/dist/test/manager-process-lifetime.test.js`。測試建立自有隔離 HOME／config／data、動態連接埠及隨機測試 credentials；透過 HTTP 建立背景 Instance，關閉第一個 Manager 的 stdin，等待 OS process 退出，確認 OpenCode 仍可達；第二個 Manager fixture 從同 registry reconcile，核對 PID／creation ticks／executable／endpoint，再透過 HTTP Stop。`finally` 證明兩個 Manager 已退出、受測 OpenCode 已停止、兩個連接埠已釋放並移除自有 sandbox。移除本機硬編碼路徑並沿用既有 opt-in 後再次執行：**1 pass、0 fail、0 skip**。

此補驗證只使用本次持有的 child handle 及 registry exact identity，不根據 PID 單獨取得終止權限。未啟用原生 opt-in 時仍正常 skip，不把 skip 列為原生成功。

本 agent 的實際命令：

```powershell
npm run build -w @omw/manager
npm run build -w @sevenflanks/omw
node scripts/isolated-entry.mjs test node --test --test-name-pattern "overview verifies remote during a blocked summary" apps/manager/dist/test/api.test.js
node scripts/isolated-entry.mjs test node --test packages/launcher/dist/test/global-shim.test.js
node scripts/isolated-entry.mjs test node --test apps/manager/dist/test/api.test.js apps/manager/dist/test/connectivity.test.js apps/manager/dist/test/runtime-contract.test.js
node scripts/benchmark-manager-workflow.mjs 6
node scripts/benchmark-manager-workflow.mjs 6
```

新增 regression 原串行版本 red（`Error: Condition was not met within 500 ms`），改後 green；builder、shim 1/1、相關 regression 135/135、後測兩組各六輪 assertion 均通過。`isolated-entry.mjs` 留存的 fresh isolation roots 由 owner-verified cleanup 管理，本報告不將其自行刪除。
