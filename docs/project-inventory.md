# 專案文件與研究物件盤點

本文件記錄 phase-1 整理後的保存邊界，不是現行技術契約。所有路徑皆為 repository
相對路徑；原 clone 的來源檔案維持原狀，未刪除或修改。

## 判讀原則

- 現行操作、API 與安全契約以 `README.md`、`docs/development.md` 與
  `docs/security/` 為準。
- `docs/archive/phase1/` 保留特定日期、版本與環境下的歷史觀察；其中
  `NOT VERIFIED`、`UNKNOWN`、`PARTIAL` 與未完成 checklist 均維持原意。
- spike scripts 與 prototype 是可追溯的研究 source，不是 production code，也不代表其
  行為已納入產品。
- 歸檔副本移除本機絕對路徑與使用者識別資訊；公共 upstream URL、版本、fixture 值及
  觀察結果保留。

## 現行文件

下列 tracked 文件維持原路徑，沒有因本輪歸檔而改寫契約：

- `README.md`
- `CONTEXT.md`
- `docs/development.md`
- `docs/security/launcher-contract.md`
- `docs/security/tailnet-access.md`
- `docs/security/mobile-acceptance.md`
- `docs/specs/omw-mvp.md`
- `docs/specs/omw-mvp-work-plan.md`

## 已保存的歷史資料

原 clone（以下記為 `<source-clone>`）本輪只讀。保存副本：

| 原始狀態 | 原相對路徑 | 保存位置 | 處置 |
|---|---|---|---|
| ignored | `docs/research/opencode-runtime-spike.md` | `docs/archive/phase1/research/opencode-runtime-spike.md` | 去除本機絕對路徑；保留版本、觀察與未驗證邊界 |
| ignored | `docs/research/opencode-parent-and-tui-spike.md` | `docs/archive/phase1/research/opencode-parent-and-tui-spike.md` | 去除本機絕對路徑；保留 `PARTIAL` 與人工觀察界線 |
| ignored | `docs/research/opencode-status-spike.md` | `docs/archive/phase1/research/opencode-status-spike.md` | 保留明示 dummy fixture；不視為 credential |
| ignored | `docs/research/opencode-session-tree-spike.md` | `docs/archive/phase1/research/opencode-session-tree-spike.md` | 去除本機絕對路徑；保留 `UNKNOWN` |
| ignored | `OMW_PROJECT_HANDOFF.md` | `docs/archive/phase1/OMW_PROJECT_HANDOFF.md` | 加入歷史／非契約標示，不回溯改寫 checklist |
| untracked | 七支 `scripts/` spike source | 原相對路徑 | 保留 script-relative dependencies；移除 executable 的本機預設路徑 |
| untracked | `prototypes/console/` first-party source | 原相對路徑 | 保留 fixture-only prototype 與 source-relative imports；fixture path 去識別化 |
| untracked | `prototypes/console/package-lock.json` | 原相對路徑 | 敏感資訊、private registry 與本機路徑掃描通過後原樣保存，供重現 dependency resolution |

七支 spike source 為：

- `scripts/ConPtySpike.cs`
- `scripts/opencode-parent-exit-spike.ps1`
- `scripts/opencode-runtime-spike.ps1`
- `scripts/opencode-session-tree-spike.mjs`
- `scripts/opencode-status-mock-provider.mjs`
- `scripts/opencode-status-spike.mjs`
- `scripts/opencode-tui-spike.ps1`

## 未保存的本機產物

- `prototypes/console/dist/`：build output，可由 prototype build 重建。
- `prototypes/console/node_modules/`：installed dependencies，可由 package manifest 重建。
- `.scratch/`：研究執行產物，可能含本機路徑、PID、port 與 transient database；不納入 Git。
- `.serena/`：本機工具狀態，不是專案 source。
- `opencode.json`、`opencode.jsonc`：本機 runtime configuration，既有安全 ignore 維持不變。
- `.env*`、database、log 與 `.omw/`：credentials/runtime 類別，既有安全 ignore 維持不變。

上述原件均未刪除；本輪只是不建立可追蹤副本。沒有複製 credential、production data、
本機 runtime config、installed dependencies 或 build output。

## 使用邊界

歷史研究若與現行文件衝突，以現行文件為準；需要把歷史觀察提升為產品契約時，必須重新
驗證目前版本與實作，再更新相應的權威文件。研究 scripts 本輪只保存、未執行。
