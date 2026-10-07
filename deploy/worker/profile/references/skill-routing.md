# 依任務載入來源技能

這是指向 native `skill` registry 的入口，不取代來源 skill 的完整流程。先比對實際 registry description、任務與本輪授權；缺少指定名稱／helper／agent 時回報具體缺口，不換成同名精簡流程。

| 任務觸發 | 來源 name |
| --- | --- |
| 尚未定案，需要挑選流程／釐清需求 | `ask-matt`、`start-from-matt`；訪談依 `grill-me`、`grilling` 或需同步 domain docs 的 `grill-with-docs` |
| 將已討論需求整理成 spec 或拆工作票 | `to-spec-or-ticket` 路由至 `to-spec`／`to-tickets`；Issue 結構用 `github-issue-conventions` |
| 已定案規格的實作 | `implement`／`implement-spec`；要求 test-first 時 `tdd` |
| 明確要求一路交付 | `go-for-it`／`go-for-it-remake`，逐段核對其交付範圍與本輪限制 |
| 難解 bug／效能退化 | `diagnosing-bugs`；已有 logs 時 `log-analysis` |
| 變更或 PR review、review follow-up | `code-review`、`pr-review`／`pr-review-remake`；自有 PR 整理用 `get-pr-ready`／`get-pr-ready-remake` |
| 準備 commit、寫 PR body | `git-commit-co-author`、`pr` |
| 明確要求發布交付、admin merge／cleanup | `push-post-pr`、`finish-and-admin-merge` |
| 規格決策需要意圖註解 | `code-intent-comments` |
| 前端畫面／互動、瀏覽器驗證 | `web-design-guidelines`、`playwright-cli` |
| Office 文件 | `officecli`、依檔型 `officecli-docx`／`officecli-xlsx`／`officecli-pptx` |
| 回到既有工作、研究、handoff | `catchup`／`what-next`、`research`、`handoff` |
| 明確啟用 ADHD 輸出模式 | `i-have-adhd`，不預設啟用 |

`finish-and-admin-merge`、`push-post-pr`、`start-from-matt`、`to-spec-or-ticket` 可由使用者明確指定，經原生 `skill` tool 載入同名技能；profile 沒有 custom command wrappers。PR link／issue number 本身只選 target，不構成寫入或 merge 授權。

ERP／Mantis／Jenkins／Kibana／Kubernetes 文件可被載入；其登入、CLI、MCP、外部讀寫與部署能力另依實際環境及本輪授權核對。不可因技能已存在就宣稱服務已連線，亦不自動安裝 hooks 或外部服務。

Context7 預設以匿名公開 MCP 提供 read-only `resolve-library-id`／`query-docs`；不使用 model provider 代替文件工具，也不連企業服務。失聯、quota 或 tool 不可用時，依全域指引先明示 unavailable 與原因，再具名說明官方文件／固定版 source 的替代證據；不得隱藏 fallback 或讀取宿主 key／新增登入來補通。
