# OpenCode 1.18.31 status / pending requests 跨 Instance 邊界 spike

> 歷史歸檔：本報告記錄 2026-09-17、OpenCode `1.18.31` 的受控觀察，
> 不是現行 OMW 契約。`test-only-dummy` 是固定 fixture 字串，不是真實 credential。

日期：2026-09-17

## 結論

本 spike 以兩個相同 cwd、共用全新 scratch SQLite DB 的 headless OpenCode Instance 實測。

- session metadata 會經共用 DB 跨 Instance 可見：Instance A 建立的新 session，Instance B 的 `GET /session?directory=...` 可見。
- `/session/status` 是 Instance process 內狀態，不隨共用 DB 跨 Instance 可見：A 執行時回傳 `{ "type": "busy" }`，同時 B 對同一 session 無 status entry。
- 新 session 的 status entry 在 A、B 都不存在；不能把「不存在」解讀為一個明示的 idle enum 值。
- busy 結束後，A 的 status map entry 消失；最多 4 秒的 polling 沒有觀察到明示 `{ "type": "idle" }`。
- `/question` 是獨立的 pending request array，不是 `/session/status` enum：question pending 時 A 為 1 筆、B 為 0 筆；同時 A status 仍是 `busy`，B 無 status entry。
- `/permission` 也是 Instance process 內的獨立 pending array：read permission pending 時 A 為 1 筆、B 為 0 筆；A status 是 `busy`、B 無 status entry，reject response 為 `true`。
- abort response、abort 後 idle/absence、`retry` status：**NOT VERIFIED**。唯一針對性重跑在 permission reject 後錯誤等待 provider follow-up，未進入 abort 階段。

因此 OMW 若管理多個 Instance，不能只靠共用 session DB 推導任一 Instance 的執行狀態或 pending request；需要向擁有該執行中的 Instance 查詢其 `/session/status`、`/permission`、`/question`。

## 範圍與隔離

- OpenCode：`1.18.31`，由兩個 `/global/health` response 分別確認。
- Node：本機既有 Node 24；沒有安裝 npm dependency。
- Instance：兩個 `opencode.exe serve --hostname 127.0.0.1 --port <ephemeral> --pure --log-level INFO` child process。
- cwd：兩個 Instance 都使用同一個新建 fixture project directory。
- DB：兩個 Instance 共用同一個新建 `OPENCODE_DB`。
- config：只使用 scratch `OPENCODE_CONFIG` / `OPENCODE_CONFIG_DIR`。
- HOME、`USERPROFILE`、`OPENCODE_TEST_HOME`、XDG config/data/cache/state 全部指向該 run 的 scratch directory。
- 啟動前依環境變數名稱清除 `OPENCODE*`、`OTUI*` 與常見 credential names；未讀取或記錄其值。最新 run 共移除 7 個名稱。
- mock provider 只綁定 `127.0.0.1`，只回固定 fixture data；`model` 與 `small_model` 都固定為 `localmock/mock`。
- 沒有連線真實 provider、使用真實 LLM、真實 credentials 或 production data。
- 沒有修改 parent environment、PATH、ACL、Firewall、Tailscale、既有 harness、原型或全域 config。
- 每個 HTTP request timeout 4 秒；每次 run 總 deadline 120 秒；stdout/stderr 各最多保留 64 KiB。

custom provider 採官方文件格式：

```json
{
  "model": "localmock/mock",
  "small_model": "localmock/mock",
  "provider": {
    "localmock": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://127.0.0.1:<ephemeral>/v1",
        "apiKey": "test-only-dummy"
      },
      "models": {
        "mock": {
          "limit": { "context": 32768, "output": 2048 },
          "tool_call": true
        }
      }
    }
  }
}
```

`read` 在 run-local config 設為 `ask`；其餘可寫入或執行命令的工具設為 `deny` 或在 prompt payload 停用。mock 只要求讀取 scratch project 內的 `fixture.txt`，而 permission 若出現只允許以 `reject` 回覆，不會執行實際讀取。

## 實測 matrix

針對性重跑 `e8bfc2adb6534147b1a8d5feeedd88a9` 的 response 摘要如下。busy、question、permission、abort 各自使用一個新 session，避免 history 互相污染。所有 ID、路徑、文字均為本次新建 fixture；表格不含 credential value。

| 階段 | Instance A | Instance B | 結果 |
|---|---|---|---|
| Fresh session list | `[]` | `[]` | 兩邊已實測 |
| Fresh status map | `{}` | `{}` | 兩邊已實測 |
| Fresh permission list | `[]` | `[]` | 兩邊已實測 |
| Fresh question list | `[]` | `[]` | 兩邊已實測 |
| A 建立四個 scenario sessions | 每個 metadata 可見；status absent | 每個 metadata 可見；status absent | metadata 跨 Instance，共用 DB |
| A 執行 held completion | status `{type:"busy"}`；permission/question 都是 0 | 同 session status absent；metadata 仍可見 | busy 不跨 Instance |
| A completion release | polling 看到 `busy` 後 entry absent | 未要求 B 執行 | 明示 idle 未觀察到 |
| A question pending | pending 1；status `{type:"busy"}` | pending 0；status absent；metadata 可見 | question 與 status 分離，且 pending 不跨 Instance |
| A question reply | `{answers:[["fixed-answer"]]}`；response `true`；pending 清為 0 | 不 reply | reply schema 與 settlement 已實測 |
| A read permission pending | pending 1；status `{type:"busy"}`；permission=`read` | pending 0；status absent；metadata 可見 | permission 與 status 分離，且 pending 不跨 Instance |
| A permission reject | `{reply:"reject"}`；response `true`；pending 清為 0 | 不 reply | 已實測，fixture 未被實際讀取 |
| A abort / abort 後 status | 未到此階段 | 未到此階段 | **NOT VERIFIED** |
| retry | 未刻意製造 | 未刻意製造 | **NOT VERIFIED** |

active response shape 的 top-level keys 為：

```text
id, questions, sessionID, tool
permission: always, id, metadata, patterns, permission, sessionID, tool
```

mock provider 從 OpenCode 實際 request 看到的 tool schemas：

```text
question: required=[questions], properties=[questions]
read: required=[filePath], properties=[filePath, limit, offset]
```

## 執行與失敗邊界

執行命令：

```powershell
node --check "scripts/opencode-status-spike.mjs"
node --check "scripts/opencode-status-mock-provider.mjs"
node "scripts/opencode-status-spike.mjs"
```

兩個 syntax check 都通過。

第一次 run：

```text
.scratch/opencode-status-1c4c4b3b670f4d0a84a2fe498a4fc1cc/result.json
```

- 已完成 fresh、metadata、busy 與 question 階段。
- question pending 清空後立刻送出下一個 prompt，permission phase event 在 10 秒內未出現。

第二次 run：

```text
.scratch/opencode-status-bed42096b3db40f7bbcdf2f680e37c8d/result.json
```

- 同樣完成 fresh、metadata、busy 與 question 階段。
- mock provider 實際收到 1 次 busy request、1 次 question tool-call request、2 次帶 question tool-result 的 follow-up request。
- 後續檢查確認不是 OpenCode 沒推進：mock 的 `hasToolResult()` 與 scenario classifier 都掃完整 history，且 scenario 判定以 question 優先；同一 session 的 permission prompt因此被錯判為 question follow-up。

依新證據授權的唯一針對性重跑：

```text
.scratch/opencode-status-e8bfc2adb6534147b1a8d5feeedd88a9/result.json
```

- busy、question、permission、abort 改為四個獨立新 session；四者的 metadata 都由 A/B 看見，建立後 A/B status entry 都 absent。
- fresh A/B 的 session/status/permission/question 都各自取樣為空。
- permission prompt 正確分類為 `scenario=permission`、`phase=permission`、`follow_up=false`，證實前兩次失敗是 mock history 分類污染，不是 OpenCode prompt 收尾問題。
- read permission 在 A pending=1、B pending=0；A status=`busy`、B status absent、B metadata 可見；request 的 `permission` 欄位是 `read`。
- `POST /permission/:id/reply` 使用 `{reply:"reject"}` 回傳 `true`，之後 A pending 清為 0。
- run 隨後等待 permission rejection 的 provider follow-up；10 秒內沒有該 event，因此在 abort 前結束。這是 harness 不成立的 gate，不作為 OpenCode failure 證據。該 gate已從腳本移除，但依單次重跑上限沒有再次執行，abort 仍為 **NOT VERIFIED**。
- `retry` 沒有刻意製造，仍為 **NOT VERIFIED**。

## Cleanup 證據

三次 run 都在 `finally` 以 spawn 後立即登記的 retained child handles 停止自有 process，再關閉 retained mock server；沒有使用 PID 掃描進行 cleanup。最新腳本另以 child `error` listener 保存 launch failure，不讓 spawn error 成為未捕捉事件。

- 第一次：PID `60376`、`55016` 已退出；ports `54114`、`54115`、`54116` 已釋放。
- 第二次：PID `39024`、`61096` 已退出；ports `51681`、`51682`、`51683` 已釋放。
- 針對性重跑：PID `61512`、`11800` 已退出；ports `49841`、`49842`、`49843` 已釋放；`launch_error=null`。
- 六個 child 的 stdout 都只有 119 bytes、未截斷；stderr 0 bytes。
- harness 內 TCP connect check：九個 ports 全部 `reachable=false`。
- 最新 run 的 harness 外部 PowerShell 查核：`LiveOwnedPids=[]`、`ListeningSockets=[]`。

外部查核命令：

```powershell
$ids = @(61512,11800)
$ports = @(49841,49842,49843)
Get-Process -Id $ids -ErrorAction SilentlyContinue
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalPort -in $ports }
```

scratch directories 保留作為此次 fixture evidence；內容只有測試 config、fixture、隔離 DB 與 `result.json`。

## 產物

- `scripts/opencode-status-spike.mjs`：單一 bounded harness，擁有兩個 Instance child 與 provider cleanup。
- `scripts/opencode-status-mock-provider.mjs`：Node built-in HTTP 固定 response provider，依實際 tools schema組固定 tool calls。
- `.scratch/opencode-status-1c4c4b3b670f4d0a84a2fe498a4fc1cc/`：第一次 partial run evidence。
- `.scratch/opencode-status-bed42096b3db40f7bbcdf2f680e37c8d/`：第二次 partial run evidence，保留原始誤分類證據。
- `.scratch/opencode-status-e8bfc2adb6534147b1a8d5feeedd88a9/`：獨立 scenario sessions 的針對性重跑 evidence。
