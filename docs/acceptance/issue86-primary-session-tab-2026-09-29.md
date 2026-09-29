# Issue #86：主 Session 分頁實作證據

Branch `fix/86-session-tab`、基準 `ef06ffc`。入口：「進入主 Session」。使用者澄清：「更換 session 後，當作新的 session 分頁開啟」。分頁目標以 `(Instance ID, Primary Session Binding 的 Session ID)` 識別；相同目標且分頁仍開啟時呼叫 `focus()`、不重新查詢 Open URL 或導航；binding 改變時開新頁，不干擾舊頁；關閉舊頁後再進入會重開。Session 即使跨 Instance 共用也不共用分頁。管理頁持續開啟。

首次或新目標的 Open URL 仍在使用者點擊中同步建立等待分頁，清掉 `window.opener`、設定 `no-referrer`，等待 API 回應後確認 Instance ID、Session ID、URL 必須為無帳密的 HTTP(S) 才導向。**所有成功通過驗證的 `openWithPopup`**（包括「New Session → 建立並開啟」）以 `await` 前捕捉的 Instance ID 和回應 Session ID 登記分頁；失敗只關閉本次建立的等待頁，保留舊頁。其他開頁按鈕仍照原流程開新頁。沒有增加 production dependency、改動 auth 或加上跨 reload tracking。

## Red → green 與需求修正

- 初版 #86 回歸曾觀察到相同目標第二次點擊新增第 3 頁；改成保留當次分頁 handle 後，相同目標維持兩頁。
- 先前 review 要求「OpenCode 分頁內自行切換 Session 後，Manager 強制導回」與最新澄清不同。瀏覽器跨來源且 `opener` 已切斷時，Manager 無法讀取分頁實際 Session，也無權重新導航該分頁。已**移除該過時斷言，改成驗證 Manager 的 binding 更換會開新頁、舊頁不動、回到原 binding 重用舊頁**；保留新目標錯誤回應時的安全回歸，沒有刪除或弱化既有 failing test。
- 最新行為測試先 Red：相同目標第二次仍重送 Open URL，預期 1 次但實際 2 次；改成只聚焦 handle 後 Green。
- 整合缺口另在真實 OpenCode 測得 Red：「New Session → 建立並開啟」後，保持頁面開啟再按主 Session，分頁數實際 3、預期 2；讓 `openWithPopup` 的成功結果統一登記後 Green。既有 callback 因而移除，回應 Instance snapshot 與安全檢查保留在同一函式。

## 實際驗證

使用 Playwright 操作真實 Microsoft Edge **154.0.4258.37**（headless）。OpenCode **1.18.33**。`apps/manager/test/browser.test.ts` 的 `primary Session tabs follow the Instance binding and preserve previous targets` 用 route 提供 Manager overview/Open URL 與跨來源目的地 HTML；**開頁、關頁、導航、安全等待頁與分頁數均為真實瀏覽器行為**，非 mock 的 window API。涵蓋同目標重用、不同 Session、新 binding 舊頁保留、同 Session 不同 Instance 分離、回原 binding 舊頁重用、關閉後重開，以及錯誤 Instance／不安全 URL 只關閉本次等待頁。

`mobile UI drives real Manager API Start, official Open URL, and safe Stop` 另使用**真實**本機 OpenCode 執行檔、Manager HTTP API、Open URL 與 Edge 導向，沒有 Manager API route mock。證實 New Session popup 保持開啟後按主 Session 無額外分頁或 Open URL request、`opener === null`、關閉後重新開頁、同目標重用與停止 Instance。新建 Session 的目的地已用實際 navigation request 對照官方 URL；沒有把 OpenCode 頁面完整 load 當成此案例的驗收條件。原等待頁安全回歸亦通過。

執行結果與可公開純文字 log：[`issue86-focused-results-2026-09-29.txt`](issue86-focused-results-2026-09-29.txt)。該檔保留測試名稱、原始 TAP 統計與失敗斷言，省略私人機器路徑與動態埠。測試採 `scripts/isolated-entry.mjs` 提供隔離環境；測試本身的 `finally` 關閉瀏覽器、Manager，真實整合流程也確認停止 Instance。

在 worktree root 設定 `OMW_BROWSER_TEST=1` 及 `OMW_BROWSER_EXECUTABLE` 指向 Edge；整合測試另設定 `OMW_REAL_OPENCODE_TEST=1`、`OMW_OPENCODE_EXECUTABLE` 指向 OpenCode。重現指令：

```powershell
npm run build -w @omw/web
npm run build -w @omw/manager
npm run typecheck
node scripts/isolated-entry.mjs test node --test '--test-name-pattern=primary Session tabs follow the Instance binding|primary Session popup shows a safe' apps/manager/dist/test/browser.test.js
node scripts/isolated-entry.mjs test node --test '--test-name-pattern=mobile UI drives real Manager API Start' apps/manager/dist/test/browser.test.js
git diff --check
```

先前單次 full suite 的 swipe 失敗點在 `apps/web/test/overview-refresh.test.mjs:1013` 等待啟動面板隱藏逾時；baseline verifier 已於未修改的 `ef06ffc` 用 Edge/Chromium 證實相同失敗。本輪未重跑 full suite，未修改無關 swipe 功能。

## 限制／尚未驗證

若使用者在 OpenCode 分頁**內部**自行切換 Session，跨來源 Manager 無法觀察該變化；再次點擊同一 Manager binding 仍會聚焦原分頁，不能宣稱它會偵測或導回。管理頁 reload 會失去記憶體內的 handle；COOP 若切斷 handle，亦可能無法重用。未驗證其他瀏覽器、實機前景視窗焦點：headless Edge 的 `document.hasFocus()` 即使呼叫 `bringToFront()` 仍不可靠，因此只驗證呼叫 `focus()` 的可觀察分頁行為、未以該值冒充焦點證據。
