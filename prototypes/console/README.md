# OMW Console Prototype

以假資料製作的 Vue 3 + TypeScript + Vite + shadcn-vue 高密度控制台。這是資訊架構 prototype，不是正式 OMW 前端；框架尚未連接 Node / Fastify / SQLite backend。

> [!IMPORTANT]
> 此目錄是 phase-1 歷史 prototype source 的 sanitized snapshot，不是現行產品契約。正式行為以 repository root 的 `README.md` 與 `docs/` 為準。

## 已選方案 A

目前只保留方案 A「執行個體清單 / 綜合詳情」作為主要版型。方案 B、C 的既有歷史截圖保留作為比較紀錄，但其 UI 與 source 已移除；`?variant=B`、`?variant=C` 不再切換版型，頁面仍顯示 A。

這次收斂只校正 prototype 的資訊名稱、狀態語意與 responsive 呈現，不代表將 prototype promote 成 production，也不制定正式前後端架構。

## 資訊來源

| 資訊 | 來源與目前證據 | Prototype 呈現 |
|---|---|---|
| Instance 名稱、來源、生命週期、PID、port | 預期由 OMW 紀錄與管理；本頁只有 fixture | 專案名加 short id；`running / stopped / unknown` |
| Health、endpoint、project path | `/global/health`、Instance endpoint 與 directory query 已實測 | `online / unreachable / stopped`、最後成功 Health 與最近嘗試 |
| 此專案的 Sessions | 同 project 共用 DB 的 Session metadata 跨 Instance 可見已實測；`parentID` 可描述已載入 Session 間的 parent chain | 依 project 去重，以「主 Session / 子 Session N」逐層展開；不宣稱由某 Instance 擁有 |
| 工作摘要 | `/session/status`、`/question`、`/permission` 均已實測為 Instance process 內資料 | 各 Session 顯示「此 instance 回報」，並依 Instance endpoint + project directory 聚合三個非互斥 count |
| 無 status entry | 新 API poll 成功但回傳空 map 已實測 | 顯示「未回報執行中」，不顯示「idle / 閒置」 |
| 查詢失敗或 endpoint 失聯 | 與成功空 map 是不同來源狀態 | 顯示「未知」，不自動算入待處理 |
| Pending settlement | question reply、permission reject 成功清除 pending 已實測 | 本頁不提供 reply / reject 功能，只模擬摘要變化 |
| `retry`、`abort`、TUI current session | 尚未驗證 | 不宣稱支援，也不從 Session 清單推導 |

詳細歷史實測結論見 `../../docs/archive/phase1/research/opencode-status-spike.md`。

## Fixture 情境

- `busyCount`、`questionCount`、`permissionCount` 是三個非互斥 count；fixture 包含 busy 與 question、busy 與 permission 同時存在，也包含兩個 busy。
- 成功取得空 status map 顯示「未回報執行中」；pending 部分查詢失敗時，整體摘要顯示「未知」。
- 至少一筆 fixture 為 `lifecycle=unknown`、`connection=unreachable`，避免把 health failure 解讀成 crashed。
- Session title 與時間可作為假資料展示，但時間標示為「Session 更新」，不是 Instance 活動時間。
- 預設 project fixture 有兩個 root、一組 child / grandchild，以及一組 parent 尚未載入但仍保留 child 與 `parentID` 的案例；同 project 的多個 Instance 共用相同 Session IDs，不跨 project 串接。
- `ins-7f2a` 在 child 同時回報 busy + question；`ins-15bc` 則由不同 root 分別回報 busy 與 permission，展示相同 Session tree 在不同 Instance endpoint 下可有不同觀察值。
- 「管理器觀察事件」只列啟動、登錄、Health 成功或失敗、主動停止，不模擬模型進度或工具 timeline。

## Session parent 模型限制

- 只讀 Session metadata 的 `parentID` 建立樹，不用 title 猜關係。沒有 `parentID` 才顯示為「主 Session」。
- 有 `parentID` 但 parent 不在目前資料時，Session 保留在「父 Session 尚未載入」區域，並顯示原 `parentID`；其已載入 children 仍可逐層展開。
- child count 明確標示為「已載入直接子 Session」。正式 API 的分頁與 ancestor 載入策略尚未確定，因此 prototype 不宣稱這是全量 children 或完整祖先鏈。
- root 也可能來自一般 fork；雖然 OpenCode task 的 source 已查到使用 parent chain，fixture 不是 agent spawn 的行為證明，不能因為存在 `parentID` 就把 Session 稱為 agent spawn。

## 互動限制

- 所有頁面內容與時間都是 fixture。
- 搜尋涵蓋 project 名稱與 path、Instance id、Session title 與 id；目前是 project-level 命中，不會自動展開或只截出命中的 ancestor path。
- 篩選包含「全部 / 有執行中 / 需處理 / 無法連線」；busy 同時有 pending 時仍會出現在「有執行中」。
- 「模擬摘要變更」只修改記憶體 fixture，依序示意 known busy、busy + question、清空後無回報、兩個 busy，亦可示意恢復連線；它不是 permission 回覆功能。
- `Open Web` 只顯示 Dialog，不會開啟網址。
- `Stop` 只出現在 OMW 擁有且 running 的 manager-launched headless Instance；確認後只修改記憶體，摘要變成「不適用」，不會終止程序。
- `重設` 只重建記憶體 fixture。頁面不呼叫 API、不使用 storage、不讀寫檔案系統，也不做 process 或 production mutation。

## 執行與驗證

此 snapshot 保存原本的 `package-lock.json`，供重現當時的 dependency resolution；它仍只供研究與閱讀，不代表依賴已重新驗證。保存工作未執行下列指令：

```powershell
npm run dev
npm run build
```

開發伺服器設定為 `http://127.0.0.1:5173` 與 `strictPort`。`npm run build` 會先執行 `vue-tsc --noEmit` 再執行 Vite production build。這些 dummy 互動沒有外部副作用。

## UI 元件來源

`src/components/ui/` 的 Button、Badge、Input、Dialog 由官方 `shadcn-vue` CLI registry 產生，再套用本 prototype 的石墨色設計 tokens。Dialog 的關閉圖示使用 `lucide-vue-next`，全站維持同一 icon family。
