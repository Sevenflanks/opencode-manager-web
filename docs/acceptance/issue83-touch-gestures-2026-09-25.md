# Issue #83 觸控操作驗證紀錄

- 工作樹：`C:/develop/project/opencode-manager-web-83`；branch：`feat/83-touch-gestures`；基準：`0b4c530`。
- 自動化環境：Windows、本機 Edge headless、Playwright CDP 模擬 touch pointer；Manager API 使用測試用記憶體資料，測試程式自行建立／關閉 server、browser 與資料庫。
- 自動化涵蓋：手機寬度的兩種底部面板（標頭空白起手、取消／短距離／放開、草稿、焦點、body lock）、busy 拒關；篩選列起點／中間／終點提示與原生捲動；搜尋＋篩選後進入 Instance 詳情，以 browser Back 返回並復原列表 scroll；1024px 寬度觸控 toast 的取消／短距離／放開與關閉按鈕；設定面板開啟時 toast inert；320 CSS px／200% 字體時相關面板與篩選可達範圍。
- 執行（PowerShell 範例）：`node --test apps/web/test/swipe-dismiss.test.mjs`；`$env:OMW_BROWSER_TEST = '1'; $env:OMW_BROWSER_EXECUTABLE = '<Edge executable path>'; node --test --test-name-pattern='^touch ' apps/web/test/overview-refresh.test.mjs`；`npm run build -w @omw/web`（包含 vue-tsc）。
- 實機 iOS Safari：`not verified`；實機 Android Chrome：`not verified`；實機觸控平板：`not verified`。模擬觸控與 viewport 結果不等同實機驗收；軟鍵盤與實際雙指縮放需在上述平台確認。
- 範圍外現況：320px／200% 時，既有連線區 `.connectivity-actions` 會使整頁 `scrollWidth` 到約 337px；本次相關面板、篩選與通知的 bounding boxes 均在 320px 內，不將整頁 200% 重排宣稱通過。

## Verifier 執行結果

- 環境：Node v24.14.1；npm 11.12.1。
- `npm run typecheck`（root，四個 workspace）→ exit 0。
- `npm test`（root）→ exit 1：release 15 pass；contracts 與 web build pass；Manager 測試尚未開始。當時 `TEMP`／`TMP` 為 `C:/Users/SEVENF~1/...` 短路徑，遭 manager canonical alias 隔離 guard 拒絕。
- 僅在該 shell 將 `TEMP`／`TMP` 設為完整路徑 `C:/Users/sevenflanks/AppData/Local/Temp` 後，分別執行 `npm run test -w '@omw/manager'` → 214 pass、0 fail、6 skip；`npm run test -w '@sevenflanks/omw'` → 62 pass、0 fail、0 skip；`$env:OMW_BROWSER_TEST = '1'; $env:OMW_BROWSER_EXECUTABLE = '<Edge executable path>'; npm run test -w '@omw/web'`（使用已安裝 Edge）→ 27 pass、0 fail、0 skip，包含 touch 5 項與單指 unit 2 項；三個 workspace 測試皆 exit 0。
- Manager 的 6 項 skip 為真正的 OpenCode opt-in 測試；此結果不代表 root `npm test` 通過。

## `fa0c9e7` 後 code-review 定向補驗（2026-09-25）

以下為新增執行紀錄；上方原驗收與 verifier 紀錄維持原樣。前次直接執行的 browser tests 並未走隔離入口，不將其追認為隔離測試。

- 放開位置：新增 unit 重現「最後 `pointermove` 超過門檻、`pointerup` 回到起點」仍誤關（2 pass、1 fail）；改用放開座標判斷後，`node --test apps/web/test/swipe-dismiss.test.mjs` → **3 pass、0 fail**。另以瀏覽器事件接線補驗，回到起點不關閉面板。
- 多指與 backdrop：Edge CDP 雙指先重現啟動遮罩在第二指 `pointerdown` 提前關閉；設定遮罩的多指後 click 也可關閉。修正後，雙指情境不關閉，原本單指觸碰與滑鼠點擊遮罩仍可關閉；抓取區的 `touch-action` 仍含 `pinch-zoom`。模擬不代表實機縮放驗收。
- 通知防點穿：重現舊 click guard 在無合成 click 後吞掉下一次獨立觸碰；改為新 `pointerdown` 清掉前次 guard、可辨識時比對 touch pointer identity 後，補驗新觸碰可操作。CDP 在此測試不自行產生 click，因此以來源相同的合成 `PointerEvent click` 另驗舊滑動不會點穿到底層。
- 可發現性：原 44px 抓取區沒有可見標記（computed `::after` 為 `none`）；補上只在手機面板出現的抓取條，不改桌面面板配置，仍由原關閉按鈕提供替代操作。
- browser 補驗改走已配置的 `node scripts/isolated-entry.mjs acceptance <Node 24> --test --test-name-pattern='^touch (panels|filter|toast|busy|launch|review)' apps/web/test/overview-refresh.test.mjs`，在 PowerShell 同一個 shell 設 `TEMP`／`TMP` 為 `C:/Users/sevenflanks/AppData/Local/Temp`、`OMW_BROWSER_TEST=1`、`OMW_BROWSER_EXECUTABLE=<本機 Edge>`；結果 **10 pass、0 fail**。隔離入口完成後依其契約保留 fresh isolation root，未清理不屬於本次擁有權的程序。`npm run typecheck -w @omw/web` 與 `npm run build -w @omw/web` 均 exit 0；未重跑 Manager／launcher 測試或 root full suite。
