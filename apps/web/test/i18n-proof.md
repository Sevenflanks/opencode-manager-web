# #87 / #88 實作驗證紀錄

環境：Windows 11、Node v24.15.0、npm workspace、Vue I18n 11.4.12、Vite 7.3.6。測量於 `feat/87-88-ui-i18n`，基準 `ef06ffc`，使用相同 `npm run build -w @omw/web` 輸出的 `apps/web/dist/assets`，以 Node `Buffer.length` 與 `zlib.gzipSync(buffer).length` 量測；CSS/JS 均非 source map。

| 資產 | 基準 raw / gzip (bytes) | 修改後 raw / gzip (bytes) | 增量 raw / gzip (bytes) |
| --- | ---: | ---: | ---: |
| JS | 237,956 / 81,830 | 315,951 / 105,288 | +77,995 / +23,458 |
| CSS | 44,706 / 9,834 | 45,059 / 9,891 | +353 / +57 |

雙軸 review 修正後，於 `apps/web` 執行 `node --test test/i18n.test.mjs test/session-todo-refresh.test.mjs test/overview-error.test.mjs`：9 tests / 9 pass / 0 fail，耗時 534.9174 ms。涵蓋測試 locale 參數重排與 fallback、基準缺 key 的安全終端、known/unknown code、Basic/credential URL 等自由文字遮蔽、Todo API code 保留與清除、overview error→timeout→success 時摘要及詳細資訊一併清除。診斷詳細資訊只顯示已確認的 code；不顯示未受信任的任意原文。`npm run build -w @omw/web`：`vue-tsc --noEmit` + Vite build 成功（2,210 modules transformed，2.41 s），正式 JS bundle 未含測試長文案。過去執行的其他套件測試結果未於此次重跑。

可自動重跑的瀏覽器測試：設定 `OMW_BROWSER_EXECUTABLE` 指向已安裝的 Chromium/Chrome，於 repo root 執行 `npm run test:browser:i18n -w @omw/web`。測試在當次 Node process 監聽隨機 loopback port、啟動獨立 headless browser profile，並在 `finally` 關閉 browser/Vite 與移除測試 profile；不需要占用 5173。本次 review 修正後最後一次以本機 Chrome 執行：1 test / 1 pass / 0 fail，總耗時 2,759.2664 ms。`apps/web/test/i18n.browser.test.mjs` mock 成功的 overview/connectivity/session roots/Child Session/primary Todo，檢查 390px 導覽與使用者標題、路徑、Todo 原文；在測試 locale 切換後，檢查參數重排、fallback、aria 與長文字所有行仍位於最小 44px 按鈕盒內且無水平溢出；並驗證既有 Todo/Session 錯誤與已開啟確認框會隨 locale 更新、已知 API code 在 Instance/摘要/Todo/Session/overview 的摘要與詳細資訊中正確呈現，Basic/credential 任意原文不會出現在折疊或展開的錯誤內容。另有 `apps/web/test/i18n.browser.js` 供手動在另行管理的 5173 服務執行，本輪未執行該腳本。

Release prepack 回歸：`node packages/launcher/scripts/generate-third-party-notices.mjs` 通過，包含 55 個 Web production 套件；`node --test scripts/release/package-consumer.test.mjs`：1 test / 1 pass / 0 fail，耗時 32,669.2269 ms。`@vue/devtools-api@6.6.4` 安裝包未附 LICENSE，依 upstream 同版完整 MIT 文字及 SHA-256 固定來源，寫入 `packages/launcher/THIRD_PARTY_NOTICES.md`。未重跑其他先前通過的套件測試。

## 2026-09-30 未提交修正後增量驗證

上方表格為舊版 bundle 測量，**不是目前工作樹的數字**。目前工作樹 HEAD 為 `c55dcc5d964760678ea8fb287856a4167ffb1cc0`（PR #94 仍 OPEN、遠端 head 相同），另有五份未提交的 manual registration error 與 `zh-TW.json` 格式修正。這輪在 repo root 實跑 `npm run build -w @omw/web`：exit 0，`vue-tsc --noEmit && vite build`，2210 modules transformed、built in 3.02s。其後用 Node `Buffer.length` / `zlib.gzipSync(buffer).length` 量測及掃描正式 `dist`：

| 資產 | 本輪 raw / gzip (bytes) | 對上方舊版測量增量 raw / gzip (bytes) |
| --- | ---: | ---: |
| `apps/web/dist/index.html` | 521 / 318 | — |
| `apps/web/dist/assets/index-Cb3vP4rQ.js` | 318,345 / 105,864 | +2,394 / +576 |
| `apps/web/dist/assets/index-BUnxKwMW.css` | 45,099 / 9,901 | +40 / +10 |

逐一檢查 `apps/web/test/long-test.locale.json` 三份完整測試字串，以及 `long-test.locale.json`、`test/long-test.locale` 和長文案 sentinel，皆未在 `dist/index.html` 與 `dist/assets` 的 JS/CSS 發現；這是靜態輸出檢查，並未聲稱外部依賴或 runtime 的更廣義排除證明。**實際執行命令、量測輸出與版本限制的共享紀錄**見 [docs/evidence/87-88/README.md](../../../docs/evidence/87-88/README.md#2026-09-30-未提交修正後的增量證據)。

general 的交接紀錄為 focused i18n unit **6/6 pass**、browser **1/1 pass**，本輪未重跑，且這兩項沒有附原始命令輸出／耗時；不能將其視為本輪執行。2026-09-29 完整 `npm test` **350 tests、303 pass、47 skip** 屬先前檔案版本，未在這次修正後重跑；既有截圖也不是這輪版本的重新擷取。
