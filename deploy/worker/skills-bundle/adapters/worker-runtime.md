## Linux Worker 執行邊界

此段是有版本與 preimage hash 的 Linux 適配；以下原始規則、資源及範例仍保留。

- 技能路徑以本次 loader 回傳的 skill directory 為準。相對 `scripts/`、`references/`、`templates/` 由該目錄解析；Python helper 使用 `python3 <skill-directory>/scripts/<helper>.py`，不依賴可執行位元。
- Windows / PowerShell 範例只適用該平台，不在 Linux 原樣執行。沒有經核實的 Linux 等價操作時，回報 unavailable 與缺少的能力，不宣稱已執行。
- 主機安裝路徑、主機日誌、主機歷史與 session-memory 均不是必要前提；只使用本 session 明確可用的工具與 Worker workspace 證據。無 memory tool 時略過回憶步驟並說明證據缺口；不得自行尋找或讀取宿主機技能、登入資料或歷史。
- Manager/heartbeat 是部署執行環境責任，不由技能建立 background heartbeat、內部控制連線或依賴 OMO_INTERNAL 狀態。
- 若 upstream 提及未納入的 agent-process-lifecycle 或 self-challenge，不能下載或 re-add。Linux process 只用基本契約：每次啟動有 timeout、session-owned cwd/output 與明確 exit status；不啟動未有 owner/stop 契約的 background process；卡住回報該次 PID/timeout 並清理自己擁有的程序，不終止其他 session。缺少工具能力時回報 unavailable，不以同名 wrapper 冒充技能。
- 不由技能安裝另一個技能或服務登入設定。被引用技能須先確認本次 registry 中存在；缺少必要技能時回報其名稱及受影響步驟，不偷偷替換或假裝完成。可選步驟才能註明略過。
- Jenkins、Kibana、Kubernetes、Mantis、ERP、GitHub 與外部文件服務的可用性及授權初始均是 unknown。只在需求需要且 session 已有合法 runtime 設定時使用；缺少能力時回報 unavailable。bundle 不攜帶 credentials，不從 host 匯入，不把範例設定當成已登入設定。
- 需要寫入設定、發佈、commit、push、review 或 merge 時仍遵守使用者當次授權及原技能的前置條件。準備 bundle 本身不會執行任何 upstream helper。
