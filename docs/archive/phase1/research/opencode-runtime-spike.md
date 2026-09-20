# OpenCode Runtime Capability Spike

> 歷史歸檔：本報告記錄 2026-09-17、OpenCode `1.18.31` 的受控觀察，
> 不是現行 OMW 契約。本機絕對路徑已改為相對路徑或 placeholder。

後續第二輪驗證請見 [`opencode-parent-and-tui-spike.md`](./opencode-parent-and-tui-spike.md)。本報告中的 `NOT TESTED` 是第一輪完成當時的狀態；第二輪已補充部分 parent exit 與 native TUI/ConPTY 探查，但不代表第一輪報告被重寫或所有未測項已解決。

日期：2026-09-17

目標環境：Windows 11 / PowerShell 7

性質：受控 spike，非產品實作

## 結論

本次已完成一次成功的受控 runtime run。已安裝的 `opencode-ai@1.18.31` 能在隔離 sandbox 中同時啟動兩個 loopback-only `serve` instance，兩者都能回應 health、指向同一個隔離 project directory，並透過同一個隔離資料庫看見空 session。停止 instance 1 後 instance 2 仍健康，最後兩個 child process 與兩個 listener 都已清除。

這支持 OMW 啟動多個 headless OpenCode server、各自使用不同 loopback port 的可行性。隔離 home/config/data 是本次測試的保護措施，不是產品必須為每個 instance 隔離使用者設定與資料的決策。這還不是完整產品驗收，也不能據此宣稱手機、Tailscale、TUI 或完整 agent workflow 已通過。

目前沒有證據證明 foreground 是原始問題的原因，也沒有證據證明工具 hang 的唯一原因是 foreground。成功 run 的 elapsed time 為 `4228 ms`；這只能說明本次受控命令正常完成，不能反推未測情境。

相關 issue 已建立：https://github.com/Sevenflanks/skills/issues/16

## 結果總覽

| 測項 | 結果 | 證據摘要 |
|---|---|---|
| Installed CLI version/help | PASS | `opencode --version` 為 `1.18.31`；help 有 `serve`、`web`、`attach` 與 TUI default command |
| Executable/package provenance | PASS | npm package `opencode-ai@1.18.31`，bin 指向 `bin/opencode.exe`；保留 hash 與 embedded version 差異 |
| Isolated environment | PASS | home、XDG roots、absolute `OPENCODE_DB`、config、project 均指向本次 sandbox；沒有改 parent environment 或 PATH |
| Two loopback-only `serve` instances | PASS | success run 的兩個 instance 都以 `1.18.31` 回應 `/global/health` HTTP 200 |
| `/path` isolated cwd | PASS | 兩個 instance 的 `/path.directory` 都等於 sandbox `project` |
| `/project/current` non-Git project | PASS | 以 URL `directory` 傳入 sandbox project；回傳 `worktree: "/"`、`vcs: null`，判定為 non-Git global project |
| Web root/static asset | PASS, limited | `/` 回傳 OpenCode HTML HTTP 200，且本地 favicon asset HTTP 200；未做完整 browser JavaScript 驗證 |
| Isolated `/session` storage | PASS | 兩端 initial count 都為 0；instance 1 建立 empty session 後，instance 2 在 378 ms 內看見；最後刪除成功 |
| Stop isolation | PASS | `Kill(true)` 停止 instance 1 後，instance 2 health 仍為 200/healthy |
| Failure cleanup after second start | PASS | injection 在第二次 `Process.Start` 後、metadata/readiness 前故意失敗；兩個已登記 process 都清理 |
| Cross-tool-call survival | NOT TESTED | 本次是同一個 harness command 內由另一個 HTTP caller在 launch functions return 後探測，不等同 OMW restart/crash recovery |
| Running-agent same-session coordination | NOT TESTED | 已驗證 persistence/shared session visibility，不代表兩個執行個體同時操作同一 running agent 的協調能力 |
| Actual LLM/auth/TUI/mobile | NOT TESTED | 未呼叫 actual LLM、未測 auth/password、native TUI/ConPTY、phone/Tailnet |
| Proxy/recovery lifecycle | NOT TESTED | 未測 browser SSE/WebSocket、proxy/subpath、parent exit、OMW restart 或 manager reclaim |

## 成功 Runtime Run

Evidence：

```text
.scratch/opencode-runtime-spike-df331df1c14646459a5c219058d31a4d/result.json
.scratch/opencode-runtime-spike-df331df1c14646459a5c219058d31a4d/progress.jsonl
```

執行命令與結果：

```powershell
.\scripts\opencode-runtime-spike.ps1 -OverallDeadlineSeconds 60
# exit 0
```

`result.json` 的 `status` 為 `passed`，elapsed `4228 ms`，installed version 為 `1.18.31`。兩個 instance 的驗證資料如下：

| Instance | PID | Port | Start time (UTC) | Health |
|---|---:|---:|---|---|
| instance-1 | 34308 | 56973 | `2026-09-17T05:48:20.5910572Z` | HTTP 200, healthy, `1.18.31` |
| instance-2 | 35392 | 56974 | `2026-09-17T05:48:21.7801584Z` | HTTP 200, healthy, `1.18.31` |

兩個 process 的 image 都是 `<absolute-opencode.exe>`。

### 隔離與 HTTP 證據

- sandbox project：`.scratch/opencode-runtime-spike-df331df1c14646459a5c219058d31a4d/project`
- isolated database：`.scratch/opencode-runtime-spike-df331df1c14646459a5c219058d31a4d/data/opencode.db`
- 兩個 `/path.directory` 都與上列 sandbox project 相符；因此用 `/path` 驗證 cwd，不把 worktree 回傳值誤當成 cwd。
- 兩個 `/project/current?directory=...` 都回傳 HTTP 200、`worktree: "/"`、`vcs: null`，符合空的 non-Git global project。
- `/` 回傳 HTTP 200、`Content-Type: text/html`、title `OpenCode`、HTML `2884` bytes。
- 找到並成功讀取本地 `/favicon-96x96-v3.png`，HTTP 200、`image/png`、`860` bytes。
- harness 沒有 follow redirect；`source_interpretation` 是 local OpenCode root 提供 UI。單靠 HTTP 不能區分 embedded UI bytes 與內部 upstream fallback，因此不把這項寫成完整 browser/UI 通過。

### Session 與 instance isolation

兩個 instance 使用同一個本次 run 的 isolated database root，而不是各自獨立資料庫。初始 `/session` count 兩端皆為 `0`；instance 1 建立不含 prompt、未觸發 LLM 的 empty session 後，instance 2 在 `378 ms` 內看見該 session，最後由 instance 2 delete 成功。

這證明的是「隔離資料庫內的 persistence/shared session visibility」。它不證明兩個同時執行的 agent 可以安全協調同一 session，也不證明 OMW 的 session lifecycle 已完成。

### Stop 與 cleanup

instance 1 停止結果：

```text
owner binding: Process.Start retained object and SafeHandle
metadata required for cleanup: false
handle retained: true
exited: true
port 56973 released: true
```

instance 1 停止後，instance 2 仍回應 health HTTP 200 且 `healthy: true`。finally cleanup 再停止 instance 2；success result 記錄兩個 process 均 `process_exited: true`、兩個 port 均 `port_released: true`，cleanup errors 為空。Evidence sandbox 保留，供事後查驗，不把 evidence files 與 process residue 混為一談。

## Failure Injection Run

Evidence：

```text
.scratch/opencode-runtime-spike-d5284fd98bf8442abbb309a70258374a/result.json
.scratch/opencode-runtime-spike-d5284fd98bf8442abbb309a70258374a/progress.jsonl
```

執行命令（注意參數間的空格）：

```powershell
.\scripts\opencode-runtime-spike.ps1 -InjectFailureAfterSecondStart -OverallDeadlineSeconds 60
# exit 1，預期在 secondStart 後、metadata 前注入失敗
```

注入點前 instance 1 已 ready；instance 2 的 `Process.Start` 已成功，但故意在 metadata/readiness 前 throw：

```text
instance-1: PID 24124, port 62303
instance-2: PID 36340, port 62304
error: Injected failure after instance-2 Process.Start succeeded, before metadata and readiness.
```

progress journal 具體記錄了兩次 `start-prepared`、兩次 `started`，以及 cleanup 對兩個 registered process 的 stop。兩個 process 均 `process_exited: true`、ports `62303`/`62304` 均 released、cleanup errors 為空；外部 CIM probe 找不到 PID `24124`/`36340`，兩個 ports 也沒有 listener。這是「start 後 metadata 尚未完成」failure window 的 cleanup 證據。

## Harness 修正與驗證意義

目前保存的 `scripts/opencode-runtime-spike.ps1` 包含下列與本次證據直接相關的保護：

- 在 `Process.Start` 前先把 instance entry 登記到 cleanup collection。
- 保留 `Process` object 與 `SafeHandle`；cleanup 使用原始 owned process，不用事後 PID/image metadata lookup 取代 ownership。
- child metadata（PID、start time、image path）採 best-effort；`MainModule.FileName` 讀取失敗不阻止 cleanup，並可 fallback 到 launch path。
- stdout/stderr 使用 bounded wait；progress 以 JSONL journal 記錄各階段與 child identity。
- 支援 `-InjectFailureAfterSecondStart`，並檢查兩個 instance 不得意外共用同一 PID。
- session JSON 使用 `ConvertFrom-Json -NoEnumerate`，且不在其外層套 `@(...)`，避免空 array 被 PowerShell pipeline/collection semantics 誤判成 count `1`。
- session URI 使用明確的 `${createdSessionId}` 插值，避免路徑拼接歧義。
- `/project/current` 的 `directory` 以 URL 傳入；cwd 以 `/path.directory` 對 sandbox project 驗證，接受合法的 non-Git/global project 回傳。

這個 harness 是 verification artifact，不是 OMW product code；本輪已修正 harness 並更新報告，沒有刪除任何舊 artifact。

## 中間與早期失敗紀錄

### Intermediate normal run：harness bug

Evidence：

```text
.scratch/opencode-runtime-spike-4ddbe5e9fdc143018cc192795f26b4d4/result.json
.scratch/opencode-runtime-spike-4ddbe5e9fdc143018cc192795f26b4d4/progress.jsonl
```

這次 run 已成功啟動兩個 `1.18.31` child、兩個 health ready，並完成 `/path` 與 `/project/current` 探測；失敗點是 session assertion：harness 把空 JSON array 錯判為 count `1`，因此報告的 error 是 `Isolated session storage was not empty before the test session was created.`。read-only database/session 檢查為 `0`，兩個 child 都已清理，ports 也已釋放。這是 harness bug，不是 OpenCode runtime failure；沒有刪除或弱化該 failing test，修正後由 success run 重跑。

### 原始直接 run：result.json 不足以代表完整 cleanup

Evidence：

```text
.scratch/opencode-runtime-spike-9addf96d384b4b5396e118ee420c9d1b/result.json
```

原始 script run 的 JSON 曾寫出 `allcleanup=true` 類似的成功清理訊號，但實際只登記了第一個 child；在 `MainModule.FileName` 讀取失敗時，第二個 PID `54620` 未被登記。因此這份 `result.json` 不能單獨作為「所有 child 都已清理」的證據。

後續由主 agent 核對 image、creation time、parent 與 arguments，並以 sandbox 的 `GET /path` 證實目標：.NET creation time 為 `2026-09-17T04:24:59.6427643Z`，CIM 對應值為 `2026-09-17T04:24:59.6427640Z`，parent PID 為 `54324`。取得 process handle 並再次核對後以 `Kill(true)` 停止；ports `58083`、`58084` 與 child `conhost` PID `4328` 均無殘留。這段歷史核查說明為何後續改成 retained `Process` ownership、best-effort metadata 與 pre-Start registration；不能把舊 JSON 的 `allcleanup=true` 當成可靠結論。

### 兩次 helper ACL pre-launch 失敗（歷史區）

早期使用 `<agent-skill-path>/Invoke-AgentProcessLifecycle.ps1` 的兩次 `Launch` 都在 process creation 前失敗：

1. 第一次被 `<sandbox>/logs` 的 artifact parent ACL 拒絕。
2. 第二次雖對本次新建 sandbox 的資料範圍收緊 ACL，仍在 `<user-temp>/opencode` 被拒絕；後續唯讀檢查另外發現 `<user-temp>` 與 `<user-profile>/AppData` 也不符合 helper 的檢查。`<user-profile>/AppData/Local` 本身通過檢查。

兩次都沒有建立 process；這些結果保留作為 lifecycle history，不再是目前的 runtime blocker。早期 sub-agent 未先取得確認便收緊新 sandbox 內 13 個物件的 ACL，屬於執行錯誤；那些物件仍保留，沒有擅自刪除或還原。既有 shared/temp/develop ancestor ACL 與全域 skill 沒有被修改。使用者授權該歷史 session 與子 session 忽略該 skill 後，續行測試沒有再修改 ACL，也不再以 helper 的 ACL gate 為驗證前提。

## 安裝、版本與靜態隔離設定

### CLI/package provenance

```text
Get-Command opencode
Source: <opencode-command-shim>
CommandType: ExternalScript
```

實際 executable：`<absolute-opencode.exe>`。

package metadata 與 binary fingerprint：

```text
Package: opencode-ai
Package version: 1.18.31
Package bin: ./bin/opencode.exe
Package metadata: <opencode-package>/package.json
Executable length: 179998248 bytes
Executable SHA-256: 0242A0DC705AF67C90882B456A36B619883C1C786AAD8FE071A1BC64E5D1D440
Embedded FileVersion/ProductVersion: 1.3.14
CLI reported version: 1.18.31
```

embedded file version 與 package/CLI version 不一致；判定 installed OpenCode 版本時以 CLI 與 npm package 的 `1.18.31` 為準，並保留 binary hash 供追溯。`opencode serve --help` 證實 `--hostname`、`--port`、`--pure`，預設 hostname 為 `127.0.0.1`；`attach` 也列出 `--dir`、`--continue`、`--session`、`--fork` 等 flags。本次沒有提供或讀取 server password。

### Child isolation

success run 的設定包含：

- `HOME`、`USERPROFILE`、`OPENCODE_TEST_HOME` 指向 sandbox home。
- `XDG_CONFIG_HOME`、`OPENCODE_CONFIG`、`OPENCODE_CONFIG_DIR` 指向 sandbox config。
- `XDG_DATA_HOME`、`XDG_CACHE_HOME`、`XDG_STATE_HOME` 與 absolute `OPENCODE_DB` 指向 sandbox。
- working directory 是空的 sandbox `project`；`OPENCODE_DISABLE_PROJECT_CONFIG=1`。
- `--pure`、`OPENCODE_PURE=1`、`OPENCODE_DISABLE_DEFAULT_PLUGINS=1`。
- external skills、Claude Code、model fetch、autoupdate、LSP download 與 prune 均停用。
- child 只比對 environment variable name 並移除 credential-like variables；不讀、不印 value，parent environment 不變。
- `OPENCODE_CONFIG_CONTENT`、`OPENCODE_PERMISSION`、`OPENCODE_SERVER_PASSWORD`、`OPENCODE_SERVER_USERNAME` 在 child environment 移除。

success result 記錄每個 child 移除 `4` 個 credential-like variable names，且 `credential_variable_values_read_or_printed: false`、`parent_environment_modified: false`、`path_modified: false`。

這些 runtime 結果已驗證本次 sandbox 的實際行為，但仍不等於所有 flags 的一般相容性保證，也不包含 credentials/auth flow 測試。上游 `dev` source 尚未 pin commit 且未與 installed `1.18.31` 對齊，source 只能作定位線索，不能覆蓋本機實測。

## Upstream source facts（僅待本機版本持續對照）

以下連結是 upstream `dev` 的線索，不是 installed `1.18.31` 的獨立證明：

- TUI 明示 `port`、`hostname` 或 `mdns` 時才建立 listener：https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/cli/cmd/tui.ts#L137-L177
- `serve`/`web` 使用 `Server.listen`；`web` 另外開啟 browser：https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/cli/cmd/serve.ts#L5-L19、https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/cli/cmd/web.ts#L18-L64
- UI 優先 embedded UI，fallback 代理至 `https://app.opencode.ai`：https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/server/shared/ui.ts#L9-L15、https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/server/shared/ui.ts#L59-L85
- `instance.dispose` 與 server shutdown 是不同 lifecycle；instance dispose 不等於 server shutdown：https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/server/routes/instance/httpapi/groups/instance.ts#L40-L48、https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/server/routes/instance/httpapi/lifecycle.ts#L9-L45
- `tui`/`select-session` 目前可確認是 TUI navigation；本次沒有把未找到的 current-session endpoint 證據寫成 endpoint 絕對不存在：https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/server/routes/instance/httpapi/groups/tui.ts#L134-L158

Subpath proxy 尚未實證；MVP 可先採每個 instance 一個 direct root，待 assets/API/SSE/WS 實測後再決定 proxy contract。

## 未測範圍與下一步

目前明確未測：

- actual LLM request、model credentials、server auth/password。
- native TUI、真 TTY/ConPTY、TUI attach 與 TUI share Web。
- 完整 browser JavaScript、SSE、PTY WebSocket 及錯誤重連。
- phone/mobile client、Tailnet/Tailscale、proxy/subpath routing。
- parent process detach/exit、OMW restart、crash recovery、manager reclaim。
- 同一 running agent/session 的跨 instance coordination；目前只有 persistence/shared session visibility。

要 finalize technology selection，仍需人工驗收 native TUI share Web 與 mobile flow，並測試 parent process detach/manager restart 後的 instance reclaim。這些完成前，結論應維持為「headless loopback runtime candidate 已通過受控 spike」，不是「OMW 全鏈路已驗證」。
