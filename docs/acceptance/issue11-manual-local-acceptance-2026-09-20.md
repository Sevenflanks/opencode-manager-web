# Issue #11 人工本機驗收報告

- 驗收日期：2026-09-20
- 結果來源：使用者親自執行並回報；不是 agent 重跑
- 執行環境：依前次人工隔離環境 guide，在一般 PowerShell（`pwsh`）執行，不是 agent synthetic PTY
- 結論：**PASS**

## 驗收結果

| 項目 | 結果 | 使用者回報 |
| --- | --- | --- |
| Local package 打包與本機安裝 | PASS | 由目前 worktree 建立 local package 並完成本機安裝 |
| Manager 初始化 | PASS | 初始化成功，且命令完成後控制權返回終端 |
| cwd 真實 TUI 與 Web 登錄 | PASS | 未指定 Project 時使用 cwd 啟動真實 OpenCode TUI，Web 可看到登錄結果 |
| `Ctrl+C` 退出 | PASS | TUI 可由使用者在終端以 `Ctrl+C` 退出 |
| cwd + `-s target` | PASS | 使用 cwd 並指定 target Session 可進入預期 target |
| 指定 Project + `-s target` | PASS | 明確指定 Project 與 target Session 可進入預期 target |
| `stopManager` 後 TUI 保留 | PASS | 停止 Manager 後，既有 TUI 仍可操作 |
| 重新啟動後 target 保留 | PASS | 重新啟動後仍保留並可回到 target |
| 驗收 cleanup | PASS | 使用者確認測試 TUI 與 Manager 均已停止 |

## 證據邊界

本報告記錄的是使用者在真實互動式終端完成的人工驗收結果，用來補足 [歷史 synthetic PTY harness 報告](issue11-tui-acceptance-2026-09-20.md) 未能自動證明的 user-observable 路徑。歷史 harness 的 `NOT_PROVEN` 結果維持不變；人工結果不會回溯改寫該次 harness attempt 為成功。

驗收環境保留的 `package/sevenflanks-omw-0.1.0.tgz` SHA-256 為 `D21651898B322961B33D08E6C76375A5C4A9E905C89A3A2D2541F38EDB87BD17`，同一環境的 install lock 明確引用該 local package。以 clean commit `dfb0f828527eda06bd6ecfb60a6bf970fd07529f` 重建後，package 內 47 個 `dist` 檔案全部與重建輸出逐 byte 相同，因此可將本次人工驗收對應到該產品實作與 local artifact hash。

這項對照不會把 local artifact 變成 release artifact，也不代表 public npm 已發布或已驗證；本報告仍**不宣稱 release artifact 或已發布版本已通過驗證**。沒有推測或補記確切驗收時間。

下列項目不在本次人工驗收的已通過範圍：

- 個人既有 OpenCode 設定、plugin、Session 與資料相容性。
- 真手機、Tailnet、Tailscale Serve、touch 與 browser back gesture；這些項目已移出 Issue #11 本輪必要條件。
- Public npm registry publication、scope ownership 與 `npx @sevenflanks/omw` end-to-end。
- 可由 commit、tag、SHA 或正式發布 artifact 重現的 release 驗證。
- Credential rotation 的新舊帳密、launcher token retention 與 persistence failure rollback。

日常操作方式見使用手冊的 [`Usage`](../user-guide.md#usage)，仍適用的設定與安全界線見 [`Configuration`](../user-guide.md#configuration)。
