# OpenCode Parent Exit and TUI Spike

> 歷史歸檔：本報告記錄 2026-09-17、OpenCode `1.18.31` 的受控觀察，
> 不是現行 OMW 契約。本機絕對路徑已改為相對路徑或 placeholder。

日期：2026-09-17

目標環境：Windows 11 / PowerShell 7

性質：第二輪受控 spike，script 與 sandbox 是 verification artifact，非 OMW product code

## 摘要

**最新結論：使用者已確認 session 直達網址成功開啟，能看到同一 instance 的 TUI 送出的訊息；從 Web 送訊息也能取得回覆，TUI 與 Web 同時收到更新。** 本機原生 TUI／Web 同一段對話的讀取、Web 送出與即時呈現已獲人工驗證；先前首頁／目錄選擇器受阻不代表 session 無法共享。尚未驗證手機連線、權限互動或 TUI 當前 session 的自動定位。

### 後續人工驗收回報

使用者依本文的真實終端與桌面瀏覽器測試步驟回報：

| 項目 | 使用者觀察 |
|---|---|
| TUI 操作 | TUI 正常 |
| Web 載入 | Web 能正常載入 |
| 同一段 session 接續 | Web 找不到 TUI 正在使用的 session |
| TUI 退出後的 Web 連線 | Web 確實不可連線 |

這補上了自動 ConPTY capture 未能證明的人工 UI 觀察，但 **TUI／Web 同一段 session 接續尚未通過**，不可將整體接續能力標為成功。尚需確認該 session 是已存在的對話或尚未送出訊息的新畫面，以及 Web 當時選取的專案目錄。根因未確認，不把目前現象直接歸因於 OpenCode 不支援共享 session，也不據此改成兩個 server 的方案。

以下保留第二輪自動測試的歷史結果；其 `NOT VERIFIED` 指自動探測當時的證據範圍。

#### 人工驗收後續：Web 專案選擇器

使用者補充：TUI 是新 session，但已送出一則訊息才開 Web。Web 首頁專案清單空白；點「新增專案」並輸入 `<source-repo>`，選擇器只顯示上層目錄，無法選取目標。這是使用者觀察，不代表已判定後端沒有 session。

對使用者保持執行的 loopback server `127.0.0.1:51991` 做有限 GET 查核（未啟停 process、未讀取訊息內容或輸出對話標題）：

- `/path` 回傳 `directory=<source-repo>`、`worktree=/`。
- `/session?directory=<URL-encoded exact directory>` 回傳 21 筆 metadata，其中 2 筆為相同 directory 且無 parentID 的 session；最新建立時間為 `2026-09-17T07:00:30.610Z`。它是待人工核對的候選，不宣稱已取得 TUI 當前選取狀態。
- `/find/file?directory=<parent>&query=<repo-name>&type=directory&limit=50` 以 Windows 與 slash path 形式查詢皆回傳 4 筆，包括目標 repository。因此不是後端完全找不到目標目錄；尚未重現前端當下的精確 request，不能直接斷定 separator 或 UI bug 根因。
- 依官方 `v1.18.31` 前端 [route](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/app/src/app.tsx) 與 [base64url encode](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/core/src/util/encode.ts)，下一步以 `/<base64url(UTF-8 exact directory)>/session/<candidate ID>` 繞過 picker，由使用者確認是否呈現剛才的訊息。前端來源與本機提供的 assets 未做 binary 對應驗證；網址可用性與 session 身分仍待人工結果。

#### 直達網址人工驗收結果

使用者回報：「成功 直達網址有用 且可以看見我剛才在 TUI 送出的那則訊息」。本次候選 session 已由使用者確認為測試中的那段對話，因此 `/<base64url(UTF-8 exact directory)>/session/<session ID>` 的直達方式在本機提供的 Web 上確實可用。

此結果不代表「最新建立的 session」永遠等於 TUI 當前選取的 session；測試透過 metadata 選候選再由使用者核對，尚未實作或驗證可靠的自動定位機制。也不代表 Web 送訊息、雙向即時更新、權限操作或手機 Tailnet 路徑已驗收。目錄選擇器的根因仍未確認，OMW 可採原生直達入口避免此操作障礙，不需為此修改 OpenCode 或另開第二個 server。

#### Web 送訊息與即時更新人工驗收結果

前述直達測試後，使用者再依「從 Web 送一句訊息並觀察 TUI」步驟回報：Web 可送出並收到回覆，TUI 也能收到，且與 Web 同時收到。這是本機桌面瀏覽器與真實終端的人工驗收結果，不是 ConPTY 自動捕捉結果；無需切換 session 才能看見更新。先前各階段記載的未測範圍保留為歷史狀態，以本文件開頭的最新結論為準。

### 自動探測摘要

第二輪自動探測已完成；headless 父 process 正常退出測項通過，整體 TUI 驗收為 **PARTIAL**：

- headless child 在短生命週期 launcher 正常 exit 後，能由 fresh observer 以相同 process identity 探測並回應 loopback health/path。
- native CLI 以 ConPTY 啟動後，health/path/Web root 與 empty session API 檢查通過，resize API 回傳成功，且以最多兩次 Ctrl+C 完成 natural exit 與 cleanup。

這支持 Windows 原生 manager 管理 headless OpenCode process 的方向，也支持 TUI 與同一執行個體 HTTP endpoint 並存的可行性。這不是 OMW restart、machine reboot、launcher crash recovery 或 Node `spawn` 的證明；TUI 的可辨識畫面與 TUI 選取 session 仍未驗證。

## 結果總覽

| 測項 | 結果 | 證據摘要 |
|---|---|---|
| Parent 正常 exit 後 child 存活 | PASS | launcher 正常 exit code `0`；fresh observer 在 launcher exit 後啟動並成功探測 child |
| Child identity continuity | PASS | PID、creation time、executable、recorded parent PID matched；retained `Process` object 與 `SafeHandle` 可供 cleanup |
| Parent-exit child health/path | PASS | `/global/health` HTTP `200`、`healthy=true`、version `1.18.31`；`/path.directory` exact project match |
| Native CLI + ConPTY 啟動 | PASS, limited | process、loopback health/path、Web root 與 empty session API 檢查通過 |
| ConPTY resize API | PASS, limited | `120x35` → `100x30`，API success；resize 後 health 仍為 true |
| Recognizable TUI render | NOT VERIFIED | 等待 `10008 ms` 後 candidate non-control text 為空；不可把累計 PTY bytes 當成 render 或 redraw 證據 |
| Natural TUI exit | PASS, limited | Ctrl+C 最多兩次、每次策略受 bounded wait 約束；exit code `0`、`forced=false` |
| PTY/process/port cleanup | PASS | close/drain 完成；child PID absent、port 不再 LISTEN，無 process residue |
| TUI session selection endpoint | SKIPPED | 沒有把 optional endpoint contract 當成既定需求 |

## Evidence

### Parent exit run

主結果：

```text
.scratch/opencode-parent-exit-f9d08bdf83ef43ddb87b3fd8efccd765/result.json
```

Journal：

```text
.scratch/opencode-parent-exit-f9d08bdf83ef43ddb87b3fd8efccd765/journal/harness.jsonl
.scratch/opencode-parent-exit-f9d08bdf83ef43ddb87b3fd8efccd765/journal/launcher.jsonl
.scratch/opencode-parent-exit-f9d08bdf83ef43ddb87b3fd8efccd765/journal/observer.jsonl
```

執行命令與結果：

```powershell
pwsh -NoProfile -File .\scripts\opencode-parent-exit-spike.ps1 -OverallDeadlineSeconds 45
# exit 0
```

`result.json` 的 `status` 為 `passed`，overall elapsed 為 `3334 ms`。launcher PID `28540` 在 `2026-09-17T06:08:36.6944654Z` 以 exit code `0` 正常結束。child PID `36148` 的 creation time 為 `2026-09-17T06:08:35.7573254Z`，endpoint port 為 `58854`；fresh observer PID `12732` 在 `2026-09-17T06:08:37.2016272Z`、即 parent exit 後啟動。

observer journal 記錄 child 的 PID、creation time、executable 與 recorded parent PID 全部 matched，並以 endpoint health/path probe 通過。health 為 HTTP `200`、`healthy=true`、version `1.18.31`；path 為 HTTP `200`，`/path.directory` 與 sandbox project exact match。

cleanup 使用 retained exact `Process` object 與 `SafeHandle`，不是事後 metadata lookup 作為 cleanup authority。child finally stop 記錄 `exited=true`、exit code `-1`；這是預期的 forced 測試清理，不是 launcher abnormal exit。port `58854` released，external check 顯示 child PID absent 且 port unreachable。

handoff ACK 先確認 cleanup authority，再允許 launcher 正常退出；這是 test insurance，不能解讀為 OMW product architecture 或完整 manager reclaim 設計。

### TUI / ConPTY run

主結果：

```text
.scratch/opencode-tui-ba895ca15fa041059f443930fb7959e0/result.json
```

Journal：

```text
.scratch/opencode-tui-ba895ca15fa041059f443930fb7959e0/journal.jsonl
```

執行命令與結果：

```powershell
pwsh -NoProfile -File .\scripts\opencode-tui-spike.ps1 *> $null
# exit 0
```

`result.json` 的 `status` 為 `passed`，elapsed 為 `13495 ms`。native CLI child PID `46308` 使用 port `59922`，初始 size 為 `120x35`。health 為 HTTP `200`、`healthy=true`、version `1.18.31`；path probe exact match sandbox project；Web root 為 HTTP `200`、`text/html`。API 建立與讀取 empty session 通過，`prompt_sent=false`，因此本輪沒有 LLM request。

resize 從 `120x35` 到 `100x30` 的 `ResizePseudoConsole` API 回傳 success，resize 後 health 仍為 true。這只證明 API 呼叫與 endpoint 存活，不證明畫面正確重繪。

ConPTY trace 只有 `189` bytes，內容屬於 setup、空白、OSC title 與 restore 類控制輸出；`render-observation` 等待 `10008 ms` 後仍為 candidate empty/timeout。故不能宣稱 child TUI 畫面、resize redraw 或 TUI 互動已通過。其他工具曾顯示 UI 不足以作為 child 的獨立 capture 證據，本報告不記錄該輸出的 provider/model 或其他外部識別資訊。

退出策略是送出一次 Ctrl+C，等待 `2500 ms` 後必要時再送一次，最多等待 `5000 ms`。結果為 `natural-exit`、exit code `0`、`forced=false`。PTY close、output drain 均完成；累計 output `189` bytes 且未截斷。child PID absent，owned conhost 數量為 0，port `59922` 不再 LISTEN；僅餘 PID 0 的 TIME_WAIT 紀錄，不是存活 listener 或持有該 port 的 process。

本輪先清除 child inherited `OPENCODE*` 與 `OTUI*` 後再 explicit reset；移除的 variable name count 由 `4` 到 `7`，capture 結果沒有改變。因此不能確定 candidate empty 的原因，也不能據此宣稱所有 user config 情境都被隔離。child log 僅見 sandbox、session、model undefined 與無 startup error；本輪不把測試用 isolated home 推論成產品需求。

## 可支持的技術結論

- Windows 原生 manager 管理獨立 headless process 仍是可行方向；fresh observer 可在一次 parent normal exit 後辨識 child 並探測 endpoint。
- TUI 與同一執行個體的 HTTP health/path/Web/session API 可在本次受控 ConPTY run 中同時存活。
- retained process ownership 與 bounded cleanup 對測試安全有用；handoff ACK 是 test insurance，不是產品架構決策。
- 本輪不定案 TypeScript、framework 或其他實作技術，也不把 sandbox isolation 轉成每個 OMW instance 必須隔離使用者設定/資料的需求。

## 未解與未測範圍

- 沒有測 OMW restart、machine reboot、launcher crash、manager crash recovery、child reclaim 或 orphan recovery。
- 沒有測 Node `spawn`；本輪使用的 native launcher/ConPTY harness 不能代替 Node process semantics。
- 沒有證明 child TUI 的可辨識畫面、keyboard/ANSI 行為、resize redraw 或 TUI attach/share Web。
- `tui_select_session` endpoint 本輪 skipped；empty session API 的建立/讀取不等於 TUI 已選取該 session。
- 沒有測 browser JavaScript、SSE、WebSocket、phone/mobile、auth、Tailnet/Tailscale、proxy/subpath、plugins、skills 或 actual LLM。
- 沒有測同一 running agent/session 的跨 instance coordination；本輪只有有限的 endpoint/session API 證據。

## 下一步人工驗收

在不先改 Tailnet、也不新增 test framework 的前提下，使用真實 CMD 或 PowerShell 及桌面 browser 完成：

1. 執行 `opencode --hostname 127.0.0.1 --port <未佔用port>`，並記錄 CLI version、實際 port、啟動結果。
2. 以相同 loopback URL 開啟桌面 browser，驗證 TUI 原有選單與 Web/API 是否能正確互相對應；只記錄匿名化 UI 行為，不記錄 provider/model 或 credentials。
3. 實際調整 terminal size，確認可辨識畫面與 redraw，而非只看 resize API success。
4. 以 TUI 退出、session 接續與 browser 端觀察結果完成手動紀錄；手機驗收另列正式步驟。

這些人工結果完成前，整體結論維持為「headless loopback runtime 與部分 native TUI lifecycle 已通過受控 spike」，不是「OMW 全鏈路已驗證」。
