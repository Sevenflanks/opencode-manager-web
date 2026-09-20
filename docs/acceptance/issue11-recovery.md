# Issue 11 驗收中斷 recovery

## 結論

- 前一個 verifier 的最後一筆 `bash` tool 並不是測試失敗；四個 package CLI invocation 已各自結束，驗收 Manager 則持續在背景執行，外層 tool 最後被中止。
- recovery 以同一份 isolated DPAPI credential 驗證 Manager identity，並透過產品提供的 `POST /api/v1/manager/shutdown` 正常停止該 Manager。沒有依 PID、process name 或僅憑 port 猜測 ownership，也沒有執行強制終止。
- cleanup lifecycle 最終狀態是 `stopped`。目前證據指向驗收 harness／tool lifecycle 的問題，沒有證據顯示 package CLI 或 Manager 產品行為需要修正。
- 本次沒有重跑測試、沒有啟動新的 Manager、TUI 或 browser。

## 已證實事實

### 前一個 verifier session

以 SQLite read-only mode 讀取前一個 session，且只檢查 `tool`／`text` records：

- 最後一筆 tool 是執行四個 package CLI invocation、DPAPI credential 讀取、authenticated identity probe 與 overview probe 的 PowerShell command。
- 該 tool record 的狀態為 `error`，錯誤為 `Tool execution aborted`。
- tool record 從建立到更新相隔 `4067.841` 秒（約 67 分 48 秒）。record 沒有保存 stdout。
- 中斷交接保留的 command 結果為：四個 CLI invocation 全部 `exit 0`、四份 stdout 都包含預期 Manager URL、stderr 全空、authenticated identity 為 `omw-manager` protocol version `1`，overview instance count 為 `0`。
- 個別 package CLI process 已結束；持續存在的是 CLI 啟動後刻意 preserve 的背景 Manager。

### Package 與 credential

- 驗收使用 isolated package install 的 `dist/src/manager-cli.js`，不是 worktree source entry。
- isolated data directory 內存在 `credentials.dpapi` 及 Manager SQLite files；驗收 artifact 中沒有可供 recovery 使用的 lifecycle owner record 或 process handle。
- DPAPI roundtrip command 正常結束，結果為：
  - `protect_exit = 0`
  - `unprotect_exit = 0`
  - username、password、launcher token roundtrip 均相符
  - ciphertext 中不含 password 或 launcher token plaintext
- `OMW_OPENCODE_EXECUTABLE` 指向 `node`，因此這一輪沒有驗證真實 OpenCode TUI integration。

### Recovery cleanup

Recovery 只使用 isolated credential 與官方 HTTP interface：

1. DPAPI credential 僅在記憶體中解密，沒有輸出任何 username、password 或 token。
2. `GET /api/v1/launcher/identity` 使用 isolated launcher token 驗證成功，回應符合 `omw-manager` protocol version `1`。
3. `POST /api/v1/manager/shutdown` 使用同一 credential、受信任 Origin 與 CSRF header，回應 HTTP `202`。
4. 第一次 bounded poll 即確認 authenticated identity endpoint 已不可達。

Lifecycle 結果：

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
  "cleanup_attempt": "attempted",
  "cleanup_result": "stopped",
  "os_inspection_performed": false,
  "lifecycle_shell_calls": [],
  "termination_performed": false,
  "lifecycle_result": {
    "status": "stopped"
  },
  "downstream_result": null,
  "minimum_outcomes": {
    "ownership_binding": "owner handled",
    "stdio": "not applicable",
    "readiness": "owner handled",
    "observation": "owner handled",
    "disposition": "owner handled",
    "cleanup_or_handoff": "owner handled",
    "lifecycle_callback": "owner handled"
  }
}
```

## 卡住原因：證實與推論

### 證實

- 四個短生命週期 CLI invocation 已成功退出；Manager readiness 與 identity 驗證也成功。
- Manager CLI 在 readiness 成功後會 preserve／unref 背景 Manager。這是產品目前的預期設計。
- 外層 `bash` tool 沒有在 command 工作完成後返回，約 67 分 48 秒後才被中止。
- recovery 開始時該 authenticated Manager 仍存在；官方 shutdown 後立即停止。

### 推論

最可能的原因是驗收 harness 把「會留下背景 Manager」的 command 放在前景 tool execution 中，而 tool／Windows process ownership 或 inherited handle tracking 仍把背景 Manager 視為該 execution 的 descendant，因此即使四個 CLI parent 都退出，tool 仍未完成。

現有證據不足以判定是 Job Object、pipe handle、tool runner 的 process-tree wait，或其他等價的 host lifecycle 機制造成。不能只靠本次結果把其中任一機制宣告為根因。

## 是否需要修正

### 驗收 harness：需要

後續驗收應使用明確的 lifecycle owner contract：

- 不要以一般前景 tool call 啟動預期長駐的 Manager 後等待 tool 自然返回。
- launch 前先決定 `Stop` 或有明確 later owner 的 `Preserve`，並保存可供同一次 run 使用的 ownership binding。
- 使用 authenticated identity 作 readiness；驗收結束時一律呼叫官方 shutdown，並做 bounded confirmation。
- CLI stdout／stderr 驗證與 Manager lifecycle 應分開管理，避免 runner 是否追蹤背景 descendant 影響 assertion 結果。

### 產品：目前不需要

本次證據顯示 package CLI concurrency、DPAPI credential store、authenticated identity、overview 與官方 shutdown 都依設計運作；沒有建立產品 defect 的證據。

若未來需要讓 automation 更簡單，可另行評估公開 `omw stop` command 或持久化 lifecycle handoff record，但這是可選改善，不是本次驗收成立所需的產品修正。

## Recovery 實際命令與結果

| 操作 | 命令摘要 | 結果 |
| --- | --- | --- |
| Session DB schema | `python -c` + SQLite URI `mode=ro` | 成功；確認 `session`、`message`、`part` schema |
| Session evidence | `python -c` read-only query，限定指定 session 與 `tool`／`text` | 成功；取得最後 tool status、command metadata 與 `4067.841` 秒 elapsed |
| Artifact inspection | read-only glob／file read | 成功；沒有找到 lifecycle owner record |
| Authenticated cleanup | DPAPI Unprotect → launcher identity → Manager shutdown → bounded poll | `identity_verified=true`、`shutdown_status=202`、`stopped_within_deadline=true`、`poll_count=1` |
| 測試 | 未執行 | 依 recovery 限制，不重跑任何測試 |

兩個 recovery command 在執行有效動作前曾發生純工具錯誤：本機沒有 `sqlite3` executable，之後改用 Python stdlib SQLite；第一次 shutdown PowerShell command 有 parser error，修正括號後才執行 authenticated probe 與 shutdown。兩次失敗都沒有啟動或停止 process，也沒有修改 artifact。

## 未驗證項目

- 真實 OpenCode executable／TUI launch、`omw opencode <project> -s <session>` 的指定 Session 路徑與 wrapper exit behavior；TUI／`-s` 仍是 Issue #11 本輪 PR 的必要條件。
- Browser onboarding、credential settings UI、manual shutdown UI 與 remote access path。
- 真手機與 Tailnet 驗收不在本 recovery 範圍內，仍不能宣稱通過；使用者已同意它們不阻擋 Issue #11 本輪 PR。
- 完整 test suite、package rebuild，以及與本次 recovery 無關的既有 worktree 變更。
- 外層 tool 等待背景 descendant 的 host-level 精確機制；本次只確認現象與安全 cleanup，沒有進行全機 process tree 或 PID investigation。
