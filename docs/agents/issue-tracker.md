# Issue tracker：GitHub

正式規格與工作票使用 `Sevenflanks/opencode-manager-web` 的 GitHub Issues。所有 GitHub 操作使用 `gh` CLI，明確指定此 repository。

## 操作慣例

- 讀取工作票時，同時讀取 body、comments 與 labels。
- 發布 Markdown body 使用 `--body-file`，遵循 `gh-body-file` skill。
- 工作分解使用 sub-issue；真正的阻擋關係使用 GitHub 原生 issue dependencies。若功能不可用，再以 body 中的 Part of／Blocked by 表達。
- 原生依賴 API 使用 issue 的 database ID，不把 issue number 或 node ID 混用。
- 授權與 triage 角色依 `triage-labels.md` 判斷；不因有完整草稿就自動標記 `ready-for-agent`。
- 發布既有本機草稿後，保留 GitHub issue 連結，避免維護兩份不同的票務狀態。

## 本機指標

OMW MVP 規格為 [GitHub Issue #1](https://github.com/Sevenflanks/opencode-manager-web/issues/1)，子工作票為 #2–#9；`docs/specs/` 僅保留指標與索引。承接前動態讀取 GitHub body、state、labels、comments 與 native dependencies。本輪使用者授權決定可執行範圍；#8 可先研究與執行已授權的 loopback PoC，但方案需使用者核准才可結案，#9 的外部設定變更仍需明確授權。

## Pull requests as a triage surface

PRs as a request surface: no.
