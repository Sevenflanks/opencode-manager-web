# OMW MVP 工作計畫

> 狀態：8 張 child ticket 已發布；GitHub Issues 是正式權威。本檔僅保留已發布票的索引與依賴，不維護 state checkbox，也不取代 GitHub 的即時 state、labels、comments 或 dependencies。
> Parent： [GitHub Issue #1](https://github.com/Sevenflanks/opencode-manager-web/issues/1)

## 已發布工作票

| Ticket | GitHub issue | 類型 | 前置票 |
|---|---|---|---|
| T1 | [#2 Loopback 最小管理閉環](https://github.com/Sevenflanks/opencode-manager-web/issues/2) | 垂直切片 | 無；frontier |
| T2 | [#3 目錄捷徑、瀏覽與持久化](https://github.com/Sevenflanks/opencode-manager-web/issues/3) | 垂直切片 | [#2](https://github.com/Sevenflanks/opencode-manager-web/issues/2) |
| T3 | [#4 主／子 Session 樹與精準開啟](https://github.com/Sevenflanks/opencode-manager-web/issues/4) | 垂直切片 | [#2](https://github.com/Sevenflanks/opencode-manager-web/issues/2) |
| T4 | [#5 Instance 工作摘要、搜尋與篩選](https://github.com/Sevenflanks/opencode-manager-web/issues/5) | 垂直切片 | [#2](https://github.com/Sevenflanks/opencode-manager-web/issues/2) |
| T5 | [#6 Manager 重啟恢復與安全辨識](https://github.com/Sevenflanks/opencode-manager-web/issues/6) | 垂直切片 | [#2](https://github.com/Sevenflanks/opencode-manager-web/issues/2) |
| T6 | [#7 Local TUI 登錄、透傳與 fail-open](https://github.com/Sevenflanks/opencode-manager-web/issues/7) | 垂直切片 | [#2](https://github.com/Sevenflanks/opencode-manager-web/issues/2) |
| T7 | [#8 Tailnet 入口與安全方案決策](https://github.com/Sevenflanks/opencode-manager-web/issues/8) | 決策票 + loopback PoC | 無；frontier |
| T8 | [#9 核准方案部署與真手機端到端驗收](https://github.com/Sevenflanks/opencode-manager-web/issues/9) | 整合驗收 | [#3](https://github.com/Sevenflanks/opencode-manager-web/issues/3)、[#4](https://github.com/Sevenflanks/opencode-manager-web/issues/4)、[#5](https://github.com/Sevenflanks/opencode-manager-web/issues/5)、[#6](https://github.com/Sevenflanks/opencode-manager-web/issues/6)、[#7](https://github.com/Sevenflanks/opencode-manager-web/issues/7)、[#8](https://github.com/Sevenflanks/opencode-manager-web/issues/8) |

## 依賴 frontier

- 兩個無前置票的 frontier 是 [#2](https://github.com/Sevenflanks/opencode-manager-web/issues/2) 與 [#8](https://github.com/Sevenflanks/opencode-manager-web/issues/8)。
- [#3](https://github.com/Sevenflanks/opencode-manager-web/issues/3)、[#4](https://github.com/Sevenflanks/opencode-manager-web/issues/4)、[#5](https://github.com/Sevenflanks/opencode-manager-web/issues/5)、[#6](https://github.com/Sevenflanks/opencode-manager-web/issues/6)、[#7](https://github.com/Sevenflanks/opencode-manager-web/issues/7) 依賴 [#2](https://github.com/Sevenflanks/opencode-manager-web/issues/2)，可彼此平行。
- [#9](https://github.com/Sevenflanks/opencode-manager-web/issues/9) 依賴 [#3](https://github.com/Sevenflanks/opencode-manager-web/issues/3) 至 [#8](https://github.com/Sevenflanks/opencode-manager-web/issues/8)，且需要使用者核准方案及明確外部配置授權。

## 權威與範圍

- 正式票務 body、state、labels、comments 與 native dependencies 只能由 GitHub Issues 即時讀取；本索引不可宣稱票務狀態始終為 `OPEN` 或 `ready-for-agent`。
- 本機探索產物不隨 repository 發布；需求與驗收條件以各 GitHub issue 為準。
- 執行依本次使用者授權與各票安全邊界處理；此索引本身不構成額外授權。
