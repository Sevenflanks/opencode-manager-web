# OMW（OpenCode Manager Web）

OMW 是使用者透過手機管理本機 OpenCode 執行個體的個人工具。本詞彙表只收錄討論中已確認的領域名詞。

## Language

**Project（專案）**：
使用者執行 OpenCode 工作的本機專案目錄。同一個專案可以同時有多個執行個體。

**Directory Shortcut（目錄捷徑）**：
使用者在 OMW 設定、方便從手機選取專案目錄並啟動執行個體的目錄入口，可透過手機修改。它是操作捷徑，不是允許清單或目錄存取的權限邊界。
_Avoid_：以 Allowed Workspace Root 或允許範圍稱呼目錄捷徑。

**Instance（執行個體）**：
一次啟動後可供連線與操作的 OpenCode 執行環境。它不是某一段對話，也不是專案目錄本身。
_Avoid_：以 session 或專案代稱執行個體。

**Unreachable（失聯）**：
OMW 暫時無法確認 Instance 的 exact identity 或 health 的狀態；失聯不是已停止的證據。

**Stop tracking（停止追蹤）**：
停止在 OMW 預設清單追蹤某個 Instance 的操作，不代表 Stop process，也不代表刪除 OpenCode Session 或
Project files。

**Local TUI Instance（本機 TUI 執行個體）**：
使用者從本機終端啟動、以 TUI 操作的 OpenCode 執行個體；其生命週期遵循 OpenCode 原生行為，不要求在 TUI 關閉後繼續存活。

**Manager-launched Headless Instance（管理器啟動的背景執行個體）**：
由使用者透過 OMW 啟動、不附帶 TUI 的 OpenCode 背景執行個體。它不是關閉 TUI 後保留下來的本機 TUI 執行個體。

**Session（對話工作階段）**：
OpenCode 中的一段對話與工作紀錄。同一專案的多個執行個體可以看見相同 Session；看得見不代表該 Session 正在這個執行個體執行。

**Main Session（主 Session）**：
沒有父 Session 的對話工作階段，是 Session 階層的根節點；不是「目前選取」或「唯一正在執行」的意思。

**Primary Session Binding（主要 Session 綁定）**：
OMW 為個別 Instance 記住的主要 root Session 關聯。它是 Instance 與 Session 的操作關聯，
不是 Project 對 Session 的唯一所有權，也不是 Session 是否仍存在或正在執行的判定。
沒有足夠活動證據或明確選擇時可以沒有綁定；同一 Project 的其他 Instance 看見相同 Session，
不會因此改變這個 Instance 的綁定。

**Child Session（子 Session）**：
隸屬另一段 Session 的對話工作階段，也可以再有子 Session。原生 sub-agent 工作會使用這種父子關係，但父子關係本身不保證建立來源一定是 sub-agent。父 Session 尚未載入時，子 Session 仍不是主 Session。
