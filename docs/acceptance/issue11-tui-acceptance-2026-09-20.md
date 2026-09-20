# Issue #11 真實 OpenCode TUI 驗收

日期：2026-09-20

目前結論：

- **人工驗收：PASS**。使用者於 2026-09-20 依人工隔離環境 guide，在一般 PowerShell（`pwsh`）完成 local package 安裝、Manager 初始化返回終端、cwd 與指定 Project 的真實 TUI／`-s target`、Web 登錄、`Ctrl+C`、Manager-only shutdown 後 TUI 保留，以及 restart 後 target 保留；測試 TUI 與 Manager 均已停止。完整邊界見 [人工本機驗收報告](issue11-manual-local-acceptance-2026-09-20.md)。
- **歷史 synthetic PTY harness：NOT_PROVEN**。下列 harness 紀錄維持原始結果，不因後續人工通過而改寫。

歷史 app attempt 的 sharing violation 與錯誤 Manager Primary/session 門檻均已修正。最後授權的 fresh fixture 完整證明 exact PTY input/output、finite exit、pre-resume Job membership 與 cleanup；隨後唯一 fresh app attempt 在 ConPTY host resume 前因 `AssignProcessToJobObject failed with Win32 error 5` fail closed。該次真 launcher/TUI 未啟動，因此 target、decoy、`local-tui ready` 與 Ctrl-C criteria 均未達 harness 可驗證階段。

本報告只保留非機敏的結果、計數與 boolean。PID、Session ID、隨機 title suffix、credential、token、DPAPI ciphertext、absolute sandbox path 與 raw runtime output 均未寫入本報告。

## 歷史 harness 固定環境

- OpenCode executable：已驗證的 `opencode.exe`
- OpenCode：`1.18.31`
- PowerShell：`7.6.6`
- Node.js：`24.15.0`
- .NET SDK：未安裝
- PowerShell `Add-Type`：可用
- Lifecycle tier：`windows-self-managed`
- Final disposition：`Stop`

## Reader 修正與 Probe

ConPTY writer 使用：

```text
FileAccess.Write + FileShare.ReadWrite
```

修正後 reader 使用：

```text
FileAccess.Read + FileShare.ReadWrite|Delete
```

先執行不啟動 app 的 probe：

```powershell
pwsh -NoLogo -NoProfile -NonInteractive -File "docs/acceptance/issue11-tui-acceptance.ps1" -FixtureOnly
```

Exit code：`0`

Probe 在 writer 持續開啟時依序 append `first` 與 `-second`，每次 flush 後以修正後 reader 讀取。結果：

```json
{
  "status": "passed",
  "concurrent_append_read": true,
  "writer_share": "ReadWrite",
  "reader_share": "ReadWrite|Delete",
  "actual_app_attempts": 0
}
```

同一命令的 harmless lifecycle fixture 亦通過：

- `assigned_before_resume=true`
- `owned_job_empty=true`
- `authority_verified=true`
- `termination_attempted=false`
- `forced_termination_used=false`
- `owned_tree_empty=true`
- `root_process_absent=true`
- `named_job_absent=true`
- `job_holder_absent=true`
- `record_present=false`
- `record_cleanup_completed=true`

## 歷史實際 Attempt

全新 sandbox 中執行唯一一次實際 app attempt：

```powershell
pwsh -NoLogo -NoProfile -NonInteractive -File "docs/acceptance/issue11-tui-acceptance.ps1"
```

Exit code：`1`

執行前通過 C# compile、PowerShell parser、shared reader probe、harmless lifecycle fixture，以及 contracts、Manager、launcher build。

摘要：

```json
{
  "actual_app_attempts": 1,
  "shared_read_probe": "passed",
  "status": "NOT_PROVEN"
}
```

runner 的 bounded proof deadline 到期：

```text
NOT_PROVEN: no bounded screen + target/not-decoy + Manager local-tui proof.
```

## 歷史證據與契約更正

- 真 OpenCode server seeder 在 loopback 啟動，target 與較新的 decoy Session 建立後已停止。
- Manager postmortem database 有 `1` 筆 `kind=local-tui` instance，state 為 `ready`。
- Skill stdout evidence 含真 ANSI TUI render 與 target title。
- Skill stdout evidence 未找到 decoy title。
- 指定的 ConPTY screen evidence file 只有 `95` bytes terminal initialization；完整 ANSI TUI 輸出落在外層 skill stdout，而非該檔案。
- Manager postmortem database 的 primary Session 筆數為 `0`；依 `docs/security/launcher-contract.md`，`-s` 只選 OpenCode TUI 對話，不建立或證明 OMW Primary Session Binding，因此此結果正常，不是失敗條件。
- 沒有產生通過條件才會保存的 sanitized Manager overview evidence。

先前 runner 額外要求 Manager overview 同時列出 target、decoy 並以 target 建立 Primary binding，這超出產品契約，已從 harness 移除。正確聯合門檻為：指定 PTY screen 顯示 target、不顯示較新的 decoy，且同一 bounded attempt 的 Manager instance 為 `kind=local-tui`、state=`ready`。

## STD Handle 修正與 harmless PTY gate

ConPTY 初始 host 現在會在已附著 pseudoconsole 後重新開啟 `CONIN$`、`CONOUT$`，再以明確的 `STARTF_USESTDHANDLES` 與 `CREATE_SUSPENDED` 啟動 Node。resume 前會驗證 Node 已繼承 current-run Job，避免 Node 的 `stdio: "inherit"` descendants 留在 lifecycle host 的 redirected stdio。

執行不啟動 app 的完整 fixture gate：

```powershell
pwsh -NoLogo -NoProfile -NonInteractive -File "docs/acceptance/issue11-tui-acceptance.ps1" -FixtureOnly
```

Exit code：`1`

摘要：

```json
{
  "actual_app_attempts": 0,
  "shared_read_probe": "passed",
  "lifecycle_fixture": "passed",
  "status": "NOT_PROVEN"
}
```

PTY probe 使用 Node parent 以 `stdio: "inherit"` 啟動 leaf，host 只透過 ConPTY input 寫入唯一 marker。指定 PTY screen evidence 同時包含：

- leaf readiness marker
- designated input marker 的 terminal echo
- leaf 讀取該 input 後輸出的唯一 reply marker
- outer lifecycle stdout 為空
- outer lifecycle stderr 只有 harness timeout error，沒有 channel marker

因此 STD handle 修正確實把 input/output 留在指定 PTY channel。新 blocker 是 synthetic leaf 在輸出 reply 後仍保持 stdin event-loop 活性，沒有於 8 秒內自然退出；runner 依 finite gate 終止 owned Job，未建立 readiness，也未進入 app phase。

fixture 已修正為 reply write completion 後 `process.exit(0)`；下節記錄後續明確授權的單次驗證結果。

## 最後授權驗證

先執行一次 fresh harmless fixture：

```powershell
pwsh -NoLogo -NoProfile -NonInteractive -File "docs/acceptance/issue11-tui-acceptance.ps1" -FixtureOnly
```

Exit code：`0`

結果：

```json
{
  "actual_app_attempts": 0,
  "status": "FIXTURES_PROVEN",
  "input_via_designated_channel": true,
  "output_via_designated_channel": true,
  "in_job_before_resume": true,
  "finite_exit": true,
  "owned_job_empty": true,
  "lifecycle_stdio_clean": true
}
```

Harmless lifecycle 與 PTY fixture 均以 graceful Stop 完成，兩者皆為：

- `termination_attempted=false`
- `forced_termination_used=false`
- `owned_tree_empty=true`
- `root_process_absent=true`
- `named_job_absent=true`
- `job_holder_absent=true`
- `record_cleanup_completed=true`

App invocation 先 fail-closed 驗證上述 fresh summary 的 repository、age、zero-app、exact-channel 與 cleanup，再建立另一個 fresh sandbox；沒有重跑 fixture：

```powershell
pwsh -NoLogo -NoProfile -NonInteractive -File "docs/acceptance/issue11-tui-acceptance.ps1" -VerifiedFixtureSummary "<fresh ignored runtime>/summary.json"
```

Exit code：`1`

contracts、Manager 與 launcher build 均通過，之後執行唯一 app attempt：

```json
{
  "actual_app_attempts": 1,
  "verified_fixture": "FIXTURES_PROVEN",
  "status": "NOT_PROVEN"
}
```

精確錯誤：

```text
AssignProcessToJobObject failed with Win32 error 5
```

發生位置為 `OwnedJob.BindAndResume` 經 `OwnedJob.StartConPty` 呼叫。ConPTY host 已用 `CREATE_SUSPENDED` 建立，但指派 inner current-run Job 失敗，所以 helper 在 resume 前終止該 process；沒有以未受控 process 繼續，也沒有 fallback 或再次嘗試。

Criteria 結果：

| Criterion | 結果 | 證據 |
| --- | --- | --- |
| fresh isolated target 與較新 decoy | PASS | real serve seeder 建立後已停止 |
| app command 使用 project cwd 與 `-s target`，無 positional project | PREPARED_NOT_RESUMED | PTY request 已建立，ConPTY host 在 resume 前被終止 |
| 指定 PTY screen 顯示 target title | NOT_EVALUATED | `tui-screen.ansi` 未建立 |
| 指定 PTY screen 不顯示 decoy title | NOT_EVALUATED | `tui-screen.ansi` 未建立 |
| Manager `kind=local-tui`, state=`ready` | NOT_REACHED | launcher 未 resume，未進行 registration |
| bounded Ctrl-C 使 launcher/TUI 退出 | NOT_EXECUTED | proof readiness 未建立 |
| inner app Job 清空 | PASS | `cleanup_job_empty=true` |
| outer lifecycle cleanup | PASS | root、holder、named Job、record 全部 absent，errors 空陣列 |

## Cleanup

runner catch/finally：

```json
{
  "cleanup_job_empty": true
}
```

外層 skill launch-failure cleanup：

```json
{
  "attempted": true,
  "status": "completed",
  "root_absent": true,
  "holder_absent": true,
  "named_job_absent": true,
  "record_absent": true,
  "publication_artifacts": [],
  "errors": []
}
```

cleanup authority 來自 current-run Job/handle 與 skill record，沒有掃描所有 PID 或 port，也沒有停止第三方 process。

歷史 app proof readiness 未成立，因此預定的 bounded Ctrl-C 路徑沒有執行；只依該次 harness 不能宣告 Ctrl-C 行為已驗證。後續人工驗收已補足真實互動式終端的 `Ctrl+C` PASS，但不改變 harness 結果。實際 harness cleanup 是 runner Job termination 加上 skill 外層 launch-failure cleanup。

先前 harmless PTY gate 亦 fail closed：

```json
{
  "actual_app_attempts": 0,
  "cleanup_job_empty": true,
  "root_absent": true,
  "holder_absent": true,
  "named_job_absent": true,
  "record_absent": true,
  "cleanup_errors": []
}
```

## 隔離與 Git 排除

每次 app attempt 都使用全新的 runtime root，隔離 `HOME`、`USERPROFILE`、`APPDATA`、`LOCALAPPDATA`、XDG directories、OpenCode DB/config 與 `OMW_DATA_DIR`。default plugins、model fetch、LSP download、autoupdate 與 Claude Code integration 均停用；未讀取既有 credential 或 Session。最後 app attempt 前的 fresh fixture run 只執行 harmless fixture，沒有啟動 seeder、Manager 或 OpenCode app。

最後授權的 app attempt 同樣使用 fresh isolated runtime。Seeder 與 Manager 曾在 owned Job 中啟動；launcher/OpenCode 未 resume。失敗後 inner 與 outer Job 都已清空。

`.gitignore` 使用以下精準規則，保留 runtime evidence 在磁碟但阻止 `git add docs` 納入：

```gitignore
/docs/acceptance/.issue11-tui-*/
```

此規則排除每個 `.issue11-tui-*` runtime root 內的：

- 隔離 `credentials.dpapi`
- Manager SQLite、OpenCode DB 及其 WAL/SHM
- temporary HOME、APPDATA、XDG、config 與 project
- raw ANSI screen 與 plain screen
- lifecycle record、stdout、stderr
- Manager/seeder stdout 與 stderr
- runtime result、summary 與 Manager overview JSON

既有 runtime evidence 未刪除。

## 歷史 harness 未證明的項目

- app workload 已有 Manager process 時，為何新的 suspended ConPTY host 無法再加入 inner Job；目前只有 Win32 error `5`，未進一步試跑定位。
- 指定 ConPTY evidence stream 是否能在成功 resume 的 fresh app attempt 持續捕捉 child OpenCode TUI。
- 同一 bounded app attempt 是否能證明 PTY screen 顯示 target、不顯示 decoy，且 Manager `local-tui` state=`ready`。
- bounded Ctrl-C 是否讓 launcher/OpenCode 正常退出。

上述清單描述 synthetic PTY harness 本身仍未證明的事項。2026-09-20 的獨立人工驗收已補足 cwd、指定 Project、`-s target`、Web 登錄、`Ctrl+C`、Manager-only shutdown 後 TUI 保留與 restart target 保留等 user-observable 路徑；不代表 ConPTY harness、Job Object 細節或 release artifact 已驗證。

## 歷史 harness 當時的待提交檔案

下列清單只記錄 synthetic PTY harness 當時的 staging 建議，不是目前的 commit 指示。當時只應明確 stage 以下 harness、安全排除與 sanitized report，不應使用會包含其他既有文件的寬泛 pathspec：

```text
.gitignore
docs/acceptance/Issue11TuiNative.cs
docs/acceptance/issue11-tui-runner.ps1
docs/acceptance/issue11-tui-acceptance.ps1
docs/acceptance/issue11-tui-acceptance-2026-09-20.md
```

本次未修改產品 source，未 commit 或 push。
