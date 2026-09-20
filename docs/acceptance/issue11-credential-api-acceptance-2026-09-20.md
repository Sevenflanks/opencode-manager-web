# Issue #11 credential／shutdown bounded 驗收紀錄

- 驗收日期：2026-09-20
- Worktree：repository root（checkout path supplied by the caller）
- Branch：`feat/issue11-local-onboarding`
- 基準 HEAD：`42521b046945b6fefd1d20ae55f01f4e0c37cf60`
- 驗收腳本：[`issue11-credential-api-acceptance.mjs`](issue11-credential-api-acceptance.mjs)
- 結論：本次有限驗收通過，未發現 credential rotation、restart load、launcher token 保留、save failure rollback 或 shutdown API 的產品 defect。

## 驗收邊界與隔離

腳本只在單一有限 Node process 內建立 Fastify app，所有 HTTP 操作皆使用 `app.inject()`；未呼叫 `listen()`、未開啟網路 port、未啟動 packaged Manager／Manager CLI／OpenCode TUI／browser，也未建立 detached 或長駐 subprocess。Fastify app 全部由 current-run script 持有，正常路徑明確 `app.close()`，`finally` 再關閉尚未結束的 app。

Credential data 使用 `os.tmpdir()` 下由 `mkdtemp()` 建立的 current-run 目錄；每個 `DpapiCredentialStore` 的 helper deadline 為 3 秒，所有 inject／close 操作也各有 3 秒 deadline。Windows DPAPI helper 是短生命週期前景 child process，驗收完成後 Temp root 由 `finally` 遞迴刪除。未讀寫既有 OMW data，未修改 ACL、firewall、Tailscale 或 provider 設定。

這是 source build 後的 in-process Fastify／真 Windows current-user DPAPI 驗收，**不是** packaged Manager、Manager CLI 或 TUI E2E，也不證明 browser、Tailnet、Tailscale Serve 或實際網路 listen 行為。

Scope 判定：使用者已明確同意將真手機與 Tailnet 驗收移出 Issue #11 本輪 PR 的必要條件；這不把它們改記為通過。真實 OpenCode TUI 啟動與 `-s` 指定 Session 路徑仍是本輪必要條件，且不在這份 in-process API 報告的已通過範圍內。

## 具體 checks

| Check | 結果 | 證據 |
| --- | --- | --- |
| 真 DPAPI 初始保存 | 通過 | `DpapiCredentialStore.save()` 在隔離 Temp data directory 完成。 |
| Credential rotation | 通過 | remote-style authority／Origin／CSRF／Basic auth 呼叫 `PATCH /api/v1/settings/credentials` 回 `204`。 |
| 新／舊 auth 即時切換 | 通過 | rotation 前舊 auth 回 `200`；rotation 後舊 auth 回 `401`、新 auth 回 `200`。 |
| Launcher token 保留 | 通過 | rotation 前、rotation 後與 fresh load 後，原 launcher token 呼叫 `/api/v1/launcher/identity` 皆回 `200`；fresh-loaded value 與原 token 相等。 |
| DPAPI plaintext 防漏 | 通過 | `credentials.dpapi` 不含舊密碼、新密碼或 launcher token fixture plaintext。 |
| Restart load | 通過 | 關閉第一個 app 後，以同一 `DpapiCredentialStore.load()` 重建 authenticator／controller；新 auth 回 `200`、舊 auth 回 `401`。 |
| Save failure 保留 old | 通過 | 使用另一個真 `DpapiCredentialStore` 完成 DPAPI Protect 後，因隔離 data-directory path 刻意是一般檔案而在 filesystem persistence 階段失敗；PATCH 回 `500`，既有 auth 仍回 `200`、嘗試的新 auth 回 `401`，canonical store reload 仍是 rotation 後 credentials。未用 ACL 製造失敗。 |
| Shutdown API | 通過 | authenticated `POST /api/v1/manager/shutdown` 回 `202 { stopping: true }`；callback 只排程一次，關閉該 in-process Fastify app，service shutdown 只呼叫一次。沒有 OpenCode runtime／process 可被停止。 |

## 對應實作 seam

- `apps/manager/src/credential-controller.ts:11-31`：驗證 current password；先 `store.save(next)`，成功後才替換 controller 與 authenticator 的 credentials，因此 persistence failure 不得切換 auth。
- `apps/manager/src/auth.ts:21-46`：browser Basic auth 與 launcher token 分 audience 驗證；`replace()` 提供成功保存後的即時切換。
- `apps/manager/src/credential-store.ts:28-74,101-176`：Windows current-user DPAPI Protect／Unprotect、Temp file 與 atomic rename；helper 有 deadline。
- `apps/manager/src/app.ts:103-128`：credential PATCH 與 Manager shutdown route；shutdown callback 由 `setImmediate()` 排程。
- `apps/manager/src/app.ts:256-258`：`app.close()` 僅呼叫注入 service 的 `shutdown()`。

## 實際命令與結果

1. Syntax check：

   ```powershell
   node --check "docs/acceptance/issue11-credential-api-acceptance.mjs"
   ```

   - exit `0`，無輸出。

2. Manager source build：

   ```powershell
   npm run build --workspace @omw/manager
   ```

   - exit `0`。
   - `@omw/contracts` 與 `@omw/manager` TypeScript build 均通過。

3. 單一 bounded 驗收腳本：

   ```powershell
   node "docs/acceptance/issue11-credential-api-acceptance.mjs"
   ```

   - outer tool timeout：45 秒；exit `0`。
   - script 回報 `status = "passed"`、`networkListenUsed = false`、`detachedProcessUsed = false`、`managerOrTuiStarted = false`。
   - DPAPI helper deadline 與 inject／close operation deadline 均為 3 秒。
   - 六個摘要 check 全數通過：初始 DPAPI save、rotation／即時 auth switch／token 保留、plaintext 檢查、fresh load、save failure rollback、shutdown API／close。

4. Cleanup failure reporting 加固後的最終重驗：

   ```powershell
   node --check "docs/acceptance/issue11-credential-api-acceptance.mjs" && node "docs/acceptance/issue11-credential-api-acceptance.mjs"
   ```

   - outer tool timeout：45 秒；exit `0`。
   - 最終輸出仍為 `status = "passed"`，六個摘要 check 全數通過；`finally` cleanup 若有 app close 或 Temp removal error，腳本現在會以 `AggregateError` 失敗，而不會靜默視為通過。

依使用者提供的既有證據，full tests 已為 `141 pass / 10 skip`；本次遵守範圍，沒有重跑 full suite。

## 未驗證項目

- Packaged Manager／Manager CLI／TUI 的 startup、listen、restart、shutdown 與 descendant process lifecycle。
- 真實 OpenCode executable／TUI 啟動，以及 `omw opencode <project> -s <session>` 的指定 Session 路徑；這仍是 Issue #11 本輪 PR 的必要條件。
- 真 OpenCode runtime、Session／Project 保存、provider 與 browser UI。
- 真手機、Tailnet／Tailscale Serve 與遠端網路可達性仍未驗證，但使用者已同意它們不阻擋 Issue #11 本輪 PR。
- 實際同一 production credential file 所在目錄的 disk-full、rename denial 或 ACL failure；本次 failure check 使用隔離的 blocked-path filesystem failure，不修改 ACL，並另行確認 canonical DPAPI store 未變。
- 完整 test suite、package tarball／published package 與本次驗收範圍外的既有 worktree 變更。

本次只新增上述 script 與本報告，沒有修改產品來源碼、測試或設定，沒有 commit、push 或 PR。
