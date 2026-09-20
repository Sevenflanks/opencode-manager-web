# Issue #11 Vue UI 驗收紀錄（mock UI 補驗與補圖完成）

- 驗收日期：2026-09-20
- Worktree：repository root（checkout path supplied by the caller）
- Branch：`feat/issue11-local-onboarding`
- 基準 HEAD：`42521b046945b6fefd1d20ae55f01f4e0c37cf60`
- 瀏覽器：本機既有 Microsoft Edge，透過 `playwright-core` 啟動；未下載瀏覽器或安裝 dependency
- Desktop viewport：`1440 × 900`
- Mobile viewport：`390 × 844`
- 結論：六類正式 Vue UI 情境均已取得 mock backend／layout 證據。補驗確認 credential rotation、launch panel 建立前狀態、stopManager 確認與結果，以及 mobile list/detail/list 切換；沒有把 mock response 或 viewport 模擬宣稱為真實 Manager API、credential persistence、process shutdown、Tailnet 或實機證據。

## 驗收資料與真實性邊界

第一輪載入 `apps/web/src/App.vue` 的正式 Vue UI，使用 Vite programmatic server 與 Playwright 操作。補驗 harness [`issue11-ui-harness.mjs`](issue11-ui-harness.mjs) 則以同 process HTTP server 提供既有 `apps/web/dist`，並以 Playwright route interception 提供隔離 mock backend data。Fixture 僅使用 `C:\OMW-Fixture\demo-project`、`C:\acceptance\issue11-onboarding`、`inst-fixture-*`、`inst-issue11-*`、`ses-fixture-*` 與 `ses-issue11-*` 等合成資料。

因此下列證據可驗證正式 UI 的可見文案、互動、layout 與前端 request 路徑，但**不代表**真實 Manager、SQLite、DPAPI credential store、OpenCode Instance／Session、provider、真手機或 Tailnet 已通過。這次沒有建立真 OpenCode Session，也沒有接觸既有 data、Session、service 或 port。

使用手冊的用途、步驟與預期結果已同步至 [`docs/user-guide.md`](../user-guide.md#11-驗收證據與限制)。所有圖說均標示「正式 Vue UI，隔離 mock backend，非真 Manager/Tailnet實測」。

Scope 判定：使用者已明確同意將真手機與 Tailnet 驗收移出 Issue #11 本輪 PR 的必要條件。既有 desktop 與 `390 × 844` mobile viewport 證據保留，但不改稱真機通過；真實 OpenCode TUI 啟動與 `-s` 指定 Session 路徑仍是本輪必要條件，且不在這份 mock UI 報告的已通過範圍內。

## 六類 UI 情境結果

| 情境 | 結果 | 實際操作與證據 |
| --- | --- | --- |
| Overview／Instance details | 通過（mock backend） | 等待 `.instance-row` 與 `.detail-pane h2` 可見，確認清單含 `Fixture planning session`、詳情含「主要 Session」。截圖：[`issue11-overview-details-desktop.png`](../images/issue11-overview-details-desktop.png)。 |
| Session tree | 通過（mock backend） | 展開「切換其他 Session」，點擊「載入 Child Session」，mock children API 僅呼叫一次，畫面顯示 `Fixture child session`。截圖：[`issue11-session-tree-desktop.png`](../images/issue11-session-tree-desktop.png)。 |
| createInstance | 通過建立前面板與既有結果（mock backend） | 新 harness 開啟正式「啟動執行個體」面板、輸入並瀏覽 fixture 目錄，在按建立前確認「啟動全新 Instance」可見且 `POST /api/v1/instances` 次數仍為 `0`。面板截圖：[`issue11-start-instance-panel-desktop.png`](../images/issue11-start-instance-panel-desktop.png)。既有獨立 create mock 結果截圖：[`issue11-create-instance-result-desktop.png`](../images/issue11-create-instance-result-desktop.png)。兩張圖不合併宣稱同一次真實建立流程。 |
| Credential UI | 通過前端流程（mock backend） | 正式「OMW 設定」dialog 送出合成 credential；斷言 `PATCH /api/v1/settings/credentials` 僅呼叫一次、CSRF header、request body 與 HTTP `204`，成功通知出現且三個密碼欄位清空。截圖：[`issue11-credential-rotation-success-desktop.png`](../images/issue11-credential-rotation-success-desktop.png)。原始空白畫面仍保留於 [`issue11-credential-ui-desktop.png`](../images/issue11-credential-ui-desktop.png)。 |
| stopManager | 通過確認與前端結果（mock backend） | 確認 dialog 顯示「停止 OMW Manager？」與保留 OpenCode 工作的文案；確認前截圖：[`issue11-stop-manager-confirmation-desktop.png`](../images/issue11-stop-manager-confirmation-desktop.png)。再斷言 `POST /api/v1/manager/shutdown` 僅呼叫一次、body 為 `{}`、CSRF header 與 HTTP `202`，之後正式 UI 顯示 stopped banner：[`issue11-stop-manager-result-desktop.png`](../images/issue11-stop-manager-result-desktop.png)。這不代表真 Manager process 已停止。 |
| Mobile viewport | 通過模擬 viewport 的 list/detail/list 切換與 overflow（mock backend） | 切換為 `390 × 844`，先確認 list、點 Instance 開啟 detail、確認「返回列表」，再返回 list；狀態順序為 `list → detail → list`，且 list 的 `clientWidth = scrollWidth = 390`。截圖：[`issue11-mobile-detail.png`](../images/issue11-mobile-detail.png)、[`issue11-mobile-overview.png`](../images/issue11-mobile-overview.png)。這不是觸控、真手機或 Tailnet 證據。 |

## Screenshot 隱私檢查

納入本報告的十張圖片只含合成 fixture path、ID、帳號與 Session title；兩張 credential screenshot 的 password 欄位均為空白。未看到真實使用者路徑、密碼、launcher token、provider 資訊或真 Session 內容。

## Credential rotation／shutdown API

真實 API tests 未執行。原訂只跑 `apps/manager/test/api.test.ts` 中三個精確 test-name（credential success、credential persistence failure、Manager-only shutdown），不跑既有 29 tests、DPAPI 或 parallel；本次遵守「不重跑整套測試」與只補 UI mock 證據的範圍，沒有啟動 Manager API test fixture。

補驗只證實前端 API contract：credential route 回 `204`、shutdown route 回 `202` JSON。Mock 不會寫入 DPAPI、替換 authenticator 或停止真 Manager。

靜態定位僅作待驗證索引，不當成動態通過：

- `apps/web/src/api.ts:38-42`：前端 credential PATCH 與 shutdown POST。
- `apps/web/src/App.vue:1119-1167`：credential update 與 Manager shutdown handlers。
- `apps/web/src/App.vue:1764-1788`：credential／shutdown 正式 UI。
- `apps/manager/src/app.ts:103-128`：credential route schema、controller call、HTTP 204；shutdown callback、HTTP 202。
- `apps/manager/test/api.test.ts:389-472`：待跑的三個 targeted API tests。

## 實際命令與結果

1. `npm run build --workspace @omw/web`
   - exit `0`。
   - `vue-tsc --noEmit` 與 Vite production build 通過；Vite 轉換 2182 modules。
2. `npm run build --workspace @omw/manager`
   - exit `0`。
   - contracts 與 manager TypeScript build 通過。
3. 單一有限 UI harness：PowerShell inline `$code` 後執行 `node --input-type=module -e $code`
   - 外層 tool timeout：40 秒；harness 獨立 watchdog：30 秒。
   - Vite 以 programmatic API 在同一個 Node process 內啟動與關閉；沒有把 tool timeout 當背景機制。
    - Playwright 使用本機既有 browser executable（路徑以 `<browser-executable>` 表示）建立 fresh current-run owner binding，再以 `chromium.connect(...)` 操作；可透過 `OMW_BROWSER_EXECUTABLE=<browser-executable>` 指定。
   - 前三類情境與 credential dialog screenshot 完成後，等待 credential success locator 時 watchdog 觸發；錯誤為：

     ```text
     locator.waitFor: Browser closed
          at [inline harness eval]:157:37
     ```

   - harness exit `1`；此結果不解讀為產品 credential failure，因為 browser 是由 harness watchdog 主動終止。
4. Cleanup reconciliation：

   ```powershell
   Get-Process -Id 40888 -ErrorAction SilentlyContinue
   ```

   - 結果：`{"pid":40888,"running":false}`。
5. 補驗 harness 靜態檢查：`node --check "docs/acceptance/issue11-ui-harness.mjs"`
   - exit `0`。
6. 單一安全有界補驗：`node "docs/acceptance/issue11-ui-harness.mjs"`
   - exit `0`；內建 watchdog `25` 秒，外層 tool timeout `45` 秒。
   - `credentialCalls = 1`、`shutdownCalls = 1`。
   - Mobile `clientWidth = 390`、`scrollWidth = 390`、`mobileView = "list"`。
   - 未知 `/api/v1/**` route 一律回 `501 FIXTURE_ROUTE_MISSING`，最後斷言 missing route 清單為空；因此 route 缺失不會再被誤判為 success locator timeout。
   - 沒有重跑 build、API tests 或完整 test suite。
7. 三個缺圖情境的有限 harness 擴充：同一命令、相同 `25` 秒 watchdog 與 `45` 秒外層 timeout。
   - 第一次擴充 probe exit `0`，但人工檢圖發現 mobile 圖仍帶前一情境的 credential success toast；此為 harness 情境污染，不列入產品失敗。
   - harness 改由正式「關閉成功通知」控制清除 toast；`node --check "docs/acceptance/issue11-ui-harness.mjs"` 再次 exit `0`。
   - 修正後有限 probe exit `0`；`startInstancePostsBeforeScreenshot = 0`、`mobileNavigation = ["list", "detail", "list"]`、`credentialCalls = 1`、`shutdownCalls = 1`。
   - 兩次 probe 都是 finite exit；兩次均 `watchdog_fired = false`、`close_fallback_used = false`、lifecycle `stopped`。

## Credential timeout 根因

- 正式 UI 只有在 `PATCH /api/v1/settings/credentials` resolve 後才顯示「OMW 帳密已更新」；實際 Manager contract 是無 body 的 HTTP `204`。
- 第一輪 inline harness 沒有保存為檔案，既有紀錄也沒有保存 PATCH response status 或 mock route 命中證據，因此不能事後誠實斷言當時是「route 完全不存在」或「回傳狀態錯誤」。可確定的 harness defect 是：它直接等待 success locator，沒有先觀測並斷言 credential response，導致 mock contract 問題只能以 30 秒 watchdog／`Browser closed` 呈現。
- 補驗 harness 將兩者分開：未命中 route 立即回 `501 FIXTURE_ROUTE_MISSING` 並在結尾失敗；命中 credential route 必須先觀測 HTTP `204`，才等待 success toast。這次 `204`、toast 與欄位清空全部成立，故沒有產品 UI defect 證據。

## Lifecycle 與 cleanup 結果

第一輪失敗後的 PID 40888 reconciliation 紀錄已列於前節，其 cleanup 結果維持 `stopped`，不重寫歷史。補驗使用新的 fresh current-run BrowserServer binding，結果為：

```json
{
  "applicable": true,
  "platform": "Windows",
  "selected_tier": "external-launcher",
  "owner_binding": {
    "kind": "official-interface-current-run"
  },
  "action": "Finalize",
  "final_disposition": {
    "requested": "Stop",
    "status": "stopped"
  },
  "watchdog_fired": false,
  "close_fallback_used": false,
  "os_inspection_performed": false,
  "lifecycle_shell_calls": [],
  "minimum_outcomes": {
    "ownership_binding": "owner handled",
    "stdio": "owner handled",
    "readiness": "owner handled",
    "observation": "owner handled",
    "disposition": "owner handled",
    "cleanup_or_handoff": "owner handled",
    "lifecycle_callback": "owner handled"
  },
  "lifecycle_result": {
    "status": "stopped"
  },
  "downstream_result": {
    "credentialCalls": 1,
    "shutdownCalls": 1,
    "startInstancePostsBeforeScreenshot": 0,
    "mobileNavigation": [
      "list",
      "detail",
      "list"
    ],
    "mobileGeometry": {
      "clientWidth": 390,
      "scrollWidth": 390,
      "mobileView": "list"
    }
  }
}
```

補驗的 BrowserServer close 與同一 binding 的 kill fallback 都位於 [`issue11-ui-harness.mjs`](issue11-ui-harness.mjs) 的 `finally`；watchdog 只 reject 下游驗收，不能略過 cleanup。本輪兩次擴充 probe 的 `BrowserServer.close()` 都正常完成，沒有使用 kill fallback。Static server 與 BrowserServer 都已關閉；沒有 Preserve／handoff，也未接管既有外部程序或依 PID／port 猜測 ownership。

## 未驗證 criteria

- 真實 OpenCode executable／TUI 啟動，以及 `omw opencode <project> -s <session>` 的指定 Session 路徑；這仍是 Issue #11 本輪 PR 的必要條件。
- Credential update 後真實新帳密可用、舊帳密立即拒絕、launcher token 保留、DPAPI persistence，以及寫入失敗時舊帳密仍可用。
- 真 Manager 的 shutdown HTTP `202`、Manager-only process 停止，以及 OpenCode process/session/project 實際保留。
- Mobile touch interaction、browser back gesture、真裝置 browser behavior 與真實網路狀態；本次只補 Playwright `390 × 844` viewport 的 click-based list/detail/list 切換與水平 overflow。
- 真手機、Tailnet、Tailscale Serve 可達性仍未驗證；viewport 模擬不能取代這些驗收，但使用者已同意它們不阻擋 Issue #11 本輪 PR。
- 真實 Manager／SQLite／DPAPI／OpenCode Instance／Session／provider integration。
- 公開 registry `npx @sevenflanks/omw` 端到端行為與 npm 發布。

本輪沒有重跑既有 29 tests、DPAPI、parallel tests 或任何完整 test suite，也沒有 commit、push 或建立 PR。
