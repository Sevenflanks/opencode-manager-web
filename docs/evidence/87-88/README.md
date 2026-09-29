# #87 / #88 交付節點驗證（2026-09-29）

分支 `feat/87-88-ui-i18n`，工作樹仍有未提交實作。最初驗收紀錄如下；其後根據 390px 圖片修正手機 header，新增幾何回歸檢查並重新擷取三張代表圖，追加驗證列於下表。環境：Windows 11、Node v24.15.0、npm 11.12.1、已安裝 Chrome，工作目錄為 repository root。數字來自實際輸出，不把 skip 當成 pass。

| 實際命令 | 結果 | 耗時 |
| --- | --- | ---: |
| `npm test` | exit 0；release 15/15、Manager 205/220（15 skip）、launcher 62/62、web 21/53（32 skip）；合計 **350 tests、303 pass、0 fail、47 skip**。包括 contracts build 與 web `vue-tsc --noEmit && vite build`；release 中原先阻斷的 packed production consumer 已通過。 | 117.622 s（整條命令）；release 38,992.9162 ms、Manager 52,243.3886 ms、launcher 7,009.2275 ms、web 759.2908 ms |
| `npm run typecheck` | exit 0；contracts、manager、launcher、web 四個 workspace 全部成功。 | 6.348 s |
| `$env:OMW_BROWSER_EXECUTABLE = 'C:\Program Files\Google\Chrome\Application\chrome.exe'; npm run test:browser:i18n -w @omw/web` | exit 0；新 `apps/web/test/i18n.browser.test.mjs` **1 test、1 pass、0 fail、0 skip**，實際 headless Chrome 390×844 viewport。 | 3.599 s（命令）；Node test runner 3,059.1252 ms |
| `node --check docs/evidence/87-88/capture.mjs; node docs/evidence/87-88/capture.mjs`（沿用上述環境變數） | exit 0；截圖與幾何／內容斷言完成；owned browser、Vite、sandbox profile 均在 `finally` 關閉／移除。 | 3.070 s |
| `git diff --check` | exit 0（既有工作樹的 CRLF 提示非 diff whitespace error）。 | — |

### 手機 header 修正後的增量驗證

| 實際命令 | 結果 | 耗時 |
| --- | --- | ---: |
| `$env:OMW_BROWSER_EXECUTABLE = 'C:\Program Files\Google\Chrome\Application\chrome.exe'; npm run test:browser:i18n -w @omw/web` | exit 0；**1 test、1 pass、0 fail**；新增一般繁中與長文案的按鈕寬高及列表首屏檢查。 | Node test runner 2,857.1075 ms |
| `$env:OMW_BROWSER_EXECUTABLE = 'C:\Program Files\Google\Chrome\Application\chrome.exe'; node docs/evidence/87-88/capture.mjs` | exit 0；三張圖已重拍、讀取確認；自有 browser、Vite、profile 均已清理。 | — |
| `npm run typecheck -w @omw/web` | exit 0；web `vue-tsc --noEmit` 成功。 | — |

這輪只更動 `apps/web/src/style.css` 手機 header、`apps/web/src/App.vue` 的靜態 PID label 接入 `apps/web/src/locales/zh-TW.json`，以及上述 browser 測試／證據。不重跑 `npm test`；先前 **303 pass、47 skip、0 fail** 與四個 workspace typecheck 數據只代表修正前的交付節點，本輪補跑的 web typecheck 與真瀏覽器測試為當前檔案狀態提供聚焦證據。Manager／launcher／release 及其他需 opt-in 的 browser/real OpenCode 測試未因本次 CSS 修改重跑。

`npm test` 的 **Manager 15 skip**：`apps/manager/test/browser.test.ts` 有 9 項需要 `OMW_BROWSER_TEST=1`，另 1 項真 Manager Start/Open URL/Stop 同時需要 `OMW_BROWSER_TEST=1` 與 `OMW_REAL_OPENCODE_TEST=1`；另外 5 項需 `OMW_REAL_OPENCODE_TEST=1`，分別是 native headless 壽命、真 OpenCode SSE、兩真 process 重啟、installed OpenCode、真 proxy HTTP/SSE/WebSocket。**Web 32 skip**：`apps/web/test/overview-refresh.test.mjs` 的 31 項要 `OMW_BROWSER_TEST=1`；`apps/web/test/i18n.browser.test.mjs` 的 1 項在普通 `npm test` 中跳過，已由上述明示的 `test:browser:i18n` 單獨真瀏覽器通過。此處未執行其餘需 opt-in 的 browser/real OpenCode tests，不能宣稱它們通過。

## 真 Chrome / mock API 視覺證據

`capture.mjs` 在同一 Node 命令內建立 **自有的隨機 loopback Vite listener**、隔離 browser profile、Playwright Chrome browser；與正式的 `apps/web/test/i18n.browser.test.mjs` 使用相同的 390px 與主要 fixture/user text，但只擷取三個必要畫面。所有 `**/api/v1/**` 回覆由 Playwright route mock；**Vite、Vue 實際運作、Chrome DOM/布局是 real，Manager、OpenCode、資料、目錄、PID 和錯誤 response 都是 mock**。本次沒有連到用戶服務、真 backend 或真手機硬體。

- [入口、Main/Child 與保留使用者資料（390px）](main-child-user-data-390.png)：親自讀取 PNG；可見「入口 Session」、Main Session、展開的 Child Session、使用者原始標題、假目錄路徑與 Todo 原文，內容未被 locale 翻譯。
- [長文字按鈕／篩選（390px）](long-button-390.png)：重新讀取重拍 PNG，啟動操作獨占整列，設定與重新整理並排；英文 Instance 未被拆字，列表首項在首屏內。測試 locale 參數重排 `共有 2 項待處理，請查看 Instance xyz` 通過，篩選 group 有可存取名稱。DOM 測量長標籤按鈕**寬 370px、高 68px、2 個文字 rect、無裁切**，列表首項頂端 **724.015625px**（viewport 844px），`document.documentElement.scrollWidth=390`。一般繁中啟動按鈕 **370×44px**；browser 回歸測試同時限制長按鈕寬至少 320px、高不超過 144px、列表首項進入首屏與無水平溢出。
- [安全錯誤詳細資訊（390px）](safe-error-details-390.png)：親自讀取 PNG；Todo、Session 的已知 `INSTANCE_START_TIMEOUT` 轉為使用者可讀訊息且展開後只顯示 allowlisted 錯誤代碼。mock 的任意 free-form diagnostic 在 DOM 中不存在，符合 `docs/development.md:321-323`；原有 browser test 也驗證 overview/Instance 等錯誤視圖。不能以此代替真 backend/redaction 測試。

初次執行 **截圖專用** `capture.mjs` 曾 exit 1，因證據 runner 選到沒有直接 text node 的按鈕，量得 `lines:0`，不是產品測試失敗；修正 runner 只改用 accessible name 尋找正確按鈕與遍歷文字節點，第二次通過。此次手機 header 修正後沿用相同 runner 加入寬高／首屏斷言並重拍上述三張 PNG；每張都已重新讀取確認。完整 `npm test` 此輪未重跑。
