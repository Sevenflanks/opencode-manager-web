# Phase-1 歷史研究歸檔

本目錄保存原 clone 中未受 Git 追蹤的 phase-1 研究證據。來源盤點與逐項處置見
[`../../project-inventory.md`](../../project-inventory.md)。

## 使用方式

- 這些檔案是特定 OpenCode 版本、Windows 環境與日期下的歷史觀察，不是現行產品契約。
- `NOT VERIFIED`、`UNKNOWN`、`PARTIAL` 與未完成 checklist 仍表示未確認；不得據此推導目前
  版本已支援或不支援某項行為。
- 現行操作與安全邊界以 [`../../../README.md`](../../../README.md)、
  [`../../development.md`](../../development.md) 及 [`../../security/`](../../security/) 為準。
- 引用歷史結論前，先核對當前 OpenCode/OMW 版本、source 與可重現證據。

## 保存與去識別化

- `research/` 保存四篇 runtime、parent/TUI、status 與 session-tree spike 報告。
- `OMW_PROJECT_HANDOFF.md` 保存早期 handoff；其中設計草案可能已被現行實作取代。
- 本機 repository、scratch、executable 與使用者 profile 絕對路徑改為相對路徑或
  `<...>` placeholder。
- 公共 upstream URL、觀察版本、run-relative artifact 名稱、測試 fixture 與結果數值保留。
- `prototypes/console/package-lock.json` 經敏感資訊、private registry 與本機絕對路徑掃描後原樣保存，
  用於重現當時的 dependency resolution；不表示依賴已重新安裝或驗證。
- 未保存 `.scratch/` artifacts、credentials、runtime configuration、`node_modules/` 或 `dist/`。

對應的研究 source 保存在 repository root 的 `scripts/` 與 `prototypes/console/`；只應在隔離環境中
依其明示參數使用，本輪未執行這些 scripts。
