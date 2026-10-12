# #118 本機正式 Coordinator integration 證據

**結果：單輪完整 integration 10/10 通過；本輪 Browser、watchdog 與 Docker resources 均已確認停止。**

本報告只代表下列凍結產品 bytes、實際 image、synthetic SSO/TLS 與本機 Docker 環境。
它不是 SLKE／真實 IdP 部署驗收，也不涵蓋 LLM 對話、Job 自動 task runner 或 task completion。

## 1. 可追查的本輪資料

| 項目 | 實際值 |
| --- | --- |
| Worktree／branch | 本機 worktree／`feat/118-coordinator` |
| HEAD | `b68600fe92621a87556b412fedda2ea00a814a6c`；驗證依實際 dirty files，不只依 HEAD |
| Run owner label | `io.omw.coordinator.integration=omw-coord-0e1c20f7b7bb7e26` |
| 執行時間（UTC） | 2026-10-12 12:55:39.354 至 12:59:42.978，約 4 分 4 秒 |
| 本機 runtime | Windows；Node `v24.15.0`；Docker client/server `29.1.2`；Docker Desktop `4.54.0`；context `desktop-linux` |
| Browser | Chrome `154.0.8037.98`；Playwright `1.63.0`；本輪獨立 temporary profile |

完整本機證據由操作者保存在本機 receipt（run-folder ID 僅記錄於本機）：

`<本機 temp>/opencode/<本機 run-folder ID>/`

| 證據檔 | 用途 |
| --- | --- |
| `evidence.json`、`browser-progress.json` | 10 個階段、UI confirmations、HTTP status、exact IDs、controlled pathname、source records 與 CLI exits |
| `browser-owner.json`、`watchdog.json`、`ownership.json` | 官方 BrowserServer close／child exit、watchdog 與 current-run Docker binding |
| `reconciliation.json`、`source-audit.json` | label-scoped create／destroy exact-ID 對帳、zero remaining、391 frozen product files 比對 |
| `native-composer.png`、`coordinator-tabs.png` | 已讀回確認可辨識：空 root Session 的 composer、三個 Worker 與 Coordinator 模式／分頁 |

不得公開整個證據目錄；`runtime/` 包含僅本輪 synthetic secrets／TLS fixture。報告及 harness 不保存 OAuth query、cookies 或 authorization headers。

## 2. Source、image 與版本

本輪 source snapshot **404 files = 391 frozen product files + 13 harness files**。
build 前後及完整 integration 結束時，404 files 的 raw／canonical records 完全相同。
`source-audit.json` 再核對 frozen product **391 files，changes=[]**。
本報告是在驗證完成後新增的 output，不屬於 391 frozen inputs。

| Hash 範圍 | SHA-256 |
| --- | --- |
| Frozen product（本輪及 immutable image cache 一致） | `f22ccd3231c28a2c7911ad63d665019856f08b78331deb68f4abe8a85cfc096c` |
| 本輪完整 source records | `0ecacff273b657fb331d52b9119eed3aa267dcd84e8b5a0f53b304cb483ca19a` |
| 本輪執行的 harness records | `108db5c8afb9811057cc7b5772a61429ddfcc55291199b15142a359caa5b6dac` |
| Image cache 完整 source records | `04f7dc4528c44da8351332d50c0f8adb8912b1b8b6e8f25e8b100562f3c84c5d` |
| Image cache harness records | `7650d0193cf81062ded870df38e0577c4a5680e7ab88da044c769ba657076a81` |
| Compiled skills lock | `3b65ab416961721868c8c20bd7a75efbc374ce30c01ea65e274d59fa890e261d` |
| Synthetic gateway config | `d4c50185ab60b8d17d8980710169808dc9e5c287867f3f327c5f1cf20894b7d2` |

Worker image：`sha256:d3a3d1d660fe42ccaf121e4c116194688ce61e362e3931dcb0916a47f7294fed`，`linux/amd64`。
Pomerium：`pomerium/pomerium:v0.33.4@sha256:d6e1d438b3ee88e2391feead5e39463b89da58eee0e39e78c80b94ee498a23af`，`linux/amd64`。

完整正式 Worker Dockerfile build 實際 exit `0`、耗時 **7,943 ms**、**40 cached steps／10 RUN steps 全部 cached**。
逐檔比對 image cache 的 frozen product 與本輪 bytes 後才使用 cache；本輪 harness 是 host-mounted 的當前版本，不把 cache 的舊 harness 冒稱新版本。
私有 skills build context 與 base cache 均保留，沒有重新全量安裝。

三個 native `/global/health` 均回 `200`、`healthy=true`、backend **OpenCode `1.18.34`**。
原生 frontend 的可見文字沒有版本號（`visibleFrontendVersions=[]`）；不能由 backend version 推論 frontend 版本。
本輪 observed script／stylesheet 經各 native origin 成功載入，browser 本輪 public asset 計數為 0；runtime 仍可能代理上游 frontend assets，沒有宣稱 frontend build 已 pin。

## 3. 正式 pipeline 與 exact IDs

Coordinator、A task Worker、B resident Worker 都由正式 server／execution-server 啟動。
Worker registration 與 nonce identity proof 使用生成的本輪 per-Worker key；A/B/C 各有實際 nonce 回傳及 HMAC 驗證。
Coordinator 沒有 Docker socket、kube 或 service-account mount。

| Worker | Generation | Instance | Root Session |
| --- | --- | --- | --- |
| `a`（task） | `7eea0f29-09c5-4687-aa8f-7e7950216a35` | `a993502e-9587-4254-9448-259daf6985ff` | `ses_ecfcffbb8ffeCn31RanVkAkiU3` |
| `b`（resident） | `db282ecb-417b-4fc1-9199-3f7a967b916b` | `d2f8fc57-ef10-435d-934d-c64a2b333a0f` | `ses_ecfcf8f72ffe1eeXsQgX4PKOrC` |
| `c-9f2532`（resident） | `9b023ef5-e68f-4add-9bfe-152d0636c73f` | `160aafed-07b2-4202-9cdd-d601ae736b9e` | `ses_ecfceb082ffeSfRkPNCPEIHuA9` |

三個 Worker 均從真實 Vue UI 選取 exact `JSON.stringify([id,generation])`、開啟目錄 panel，經 Start 與 New Session confirmation 建立。
每個 Worker 的 **Start `201`／Session `201`／open-url `200`**；native root Session metadata `200`、`directory=/workspace`、exact Session ID、messages `0`、composer 可見、secure context 為 true。
跨 Worker Instance／Session 讀取均 `404`。

### Native API entry 與 frontend canonical route

以 A 為例，API pathname 是：

`/L3dvcmtzcGFjZQ/session/ses_ecfcffbb8ffeCn31RanVkAkiU3`

其中 `L3dvcmtzcGFjZQ` 解碼為 `/workspace`。
原生 frontend canonical pathname 是：

`/server/aHR0cHM6Ly9vbXctam9iLWEtY29kZS5leGFtcGxlLnRlc3Q/session/ses_ecfcffbb8ffeCn31RanVkAkiU3`

server segment 解碼為 exact native origin `https://omw-job-a-code.example.test`，不是 Project。
驗證接受這兩種 exact route shapes：original API route 驗 Project segment；canonical route 驗 outer origin、encoded server origin、exact Session ID，以及 native metadata 的 exact directory／ID／HTTP `200`。
不要求 canonical route 重複攜帶 Project segment；不接受 arbitrary prefix、foreign host、不同 Session 或不同 directory。
關閉／重開 native tab 後再讀 native metadata，也通過相同 scope 檢查。

已存在 tab 的「進入入口 Session」直接 reuse，tab 數及 mutation 數不變。
只關閉本輪 exact native tab 後，再點相同 UI 才發出 open-url；沒有重送 Start／Session。

### C 動態加入

C 在 A/B 完成 UI pipeline 後才生成 ID、generation 與 Docker-allocated address `172.20.0.7`。
Coordinator 只設定本輪 subnet CIDR，不預設 C IP mapping。
Pomerium 固定 coordinator／wildcard native class 共 **2 routes**，gateway container ID／StartedAt／config hash 完全不變；C 加入也不需要 reload Coordinator。
Synthetic edge 的 exact hostname route／fixture target map 在地址生成後更新，這是本機 fixture routing，並非修改 Pomerium policy／IdP callback。
IdP callback 維持 `https://auth.example.test/oauth2/callback`。

桌面列出 3 Workers；390 × 844 手機 viewport 無橫向 overflow、password input 數為 0。
`coordinator-tabs.png` 是 Worker cards 的可讀畫面，capture 恰在分頁 highlight transition，不能單靠該張截圖判斷 active-tab styling；分頁操作有 browser action 證據。

## 4. SSE、restart、失聯與拒絕

| 行為 | 本輪實際證據 |
| --- | --- |
| Native SSE `/event` | HTTP `200`、首段含 `data:`、**32,043 ms** 後仍 ongoing |
| Idle Coordinator restart | A/B/C execution container ID／StartedAt、epoch、PID、Instance、primary Session、Project 均不變；每個 namespace process count 保持 1、rootRunning／portOwnerMatched true |
| 無 mutation replay | restart 前後 proxy POST count **9 → 9**；所有三個 Worker 的 Start／Session 各僅一次 |
| Pause A manager | 觀察 `unstable` 後 `offline`；consecutiveFailures `3`、endedAt 有值、`WORKER_RESULT_UNKNOWN`；B native health 仍 `200` |
| Unpause A manager | 回到 online/fresh；endedAt 清空；A/B/C generations 不變 |

Execution epoch：A `4b00e704-0168-46fe-bd24-b6788ef2a2eb`；B `02eae16c-ae50-45b4-8903-7c333c09b297`；C `299152ee-bea8-424a-8dfc-ebeb3f8dba29`。三個 private execution namespaces 的 runtime PID 均為 `20`；PID 相同不代表跨 namespace 同一程序。

拒絕結果：

| 測試入口 | 結果 |
| --- | --- |
| 公開未登入 browser | redirect synthetic IdP；沒有 render Coordinator |
| 公開 unknown native hostname | `404`；由 edge exact route 拒絕 |
| Coordinator direct 無 Basic／偽造 user headers 仍無 Basic | `401`／`401` |
| Coordinator direct unknown／malformed／foreign host | `404`／`404`／`404`，沒有 fallback |
| Coordinator native route cross-Worker Origin／cross-site header | `403`／`403` |

Chromium 不允許 JS 偽造 `Sec-Fetch-Site`，該 browser request 實際是 `200`，不能冒稱 browser negative case；上表的 `403` 來自經 synthetic fixture 的真實 HTTP header 測試。
本輪沒有 native UI WebSocket frame 證據。既有 backend TCP echo／upgrade tests 是 proxy fixture coverage，並非本輪 native UI 或 model continuity 的證明。

## 5. Phase 9 public Stop 與 current-run cleanup

三次 Stop 均使用上表的 exact generation／Instance ID，經公開 Coordinator proxy POST 回 `200`、state `stopped`。
隨後各 Worker 以獨立 helper namespace 讀 supervisor：**managedProcessCount `0`、capacity `available`、processState `not-found`、portAvailable true、epoch 不變**。
supervisor 保留 last accepted currentInstance ID 屬已觀察契約，沒有把歷史 ID 當成仍在執行的證據。

本輪 UI proxy mutations 共 **12**：3 Start、3 Session、3 open-url、3 Stop；promptsSent `0`。未發 model/business task。

| Cleanup 項目 | 實際確認 |
| --- | --- |
| Docker containers | **25 created／25 destroyed**，events exact-ID 對帳全部完成 |
| 資源組成 | 9 正式服務 containers（Coordinator、3 × manager/execution、edge、gateway）、4 volume-init、3 readiness、9 inspect helpers |
| Synthetic volumes／network | 本輪 10 volumes、1 network 已移除；兩輪 cleanup、watchdog、post-run audit 都回 container/network/volume `[]` |
| Image alias | 只刪本輪 `omw-coord-0e1c20f7b7bb7e26:verification` alias；base／immutable source cache／private skills context 保留 |
| Browser／watchdog | Browser child exit `0`、watchdog exit `0`；官方 BrowserServer close event、Chrome process exit 均 observed true、closeError false |

`evidence.json` 的 197 次 Docker CLI 操作 **197 exit 0／0 nonzero／0 unknown**。
Post-run reconciliation 再查已刪 alias 時 image inspect exit `1`，隨後 image ls exit `0` 且空；這是 alias absence，不改寫原 integration success。
`node scripts/coordinator/run.mjs`、`reconcile.mjs`、`audit-source.mjs` 均 exit `0`。

完整證據只涵蓋 **DjIOm8** current run。先前 `HL4PbA`／`JwqhH6` browser exit 未解紀錄仍保留；本輪沒有 touch、guess-kill 或 reuse 其 profile，沒有宣稱歷史環境 all-clean。

## 6. Harness 修改與重現

修改限 `scripts/coordinator/` 與本報告，沒有改 frozen backend／UI／policy 或提交 Git。

| 檔案 | 修改理由 |
| --- | --- |
| `scripts/coordinator/native-scope.mjs`／`native-scope.test.mjs` | 正確驗兩種原生 route 契約；固定正例及 foreign origin／ID／directory／credentials／arbitrary prefix 反例 |
| `scripts/coordinator/browser.mjs` | 用 pure scope validator、重開 tab 重新讀 native metadata；BrowserServer 獨立 TTL 20 分鐘 |
| `scripts/coordinator/owner.mjs` | 正確辨識實際 `--progress=plain`，取得 build cache counts |
| `scripts/coordinator/run.mjs` | restart 前先核對實際 PID／Project；recovery generations 以 assertion 驗證；驗證完成後新增 report-output 排除，讓 frozen 391-file gate 不因本報告失效 |

本節記錄的 10/10 integration 是修改 launcher 輸入契約前的歷史執行；上述 source／harness hash 是**當時執行值**，不代表這次 portability／privacy 修改重新執行完整 integration。
成功後僅追加 `run.mjs` 的 report-output exclusion；它未在本輪 runtime 重跑，`source-audit.json` 會列出 postRunHarnessChanges。
沒有把後續 harness bytes 冒稱已完整 integration-tested，也沒有重新跑產品 pipeline。

於 worktree root 執行：

```powershell
node --test scripts/coordinator/native-scope.test.mjs
node scripts/coordinator/run.mjs --skills-context "<absolute private skills bundle directory>"
node scripts/coordinator/preflight.mjs "<prior-run directory>" --skills-context "<absolute private skills bundle directory>"
node scripts/coordinator/reconcile.mjs "<本輪 evidence directory>" --await-browser-finalize
node scripts/coordinator/audit-source.mjs "<本輪 evidence directory>"
```

兩個 launcher 共用必填 `--skills-context` 輸入：必須是存在的絕對目錄；缺少、相對、無法讀取或非目錄時在建立 temp run folder／Docker resources 前拒絕。`--help` 不需要 Docker 或 bundle。輸出預設放在 `os.tmpdir()/opencode/`；不會猜測主機上的 bundle、`latest` 或 fallback。

Host shell tool 跑 integration 必須明確給 **timeout 1,200,000 ms**；預設 120,000 ms 會早於 cleanup。
Harness workload deadline 20 分鐘、Docker watchdog 22 分鐘、BrowserServer 獨立 TTL 20 分鐘；finally 使用本輪官方 owner 做 identity-bound Stop。
重現需要仍存在的 immutable source cache、private bundle、Docker images 及本機 Chrome／Playwright；不保存或借用先前 auth profile。

Pure helper 測試 **4 passed／0 failed**。Mutation 對應：

| 可能破壞 | 會失敗的測試 |
| --- | --- |
| 強制 canonical route 也含 Project segment／錯誤 canonical branch | `accepts original project entry and canonical exact-server entry with native Project metadata` |
| 放過 foreign outer 或 encoded server origin | `rejects a foreign outer origin and foreign encoded server origin` |
| 放過錯 Session／Project／metadata status、缺少 metadata | `rejects wrong Session route or metadata, wrong Project, and missing canonical metadata` |
| suffix-only scope／任意 prefix／URL credentials | `rejects arbitrary prefixes, trailing segments and URL credentials` |
