# Reference

本頁是 OMW 現行技術契約的索引，不複製各文件的規則。實作、操作或驗收若有歧義，以連結的權威文件與目前程式碼為準；`docs/archive/phase1/` 只保存歷史觀察。

## CLI

| 介面 | 用途 | 權威文件 |
| --- | --- | --- |
| `omw` | 初始化、啟動或重用 Manager；不啟動 OpenCode TUI | [使用手冊 Quick Start](user-guide.md#quick-start) |
| `omw opencode [project] [-s session]` | 透過 OMW wrapper 啟動 Local TUI Instance | [Local TUI launcher](development.md#local-tui-launcher) |
| `opencode ...` | 原生 OpenCode；OMW 不攔截、不自動登錄 | [Launcher contract](security/launcher-contract.md#local-cli-invocation) |

`@sevenflanks/omw` 尚未確認已發布至 public npm registry；日常操作目前只以 repository 建出的 local `.tgz` 為準。

## Runtime

- [Runtime data 與環境變數](development.md#runtime-data)
- [隔離的 development、test 與 acceptance configuration](development.md#隔離的開發測試與驗收入口)
- [Instance recovery and tracking contract](development.md#instance-recovery-and-tracking-contract)
- [Primary Session Binding contract](development.md#primary-session-binding-contract)

日常資料預設位於 `%LOCALAPPDATA%\OMW`；repository development 固定使用 worktree-local `.omw/development`，test 與 acceptance 使用 fresh temporary root。兩者不可混用。

## API

- [Manager API endpoints、request boundary 與 response contract](development.md#manager-api-contract)
- [Launcher reservation、register 與 finalize API](security/launcher-contract.md#launcher-api)

Browser mutation、launcher request、Origin、authority 與 token 的規則屬安全契約，不應只從 endpoint 表格推論。

## Security

- [Local TUI launcher、fixed port、ownership 與 authentication contract](security/launcher-contract.md)
- [Tailnet access contract and runbook](security/tailnet-access.md)
- [Mobile acceptance checklist](security/mobile-acceptance.md)

OMW 維持 loopback-only；明示開啟 remote mode 時，OMW 只會保守新增並驗證缺少的 Tailscale Serve mappings，不會設定 Firewall、ACL、Funnel、login/up、OS service 或其他 public ingress。Browser Basic auth 與 launcher token 是不同 audience，文件、Issue、log 與截圖都不得包含 password、token 或 `credentials.dpapi` 內容。

## Diagrams

| GitHub inline asset | 可編輯 source |
| --- | --- |
| [OMW 本機與 Tailnet 架構](diagrams/omw-architecture.svg) | [HTML](diagrams/omw-architecture.html) |
| [OMW 啟動、重用與失敗處理](diagrams/omw-startup-flow.svg) | [HTML](diagrams/omw-startup-flow.html) |
| [OMW 三種停止操作](diagrams/omw-stop-semantics.svg) | [HTML](diagrams/omw-stop-semantics.html) |

SVG 是由同名 HTML 的第一個 `<svg>` 匯出。需要修改圖時先改 HTML source，再重新匯出，避免兩份內容漂移。

## Validation

- [目前驗收狀態與限制](user-guide.md#validation-status)
- [Issue #11 人工本機驗收](acceptance/issue11-manual-local-acceptance-2026-09-20.md)
- [Issue #11 正式 Vue UI + isolated mock acceptance](acceptance/issue11-ui-acceptance-2026-09-20.md)
- [Issue #12 A/B isolation acceptance](acceptance/issue12-ab-isolation-acceptance-2026-09-20.md)

Mock UI、synthetic PTY、模擬 mobile viewport、人工本機流程與真實 Tailnet／手機驗收是不同證據層級。任何一層的 PASS 都不能改寫其他層的 `NOT VERIFIED` 或 `NOT_PROVEN`。

## Historical Material

[Phase-1 archive](archive/phase1/README.md) 保留特定版本、日期與環境下的研究結果，不是現行產品契約。完整保存邊界見[專案文件與研究物件盤點](project-inventory.md)。
