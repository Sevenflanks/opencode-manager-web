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
