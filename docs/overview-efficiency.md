# Overview 與停止歷史傳輸契約（#95／#96）

## 相容方式與責任邊界

- `GET /api/v1/overview` 保留既有 `filter=all`、`q`、`includeHidden` 與完整 `sessions` 回應。新 UI 明示使用 `view=compact&scope=current`，不暗改舊 consumer 的 all。
- compact 的 Instance **省略** `sessions` 欄位；不是回傳假的空清單。後端先用完整 metadata 搜尋，再做投影；Session roots／children API 不變。
- compact 回應包含 `history: {total, revision}` 及 `notifications`。通知只含 ID、state、trackingHidden 與 Instance-wide pending counts，來自當輪未篩選、未隱藏的目前 Instance；搜尋／filter／hidden 子集不會變成通知基準。
- 畫面與通知只共用當輪 HTTP；各 subscriber 獨立取消，最後一位取消才 abort transport。畫面未發出請求（例如 hidden）時，`view=notifications` 取得同樣的輕量投影。沒有額外跨請求 snapshot cache。
- `GET /api/v1/instances/:id` 是 current 投影缺少選取項目時的持久 stopped detail seam：stopped 回 compact Instance、active 回 `null`、已移除回 404。active 不再完整探測第二次。
- runtime 仍需取得完整 metadata 才能計算摘要／搜尋。移除 response Session 清單只省 JSON／傳輸，不宣稱省掉 OpenCode metadata 計算。

## 停止歷史

只有 `stopped` 放入歷史；unreachable／failed 留在目前清單。停止追蹤、停止程序與移除紀錄的既有語意不變。

`GET /api/v1/instances/history?q=&includeHidden=false&offset=0` 從後端取得 20 筆，回 `total`、`revision`、`nextOffset` 與 compact `instances`；不是先下載全量再前端切片。排序沿用 launchedAt 降冪／ID tie-break，不把 launchedAt 說成停止時間。

續頁帶前頁 `revision`。membership、持久狀態或 binding 改變時回 `HISTORY_CHANGED`／409，前端保留最後成功內容並提供重新載入，避免舊 offset 接上新清單而漏列或重複。

停止歷史搜尋獨立於目前搜尋，涵蓋全部符合 hidden scope 的 stopped 紀錄，包含 Project 名称／路徑、Instance ID、持久 primary Session title／ID；不承諾未保存的其他歷史 Session 內容。

首次展開載入；收合／重開與詳情返回保留條件、頁數及既有 mobile scroll context。手動刷新原子替換已載入頁數，失敗保留舊列。每 5 秒只讀可靠摘要，revision 改變才失效／刷新已展開歷史；收合時延至下次展開。includeHidden 改變則重建該 scope。正在看的 Instance 停止後，detail seam 保留最新 stopped 狀態與既有操作。

## HTTP representation

目前應用為 Fastify 5，原先沒有 response compression；僅在 overview、history 與上述 detail 的 GET JSON 使用 Node 標準庫 async gzip。預設 1 KiB 以上才壓縮；若 caller 禁止 identity 或明示較偏好 gzip，小回應也可壓縮。依 RFC 9110 §12.5.3 比較明示 q-value，`gzip;q=0.1, identity;q=1` 選 identity；未列出的 identity 只是預設可接受，不當成較高的明示 q=1，因此 `gzip;q=0.1` 仍可選 gzip。明示 `gzip;q=0` 優先於 wildcard；沒有可接受 representation 時回 406。串流、mutation 與其他路徑不加入此 hook。

`Vary: Accept-Encoding`、`Cache-Control: private, no-cache` 與 SHA-256 ETag 由 URL（含 query／filter／hidden）、encoding variant 與已完成的序列化 body 產生。GET 弱／強 validator、list 與 `*` 匹配時回 304；瀏覽器沿用 HTTP cache 正確 revalidation，不另新增前端資料快取。

沒有每輪變動的 response timestamp；在下述有界 fixture 的穩定／變動情境，validator 有收益且不需一致性快取，因此已實作。**200／304 都先完成 fresh probes**，ETag 不省 upstream 計算；304 提前返回可省 gzip 計算與 body 傳輸。實際部署／Tailscale 代理路徑本次無觀察權限，以下只證明隔離應用 loopback 路徑，未更動部署或 auth。

## 可重現的隔離驗證

```powershell
npm run typecheck
npm run build -w @omw/manager
node scripts/isolated-entry.mjs test node --test --test-name-pattern="compact current|overview HTTP|proof artifacts" apps/manager/dist/test/api.test.js apps/manager/dist/test/proof-artifacts.test.js
node --test apps/web/test/stopped-history.test.mjs apps/web/test/overview-transport.test.mjs apps/web/test/browser-notifications.test.mjs
npm run build -w @omw/web
$env:OMW_BROWSER_TEST='1'
$env:OMW_BROWSER_EXECUTABLE='C:/Program Files/Google/Chrome/Application/chrome.exe'
node --test apps/manager/dist/test/overview-efficiency.browser.test.js
# 本票相關的四項 UI 回歸；不等於完整 browser suite
node --test --test-name-pattern="stopped detail fallback|browser usability|primary Session attention reasons|mobile list-detail navigation|Session-first Instance list" apps/manager/dist/test/browser.test.js
```

proof 使用 memory SQLite、mock Runtime、匿名長名稱及動態 loopback port。runtime launch／stop 明示拒絕；browser profile／環境隔離，app、browser、service 與 repository 在同一 bounded run 的 `finally` 由原 owner 關閉。每 run 的 screenshots、`metrics.json` 與 `browser-result.json` 預設留在 Node `tmpdir()` 下的獨立 `overview-95-96-*`／`overview-regression-*` 目錄；可透過 `OMW_PROOF_ROOT` 指定外部 parent，不存在時先建立。Artifacts 不提交，也不隨 fixture cleanup 刪除。

2026-10-01 run `overview-95-96-gMvUGD`（包含最新 active fallback `null`）：同 Project 2 個目前 Instance、45 stopped、每個目前 Instance 180 Session metadata。

| 相同資料集 | body bytes | HTTP headers + status-line bytes | 單次 loopback 延遲 |
| --- | ---: | ---: | ---: |
| legacy JSON | 98,854 | 未列入 compact 比較 | 未列入 compact 比較 |
| compact identity | 2,561 | 304 | 11.25 ms |
| compact gzip（實際 HTTP） | 727 | 327 | 4.24 ms |
| compact gzip 304（實際 HTTP） | 0 | 316 | 3.10 ms |

body 與 headers 來自真 HTTP socket response；不含 TCP/IP／TLS framing。延遲為各一次觀察，不是 benchmark SLA。100 次離線平均 gzipSync 0.0411 ms、validator SHA-256 0.01175 ms，僅為 CPU 線索，不冒稱 async 壓縮的 production 成本。

穩定 5 次 validator 5/5 命中；每次改 pending count 的 5 次為 0/5。14 次 HTTP（含 304）仍共 28 inspect／28 summary calls。啟用通知後的每 5 秒觀察為 **1 overview request、2 inspect calls**；filtered empty UI 仍取得兩個 Instance 的通知邊緣。歷史收合 0 history requests、首批 20/45、續批 40/45、重開無重抓；搜尋可找首批之外的第 45 筆。320／390／1280px、320px 200% 文字、loading／error／retry、長名稱與 selected stopped detail 已由此 harness 驗證並留 screenshots。

四項相關回歸與新 proof 的最後集中執行為 exit 0、5/5 通過。回歸 artifacts 位於 `C:/Users/rhys/AppData/Local/Temp/opencode/overview-regression-gaNWQc`；proof artifacts 位於 `C:/Users/rhys/AppData/Local/Temp/opencode/overview-95-96-gMvUGD`。兩者皆在 owner cleanup 完成後寫入 lifecycle JSON，確認本次 browser 已 disconnected、loopback listener 已關閉、repository 已關閉；proof 另確認 service shutdown。

逐項對照 base `c61cfd1` 後，原先期待 raw credential failure message、「啟動執行個體」、「未綁定主 Session」與「尚未取得執行個體資料」的斷言均已在 base 測試出現，但 base 的 i18n 已是目前文字。`error-presentation.ts` 的 base 與本輪 blob hash 同為 `f7805fc224f14adc28e7b3a4e94e91b0b0fbf924`：未知 code／自由文字本來就不應顯示。這是 source 對照，未另外執行 base browser suite。

回歸測試已改用精確的現行名稱，並明確驗證未知 server message／code 不外洩、未知 diagnostics 沒有 details disclosure；瀏覽失敗仍顯示確切失敗路徑及可重試狀態。獨立停止歷史的 mock、搜尋與未載入／收合狀態隨新契約維護，保留 mutation gate、恢復／移除、焦點、手機布局及穩定排序等行為斷言。本輪未因此修改產品程式。交付前的 full suite／code-review 仍由主 agent 集中安排，不能把這 5 項宣稱為整套已通過。

## P2 review 修正驗證

2026-10-01 的後續 review 修正涵蓋 stopped selection race、q-value 相對協商與 artifact parent 可攜性。等待 stopped A 的 detail fallback 時改選 B，前端重新解析目前選取的 B，再合併其最新 stopped detail；不讓舊 A 回應清掉 B 或跳到 current。1280px／390px 的 deferred 回歸先於產品修正失敗、修正後通過，並確認 B 的最新標題、selected 語意及手機 history target。

本輪 `typecheck`、manager/web build、5 項 targeted API／artifact tests 與 6 項 browser regression/proof 均 exit 0。q-value 回歸也先重現 `gzip;q=0.1, identity;q=1` 錯選 gzip，修正後覆蓋 implicit identity、wildcard、explicit exclusions／406 及小錯誤回應的明示偏好。

本輪以 `OMW_PROOF_ROOT=C:/Users/rhys/AppData/Local/Temp/opencode/review-p2-proof` 留存 `overview-regression-yJNs9d`（含 stopped-selection-result.json、1280／390px screenshots 與 lifecycle）及 `overview-95-96-IbJLkC`（metrics、320／390／1280px screenshots、browser-result 與 lifecycle）。所有本次 browser／listener／repository 已由原 owner 關閉；proof 另完成 service shutdown。主 agent 提供的前次 full suite 為 335 pass／49 skip，本輪未重跑 full suite。
