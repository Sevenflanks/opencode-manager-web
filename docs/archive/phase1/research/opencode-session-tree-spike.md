# OpenCode 1.18.31 session tree spike

> 歷史歸檔：本報告記錄 2026-09-17、OpenCode `1.18.31` 的受控觀察，
> 不是現行 OMW 契約。本機絕對路徑已改為相對路徑。

日期：2026-09-17

性質：單一 loopback headless server 的受控 API capability spike，不是 OMW product code。

## 目標

實測已安裝的 OpenCode `1.18.31` 是否能以 session API 建立並讀取下列結構：

```text
rootA
└─ childA
   └─ grandchild
rootB
```

驗證範圍是：

- `GET /session?directory=...` 是否包含四筆 metadata。
- `GET /session?roots=true&directory=...` 是否只包含 `rootA`、`rootB`。
- `GET /session/:id/children?directory=...` 是否只回傳 direct children。
- `rootA` 的 children 不應包含 `grandchild`。
- `childA` 的 children 應包含 `grandchild`。
- `grandchild` 的 children 應為空。

## Harness 與隔離

執行器是新建的 `scripts/opencode-session-tree-spike.mjs`，參考既有 `scripts/opencode-status-spike.mjs` 的 Node built-in、精確 executable、isolated environment、bounded stdio 與 retained child cleanup 慣例，但沒有複製既有 script，也沒有修改它。

- 只啟動一個 `opencode.exe serve --hostname 127.0.0.1 --port <ephemeral> --pure --log-level INFO`。
- 使用全新的 fixture project、SQLite DB 與空 `opencode.json`；config 不含 provider、model 或 prompt 設定。
- `HOME`、`USERPROFILE`、`OPENCODE_TEST_HOME`、`XDG_CONFIG_HOME`、`XDG_DATA_HOME`、`XDG_CACHE_HOME`、`XDG_STATE_HOME` 全部指向 run-local scratch。
- 啟動前不讀取 credential value，依名稱清除 `OPENCODE*`、`OTUI*` 與常見 credential environment，再加入 pure、plugin/default-plugin、external skills、model fetch、autoupdate、LSP download 等 disable flags。
- 不啟動 mock provider，不送 prompt，不接觸真實 provider、LLM、credentials 或 production data。
- overall deadline 是 60 秒；每個 HTTP request 是 3 秒；health wait 是 10 秒。
- child 在 `spawn` 後立即 register 到 owned list 並掛 `error` listener；stdout/stderr 各 bounded 到 64 KiB。
- `finally` 只停止本 harness 自己保留的 child handle，等待 exit，再做 loopback port check；不使用 `taskkill`、process-name kill 或 user-instance 掃描。
- API 沒有使用 delete；測試 DB 與 fixture scratch 保留作 evidence。

## 關係語意界線

本 spike 直接以 session API payload 的 `parentID` 建立 `rootA -> childA -> grandchild`，因此證明的是 **parentID 結構與 children API 的行為**。它不是 native agent provenance 證據：沒有透過 agent dispatch 建立任何 session。官方 task creation 的 parent context 與 `fork` 本次均未實測。

## 執行

```powershell
node --check "scripts/opencode-session-tree-spike.mjs"
node "scripts/opencode-session-tree-spike.mjs"
```

預期產物：

```text
.scratch/opencode-session-tree-${runId}/result.json
```

`result.json` 會保留實際 health version、session create response、metadata、roots response、三次 children response、fixture IDs、隔離設定摘要，以及 cleanup 的 PID/port evidence。credential value 不會寫入 artifact。

歷史 artifact（初版固定目錄實測，僅保留、不再使用或覆寫）：

```text
.scratch/opencode-session-tree-unique/result.json
```

其 run ID 是 `ab186a08b9cc4513b82dbd090233cdb9`，標記為 historical；後續每次執行都使用 `runId` 產生新的 sandbox 與 DB。

## 實測結果

最新 fresh run 實測通過，執行時間 `4418 ms`，OpenCode health 回報版本 `1.18.31`。

- run ID：`dadc4560e6474720b7f83a7ca3419341`
- isolated project：`.scratch/opencode-session-tree-dadc4560e6474720b7f83a7ca3419341/project`
- isolated DB：`.scratch/opencode-session-tree-dadc4560e6474720b7f83a7ca3419341/data/opencode.db`
- server PID：`14812`
- loopback port：`56580`
- removed sensitive variable names：`7`；credential values 未讀取或寫入 artifact。
- 初始 `GET /session`：`[]`。
- metadata：`4` 筆。
- `GET /session?roots=true`：`2` 筆，只含 `rootA`、`rootB`。
- `GET /session/:rootA/children`：`1` 筆，只含 `childA`，不含 `grandchild`。
- `GET /session/:childA/children`：`1` 筆，含 `grandchild`。
- `GET /session/:grandchild/children`：`[]`。

實際 metadata parent edges：

```text
childA ses_f512c2a6fffeblg2BXEWgmJZkC
  parentID = ses_f512c2a91ffetRPRFDekejM7Is (rootA)
grandchild ses_f512c2a63ffe5TU2hJSPk1o8B0
  parentID = ses_f512c2a6fffeblg2BXEWgmJZkC (childA)
```

完整 raw response、fixture create response、session IDs 與 isolation/cleanup summary 保留於 `.scratch/opencode-session-tree-dadc4560e6474720b7f83a7ca3419341/result.json`。

## Cleanup 查核

Harness 內會記錄：

- owned child PID 是否已 exit。
- child stdout/stderr bytes 與是否截斷。
- loopback port 是否仍 reachable。
- `taskkill_used=false`、`process_scan_used=false`、`delete_api_used=false`。

Harness 外另以精確 PID/port 做一次 read-only 查核；不掃描或處理其他 user instance：

```powershell
$process = @(Get-Process -Id 14812 -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ Id = $_.Id; ProcessName = $_.ProcessName } }); $listeners = @(Get-NetTCPConnection -LocalPort 56580 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ LocalAddress = $_.LocalAddress; LocalPort = $_.LocalPort; OwningProcess = $_.OwningProcess } }); [pscustomobject]@{ owned_pid = 14812; process_rows = $process; port = 56580; listen_rows = $listeners } | ConvertTo-Json -Compress
```

實際輸出：

```json
{"owned_pid":14812,"process_rows":[],"port":56580,"listen_rows":[]}
```

Harness cleanup 與外部查核均確認 child 已 exit、port 已釋放；cleanup 無 error。DB 未刪除，作為 evidence 保留。

## 產物

- `scripts/opencode-session-tree-spike.mjs`：單同步 Node harness。
- `.scratch/opencode-session-tree-dadc4560e6474720b7f83a7ca3419341/result.json`：最新 fresh run 的 session tree API response、隔離摘要與 cleanup evidence。
- `.scratch/opencode-session-tree-unique/result.json`：historical 初版 evidence，保留但不再作為最新結果。
