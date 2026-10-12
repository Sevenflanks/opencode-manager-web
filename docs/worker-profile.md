# 精選 Linux Worker profile

本文件是 [#105](https://github.com/Sevenflanks/opencode-manager-web/issues/105) 的 image 契約與 [#108](https://github.com/Sevenflanks/opencode-manager-web/issues/108) 的完整 skills／Linux 全域指引整合契約。規則依已確認需求投影；2026-10-12 新增已授權的本機 OpenAI model／variant 配置，沒有複製宿主 credentials、私人 URL、prompts 或整份 permission 設定。

## Inventory

| 納入 | 來源／用途／依賴 |
| --- | --- |
| `profile/opencode.json` | OpenCode **1.18.34**，`/bin/bash`、本機 ACP／Auto Permissions／Goal／Command Inject plugins、absolute instructions／標準 global skills discovery、單層 task 與最小權限；`compaction.auto: false`、`autoupdate: false`；global／small model、default agent 與角色 variant 見下節 |
| `profile/acp.json` | Active Context Pruning **opencode-acp@1.18.3**，enabled，autoUpdate false |
| `profile/AGENTS.md` | 最小範圍、明確授權、zh-TW、worktree 保留、委派／驗收、秘密、Linux process owner 與工具可用性 |
| `profile/agents/*.md` | `astra` primary；`general`、`general-simple`、`general-complex`、`verifier`、`explore`、`scout`、`reference-reader` 七個 native subagents，不遞迴委派；model／variant 集中在 inline config |
| `profile/references/skill-routing.md` | 依觸發條件指向來源同名 skill，不複製流程或固定 handoff 格式 |
| 完整 source bundle | **62** 個 selected skill roots（60 個指定＋`web-design-guidelines`＋`pr-review-remake`），含 references／scripts／templates／metadata；固定來源與 private artifact 契約見 [worker-skills-bundle.md](worker-skills-bundle.md) |
| `officecli`、`officecli-docx`、`officecli-xlsx`、`officecli-pptx` | 原創 help-first skills；依 OfficeCLI **v1.0.153**；沒有複製第三方技能全文 |
| Context7 public MCP | 官方 public remote `/mcp`，無 headers、`oauth: false`、**預設啟用**，匿名 read-only docs 查詢；協定與 Worker 連線證據見下節 |
| ACP plugin dependencies | `acp/package.json` 及完整 `package-lock.json`，直接固定 `@opencode-ai/plugin`／`sdk` **1.18.34**；esbuild **0.25.10** 只在 build 使用 |
| Auto Permissions plugin | **opencode-auto-permissions@0.2.15**，MIT，獨立 npm lock／完整 dist artifact，**無 runtime dependencies**；固定本機 file URL tuple，配置與授權語義見下節 |
| Goal plugin | **@prevalentware/opencode-goal-plugin@0.1.60**，MIT；只選 upstream V1 server，保留 default Goal policy、12 tools、3 個動態 commands；state 隔離於每個 Worker HOME |
| Command Inject plugin | **opencode-command-inject@1.3.1**，MIT 宣告；default-only 工廠，依 project scripts／Makefile／可 discovery skills 動態提供 commands，不建立 static custom command files |

完整 bundle 與四個既有 Office wrappers 組成 **66** 個 profile registry names；原 `development-test`、`git-github-workflow`、`linux-process-lifecycle` source 與三個 curated commands 由 image／bootstrap owner 移除。全域指引不再要求載入它們。`agent-process-lifecycle`、`self-challenge` 不納入。Profile **沒有 static custom command files／command wrappers**：`task-plan`、`verify`、`deliver` 不恢復，也不新增四個 Markdown command wrappers。OpenCode 內建、ACP 與本次明確授權的 Goal／Command Inject 動態 commands 由各自 owner 提供；command catalog 可變多，不能沿用歷史的 70 個作上限。

ERP／Mantis／Jenkins／Kibana／Kubernetes 技能流程納入 bundle，但登入整合、credentials 與服務可用性另行核對。沒有帶入 Windows shell／IDE／桌面、宿主 history／deja／memory 強制依賴、Manager heartbeat、OMO、session-memory 或宿主 handoff 服務。工具 image 提供 non-root Linux、Node 24／npm、Git／gh、JDK 25／Maven、Python、curl、CA、SSH client、shell、搜尋、JSON、解壓與 timeout；精確 patch versions／來源／checksums 由 image inventory 記錄。browser／fonts／PDF exporter 不因載入 skill 自動具備。

## 原生 agent、model 與權限

`OPENCODE_CONFIG_DIR` 讓原生 loader discovery `agents/*.md`；不要用 commands wrapper 模擬 role。`astra` 是非隱藏的 primary／default agent，以本地 Linux prompt 要求遵循 AGENTS.md、負責需求、工作邊界與總驗收。`general` 是預設實作選擇，simple／complex 依問題風險與不確定性選擇；`verifier` 做細部檢查／已授權 tests，`explore` 定位 repo，`scout` 查官方外部資料，`reference-reader` 唯讀查閱已存在的參考 source、JDK `/opt/omw-worker/toolchain/java` 與 Maven／Go cache；缺檔不安裝、不下載、不使用 shell。全部 subagents 的 `task: deny` 加上 `subagent_depth: 1` 避免遞迴；`plan` 另外禁止委派三個實作 roles。

唯讀 roles 以 `permission["*"]: deny` 作底，按實際 native tools 開啟 read／glob／grep／list／skill／文件查詢；edit（涵蓋 write／apply_patch）與 task 明確 deny。`explore`／`scout`／`reference-reader` 的 bash deny；`verifier` 的 bash ask，允許 caller 明確授權的測試衍生 artifact，不允許透 shell 修改 source 或繞過 edit 禁止。未知 plugin／MCP tools 維持 deny，Context7 tools 需 ask。這是工具 gate 加行為契約，**不是 OS sandbox**；shell 的 ask 不等於任意命令已獲授權。`astra` 不設 permission override，沿用既有 Worker global gates 與 native defaults，不搬宿主全 allow；既有 `build`／`plan` 權限不變。

全域保留 `bash: ask`、`external_directory: ask`、`doom_loop: ask`，並以 `context7_*: deny` 先封閉其他 Context7 tools，再精確 allow read-only `context7_resolve-library-id`／`context7_query-docs`；名稱依 [1.18.34 MCP catalog](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/mcp/catalog.ts) 的 server prefix／sanitize 規則，保留 hyphen。唯讀 subagents 的 Context7 仍為 ask；新增 Auto Permissions 後，ask 可由 plugin 審查回覆，不保證一定顯示人工確認。保留 runtime 其他原生邊界，不搬整份宿主 permission 或 `external_directory: "allow"`。read roles 延續 env 檔案 ask，example 可以 read；不是全面秘密掃描防線，資料範圍仍依明確授權。

### 2026-10-12 OpenAI 模型配置契約

使用者要求「模型以及推理強度，只要本機設定是 openai 系列的 model 全都遵照本機配置」。依本輪已確認的本機 snapshot，global `model` 是 **`openai/gpt-6.1-sol-fast`**、`small_model` 是 **`openai/gpt-6-luna-fast`**、`default_agent` 是 **`astra`**。不為 small model 擅加推理強度；`title` 的 variant 是獨立的角色設定。

| 角色 | model | variant |
| --- | --- | --- |
| `astra`、`plan`、`build`、`general`、`general-complex`、`verifier` | `openai/gpt-6.1-sol-fast` | `high` |
| `general-simple` | `openai/gpt-6-luna-fast` | `high` |
| `explore`、`scout`、`reference-reader`、`title` | `openai/gpt-6-luna-fast` | `medium` |

模型與 variant 只在 `opencode.json` 的 inline `agent` 宣告；Markdown 保留 role／prompt／permission，不重複模型配置。固定版 **1.18.34** 支援 `agent.model`／`variant` strings，後載入 Markdown deep merge 時沒有這兩個 key 會保留 inline 值。`title` 只覆寫 model／variant，延續內建隱藏模式，不增加 Markdown 或 custom command；未屬本輪 OpenAI snapshot 的角色不投影。這是已確認配置，不是模型可用性、成本差距或真實 LLM 呼叫成功證據。

不新增 `reasoningEffort`、provider `apiKey`／`baseURL`／credential options 或 `enabled_providers` 限制；也不複製未授權宿主 plugins／prompts／permission。普通 global 或 project overlay 仍會影響 effective config，敏感 credential 維持外部管理；原生載入驗證須同時核對 `/config` 與 `/agent` 的最終模型／variant。

本次來源是目前使用的全域 OpenCode 配置，不合併另存的 `profile_gpt`／`profile_gpt_fast` 等替代 profile 或備份。使用者後續明示「opencode-auto-permissions 也給 worker 安裝上去」，授權新增該 production plugin 與 ask 自動審查。它指定 **`openai/gpt-6-luna`／`low`**（非 fast），不改既有 global／small model 或十一角色 mapping；再明確授權 Goal 與 Command Inject，沿它們的上游 defaults，不複製宿主 private plugin options。

### 2026-10-12 原生載入驗證

- 使用既有已驗收的 v0.9.0 image、OpenCode **1.18.34**，唯讀掛載本次候選 profile／驗收腳本，在新容器與 fresh HOME 執行。這是配置 overlay 驗證，沒有重新建置或部署新 image；保留原 image 的 66 個 skill roots 與 ACP dependencies。
- 容器 `--network none`，只查 loopback `/global/health`、`/config`、`/agent`、`/provider`。實際 global／small model、default agent 及上表十一角色的 model／variant 全部相符；`astra` 為 primary、`reference-reader` 為 subagent，內建 `title` 仍 hidden。七個 subagents 不得再委派，plan 的 edit／實作委派限制及原角色權限仍生效。
- 原生離線 catalog 包含兩個指定模型；Sol fast 的 variants 為 `low/medium/high/xhigh/max`，Luna fast 為 `none/low/medium/high/xhigh/max`，各 variant 的 `reasoningEffort` 對應同名字串。`openaiConnected=false`：沒有 credentials，也沒有 provider request、prompt、task 或模型費用；此結果不證明帳戶有權使用模型。
- 最終 fixture exit 0，source／mount／bootstrap 工作副本的輸入 hashes 相符，native child 已退出，兩次本輪容器均以 exact ID 移除並確認不存在。首輪因 OpenCode 為臨時 global JSON 補入 `$schema`，fixture 的 bytes 比對失敗；只補正 fixture 初始 JSON，保留原失敗紀錄，沒有修改產品來掩蓋錯誤。
- 靜態 policy 10 passed；bootstrap 27 passed、3 個原有 Windows POSIX／symlink skip。未重跑完整產品 suite、MCP 連線、真模型委派、OAuth 或 SLKE。配置在 Instance 啟動時載入，既有執行中 Instance 不會自動套用；正式採用需交付 profile 並重新啟動 OpenCode。

## Auto Permissions 固定版、授權語義與驗證

**設定載入後，原本 ask 的工具請求可能自動獲准。** Plugin 初始化不代表已發出模型請求；只有送入 ask 事件的 request 才進入 review。使用者對 plugin 的明示授權不等於授權所有業務操作，AGENTS 與既有 agent permission 宣告仍保留。

- **固定配置：** file URL `file:///opt/omw-worker/auto-permissions/dist/v1-server.js`，tuple options 為 `model: "openai/gpt-6-luna"`、`variant: "low"`、`sessionApprovals: true`、`timeoutMs: 30000`、`userMessageCount: 8`、`runtime: "auto"`、`debug: false`。不使用裸 npm plugin 名稱、不在 startup 抓 latest、不載 TUI entry。
- **權限邊界：** [OpenCode 1.18.34 Permission.ask](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/permission/index.ts) 先 evaluate native rules；deny 回傳錯誤、allow 直接完成，只有 needsAsk 才 publish `permission.asked`。這是固定版 source 證據，SDK fixture 不證明 native hard deny。Plugin 不修改既有 rules；上游自身 deterministic policy 可直接允許 routine local checks 或拒絕特定危險命令，其餘才向 reviewer 模型取判斷，沒有自行重寫 policy。
- **Reviewer 與資料：** 上游 config hook 建立 hidden、no-tool、deny-all `auto-permissions-reviewer` subagent。Stable SDK 在 temp reviewer directory 建立 temporary Session，使用 `session.prompt`（非 `promptAsync`）取得 structured verdict，finally 刪除；StructuredOutput 的必要回覆工具例外由上游設定。Review input 包含工具 args、request patterns、cwd 與最多八則 user messages，**可能含敏感輸入並送到模型 provider**。`debug: false` 關閉上游 diagnostics；不得將 tokens／credentials 寫入 logs。拒絕後上游可用 `promptAsync` 送 synthetic continuation，這與 reviewer prompt 是兩條路徑。
- **Fallback 與失敗：** 指定 reviewer model timeout、error 或 invalid result 時，上游可向不同的父 Session model **fallback 一次**，沿用父 model variant；有效 deny 不 fallback。每次 attempt 各有 30 秒，兩次均失敗才 reject，不把 30 秒寫成整體 request 上限。Dispose abort pending reviews、停止 listeners、清 cache；不產生 OS children。Plugin 的 tmpdir state 可寫，image artifact 維持唯讀。
- **Session approvals：** narrow、non-sensitive、eligible patterns 的 `allow_session` 才回覆 `always`；broad patterns、敏感 targets 或危險 shell 不擴成 always，仍可回覆 once。Plugin 重用 cache 依 root Session／action／patterns 分組，在 instance memory；不持久化全域 allow。Native `always` approvals 也在 instance memory，依原生 last-match precedence 在 static rules 後評估，可影響同一 instance 的後續請求；不能宣稱任何情況的 hard deny 都不可被先前 approved rules 覆蓋。重啟清除這些記憶體狀態。

### 最小 artifact build

在 `deploy/worker/auto-permissions/` 執行，約 10 秒（不含 registry 延遲）：

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build
```

只有一個完整依賴 **`opencode-auto-permissions@0.2.15`**；無 transitives、SDK／esbuild／額外 Bun binary。npm tarball integrity 為 `sha512-iaOI64a8DiC3b8rnYAxWH3QyvdIvJIltL2neMG6eBlUKwsKC5Vt7W6A3ft+7wDFX7+iGFth2ClduKWS0S+hSVA==`。[v0.2.15 source](https://github.com/hueyexe/opencode-auto-permissions/tree/v0.2.15) tag commit 為 `bc238eff1bfa56c7d16e3571b7b2f7ead465db2a`。

`build.mjs` 檢查 lock／package／exports、MIT、無 runtime dependencies、完整六個 npm 檔案與固定 entry hash；Node 原生 import `default.server`，原封 copy dist、package.json、LICENSE、README 到本地 `deploy/worker/auto-permissions/dist/`，再保留 build recipe／lock 在其中的 `source/`，inventory 在 `artifact.json`。所有三個 upstream dist entry 均保留，但只載入 v1 server。外層 build output `dist/` 遵循既有 Docker context exclusion，不將 host 生成物當 build input。Docker 獨立 `auto-permissions` stage 在固定 Node **24.14.0** build；final image COPY 至 root-owned 唯讀 `/opt/omw-worker/auto-permissions/`，不改 ACP dependency source／bootstrap。

Entry SHA256：`6263c4509ea0bb93e715e96e58174d14a615c95ee68cbd5a64c0ba98124adc76`。

### 本切片與原生隔離驗證

本機 Node **24.15.0**／npm **11.12.1**，固定 `npm ci` 與 artifact build 成功；Node import `default.server` 為 function。`auto-permissions.test.mjs` **14 passed**，直接測真 upstream dist public hooks，以 memory-only synthetic SDK 隔離模型：once、eligible always／instance reuse、新 instance 不重用、broad／sensitive／dangerous 限制、有效 deny、父模型 fallback、timeout／error／invalid reject、temporary Session 刪除、reviewer system prompt 隔離與 dispose abort。Profile policy **11 passed**；bootstrap **27 passed／3 個既有 Windows skips**。Timeout fixture 為 100ms，不修改 production 的 30000ms。這些證據不代表 AI 審查判斷正確，也不代表真帳戶可用。

約 6 秒的 targeted 命令（Windows bootstrap 有三個既有 POSIX／symlink skip）：

```sh
node --test scripts/worker/profile-policy.test.mjs scripts/worker/bootstrap.test.mjs scripts/worker/auto-permissions.test.mjs
```

2026-10-12 已以既有固定 v0.9.0 image、Node **24.14.0**／OpenCode **1.18.34** 完成原生隔離驗證：fresh HOME、`--network none`、無 host ports／credentials，將新 artifact、候選 profile 與驗收 helpers 唯讀掛載。既有 image 本身未含新 artifact；這是配置與 artifact overlay 驗證，不是完整新 image build 或線上部署。

- `/config` 的 file URL tuple 與七個 options 相符；`/agent` 出現 profile 原本未宣告的 hidden `auto-permissions-reviewer`，確認上游 config hook 真正生效。其 model／variant 是 `openai/gpt-6-luna`／`low`，`steps: 1`、`tools: {"*": false}`；原十一個 model mappings、default agent 及既有角色權限均通過原生斷言。
- Reviewer 宣告為 deny-all；受驗的 read、bash、edit、task、skill、webfetch、Context7 等工具實際解析為 deny。但 effective ruleset 仍有 OpenCode 追加的窄幅 tool-output 目錄 allow，不把它描述成完全沒有 allow，也未宣稱實際執行了 hard-deny 工具請求。
- 離線 catalog 含 `gpt-6-luna` 與 `low`，原 Sol／Luna fast 及 variants 也仍存在；OpenAI listed 不等於 connected，沒有送 prompt／permission review／provider request。未驗證 AI reviewer 的決策品質、真帳戶可用性或既有 approved rules 的 live 行為。
- 37 個候選輸入的前後 hashes 與 inventory 相同；native child 收到 SIGTERM 並退出，fixture exit 0，finally 以 exact ID 移除容器並確認不存在，無本輪容器殘留。沒有重跑已通過的 SDK fixture 或完整產品 suite。

### 其餘宿主 plugin 差異

2026-10-12 只比對目前全域配置的 plugin 宣告，不將宣告視為已核實的安裝版本或有效載入證據。Worker 本次 plugin 順序為 **ACP → Auto Permissions → Goal → Command Inject**。以下仍不預載：`@franlol/opencode-md-table-formatter`、`opencode-mini-session`、`opencode-visual-cache`、`opencode-subagent-magazine`、`opencode-deja`。本機另有字面項目 `update`，其用途及實際套件身分未確認，不自動安裝。這份 plugin 差異不取代 MCP／CLI／skills 的能力盤點，也不擴張這次安裝授權。

## Goal／Command Inject：固定版 packaging 與動態指令契約

### 上游來源與 runtime

| 項目 | 固定來源／entry |
| --- | --- |
| Goal | [commit `cf22feaaa7ab3367053a9a99913cbc40e5c3224e`](https://github.com/prevalentWare/opencode-goal-plugin/tree/cf22feaaa7ab3367053a9a99913cbc40e5c3224e)，npm `0.1.60` 的 `./server` export → `dist/server.js`；選 `default.server` |
| Command Inject | [commit `14787ebc26c950c3410330837be2314971218ea4`](https://github.com/shihyuho/opencode-command-inject/tree/14787ebc26c950c3410330837be2314971218ea4)，npm `1.3.1` 的 `module: index.ts`；選 named `CommandInjectPlugin` |
| Adapters | `session-plugins/goal.mjs`／`command-inject.mjs` 各只 export 一個 default factory；避免 [1.18.34 legacy loader](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/plugin/index.ts) 將多個 named functions 當成 plugins 呼叫 |
| SDK／build | `@opencode-ai/plugin`、`@opencode-ai/sdk` override **1.18.34**，符合上游 `^1.17.1`／`^1.2.15`；esbuild **0.25.10**、Node build target **24**，Docker build Node **24.14.0** |

`session-plugins/package-lock.json` 固定完整 npm resolution／integrity。Node esbuild 真正解析 import graph，把 runtime dependencies bundle 到兩個 ESM entries，外部只允許 Node builtins；不用 `packages: external`。實際 runtime graph 為 Goal **0.1.60**、Command Inject **1.3.1**、`effect-goal-state` alias **effect 3.22.2**、`fast-check` **3.23.2**、`pure-rand` **6.1.0**、Goal `zod` **4.6.6** 與 Command Inject `zod` **3.25.76**。SDK／plugin imports 是 type-only，未進 bundle；安裝 graph 的 Effect 4 不進 Goal runtime，也不與其私有 Effect 3 alias 混用。OpenCode native 本身在 Bun 執行，不新增另一個 Bun binary。

Goal 的 `@opentui/solid >=0.5.8`、`solid-js >=1.9.0` 是 **非 optional 的 TUI peers**；本 server-only recipe 以 `.npmrc` 的 `legacy-peer-deps=true` 明確省略，實際 graph guard 不允許引用它們。`@opencode-ai/plugin@1.18.34` 的 `@opentui/core`／`keymap`／`solid >=0.4.5` 為 optional peers，同樣不載入。`npm ls --all --omit=peer` 因 Goal 缺 TUI peers 回報 `ELSPROBLEMS`；不能把它寫成完整上游 package peer check 通過。這裡保證選定 server entry 的依賴完整，沒有 TUI／OpenTUI／GUI 功能。

完整 npm package source（含 runtime assets、package metadata、README、LICENSE／notices）複製到 artifact `sources/`；Goal 的原 MIT LICENSE 保留。Command Inject 固定 Git tree／npm 均沒有獨立 LICENSE，保留原 metadata／README 的 MIT 宣告並在 `THIRD_PARTY_NOTICES.md` 記錄，不捏造 copyright。兩個 metafiles、build recipe／lock、全部檔案 SHA256 inventory 同 artifact 保留；不提交 `.tgz`、`node_modules/` 或生成 `dist/`。

### Goal 的授權、state 與停止邊界

普通工作不建立 goal；使用者明確要求 goal，或明確要求 agent 自訂 goal，才透過上游 `/goal` 或 tools 建立。明確觸發要求由上游 tool descriptions／command template 提供，`experimental.chat.system.transform` 供給 Goal state／Plan／completion policy；不另複製長段 prompts 或改 goal planning control。沒有外部 Manager。

上游 default `auto_continue: true`，僅 active goal 在 idle 自動續行。Plan create 是 paused，`restricted_agents: ["plan"]`／`allow_goal_execution_from_plan: false` 維持預設，Plan 不得 resume active。`max_auto_turns: 25`、minimum interval **3 秒**、Task-child deferral ceiling **900 秒**、連續 prompt failures **3**，無預設 token／duration budget 或 `max_turn_time` watchdog；**900 秒是 child 對 Goal 續行的阻擋上限，不是保證殺掉任意 shell／本機程式**。取消 in-flight provider／工具／OS children 仍由 OpenCode 與原 process owner 負責。

12 個 tools：`get_goal`、`get_goal_history`、`list_all_goals`、`create_goal`、`set_goal`、`update_goal_objective`、`update_goal_status`、`update_goal`、`stop_goal`、`replace_goal`、`update_goal_plan`、`clear_goal`。動態 commands：`goal`、`pause_goal`、`resume_goal`；既有同名 config command 由上游保留，不盲目覆寫。命令與 tool 仍受原生 agent gates，增加 commands 不代表繞過 hard deny。

預設 state 是 `$XDG_DATA_HOME/opencode-goal-plugin/goals.json`，本 image 為 **`/home/node/.local/share/opencode-goal-plugin/goals.json`**；未設 XDG 時是 `~/.local/share/opencode-goal-plugin/goals.json`。`OPENCODE_GOAL_STATE_PATH` 可由上游處理，但本 profile 不設定。每個 Worker HOME 是獨立 emptyDir／執行空間，即使 UID 都是 1000 也不跨 Worker 共用。不同 Instance 不能刻意指向同一 writable state；clear 保留 bounded history，不等於刪除 history。

### Command Inject 的來源與 collision

初始化讀 project `package.json` scripts、`Makefile` targets 及上游可 discovery skills，產生 `<runner>:<script>`、`make:<target>`、`skill:<name>`；runner 依 `packageManager`、lockfile、最後 fallback npm。Command hook 注入指令文字，**不自行執行 shell**；後續 agent 執行照原 `bash: ask`、agent deny 與 Auto Permissions 規則。

固定 1.3.1 的 skill roots 是 project `.opencode/skills`、HOME `.config/opencode/skills`、project `.claude/skills`／`.agents/skills`、HOME `.claude/skills`／`.agents/skills`，first match wins。它 **不讀 `OPENCODE_CONFIG_DIR` 或 `skills.paths` 作 skill discovery**。目前 bootstrap 將 66 個 profile skills 的唯一工作副本放在 **`HOME/.agents/skills`（image 為 `/home/node/.agents/skills`）**，OpenCode 1.18.34 的標準 global scan 與 Command Inject 共用此實體目錄；profile 不再設定 `skills.paths`，也不留 old profile skills、mirror 或 symlink bridge。Plugin config 仍可讀 `OPENCODE_CONFIG_DIR`、普通 global 或 project 的 `opencode-command-inject.json[c]`，沿 defaults。

先已有的 canonical command 保留原 template，hook 不為 collision 注入另一個 text；custom prefix collision 按上游嘗試 canonical fallback。不能在缺 native evidence 時宣稱處理了所有 builtin／skill command namespace collisions。

### 本機 focused 驗證與 native overlay

在 `deploy/worker/session-plugins/` 執行：

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build
```

Repository root focused tests（約 15 秒，host Node **24.15.0**／npm **11.12.1**）：

```sh
node --test scripts/worker/session-plugins.test.mjs scripts/worker/profile-policy.test.mjs scripts/worker/auto-permissions.test.mjs
git diff --check
```

測真上游 public hooks、runtime relocated default-only entries、完整 artifact hashes；0 LLM／provider calls。Fixture 使用獨立 non-secret temp HOME／XDG／project，finally dispose、驗證 owned timer 清空，再清 temp files、復原 environment；active child 的真 deferral timer 也納入清理驗收。測普通訊息不建立 goal、create／pause／get／clear／history、兩個 HOME 不共用 state、Plan 禁 resume、active idle 的 mock SDK prompt arguments、package／Makefile／skills text injection、既有 command collision，以及 Auto Permissions→Goal→Command Inject config coexist。既有 mapping／七角色 task deny 與 reviewer deny-all 保留。

2026-10-12 本切片 build 成功，artifact inventory **5217 files**；Session Plugins **8 passed**、profile policy **11 passed**、Auto Permissions **14 passed**、bootstrap **27 passed／3 個既有 Windows skips**，兩個 native helpers 的 `node --check` 與 `git diff --check` 成功。新增 coexist fixture 曾把 config 的 model string／permission object 當 native `/agent` 形狀，修正 fixture boundary 的明示投影；另校正 system-policy oracle，明確 create 要求實際位於 tool description，而不是 system block。未修改上游程式以迎合測試。上述是不同 focused runs 的有效結果，不冒稱一次 full suite 全綠。

Native overlay 將本地 **`deploy/worker/session-plugins/dist/` 唯讀掛載到 `/opt/omw-worker/session-plugins/`**，候選 profile／helpers 同樣 readonly，使用已有固定 image、fresh writable HOME、無 credentials／真 provider 的隔離 native **OpenCode 1.18.34**。兩個 file URL 的 exports 都只有 callable `default`。`verify-profile.mjs` 已擴充 native 12 tools／3 commands、artifact hash 與 readonly checks；另在 fresh `/workspace` create-only 寫入 public package／Makefile，要求 discovery 出現 `npm:omw-session-fixture`、`make:omw-session-fixture`，只讀 catalog，不執行它們，finally 移除當輪 owned files。原 `task-plan`／`verify`／`deliver` absent assertions 保留；該階段尚未重跑完整 image runner，以下是另外執行的隔離 overlay 證據。後續完整 build 結果見下方交付驗證，不改寫這輪 overlay 的範圍。

2026-10-12 四 plugin 原生 overlay 實際通過（Node **24.14.0**、OpenCode **1.18.34**，network none）：

- `/config`、`/agent`、`/experimental/tool/ids`、`/command` 均 HTTP 200；確認 ACP → Auto Permissions → Goal → Command Inject 的順序、tuple 及 hidden reviewer。`assertProfileModels`、`assertAutoPermissionsReviewer`、`assertSessionPlugins` 均通過，既有 11 個角色模型／variant 與七個 sub-agent task deny 保持。
- 觀察 **31 個 tool IDs、78 個 commands**，包含全部 12 Goal tools、`goal`／`pause_goal`／`resume_goal`，以及本輪 project fixture 的 `npm:poc:echo`、`make:fixture-target`、`skill:poc-skill`。既有 `npm:poc:preserved` 的 template／description 未被覆蓋；不是宣稱所有 namespace collision 都已驗。
- 候選來源／工作副本／fixture 的 static custom command 檔案均為 0，原 profile 的 66 個 skills 保留。啟動與關閉前後 Goal state 檔不存在，沒有建立目標或自動續行；沒有執行任何 Goal tool、command、prompt 或 task。
- 全部 **5,263 個 source／artifact inputs** 前後 hash／inventory 相同，另核對容器內 50 個 native inputs。最終原生 `/global/dispose` 回 200／true，child SIGTERM 後 close、container exit 0，exact-ID 移除後查無容器。三輪自有容器皆已清理。
- 原第一輪 `/config` 10 秒 timeout、第二輪 fixture 誤把空 commands 目錄當成檔案的失敗均保留。最後一輪預備隔離 cache、明示 120 秒 fixture TTL／40 秒 config deadline 並正確計數 command 檔案，prepare／run／post 全 exit 0。第一輪原因未單獨隔離，不據此判定 plugin regression。

此證據是候選檔案／artifact 唯讀掛入已驗 image，**不是完整新 image build 或 SLKE 更新**。沒有真 provider／AI permission review／Goal LLM 自動續行／command execution／Context7 外網驗收；離線 OpenAI metadata 為 listed=true、connected=false，不是帳戶供給證明。

### 2026-10-12 global skills 原生驗收補證

在兩個獨立 fresh HOME、network-none 容器，以候選 bootstrap／profile／plugin artifacts 唯讀覆蓋已驗 image，實際執行 OpenCode **1.18.34**。兩案首次即通過，沒有 fixture 重試；此結果不替代完整新 image build。

| 場景 | 實際 native 結果 |
| --- | --- |
| A：候選 bootstrap 全新初始化 | 66 個實體 global skills；原生 registry 67 個 unique names（含內建 `customize-opencode`），66／66 個 `skill:<name>` aliases 各只有一份 |
| B：image 舊 bootstrap 建立真 v1，再用候選 bootstrap 遷移 | 在舊目錄新增一個自有 skill、修改既有 `officecli` 的自有 marker；遷移與第二次 bootstrap 均保留兩份 bytes。67 個實體 global skills、原生 registry 68 個 unique names、67／67 個 aliases 各只有一份，native registry／alias 都可觀察修改內容 |

兩案每個 profile skill 的 `location` 精確落在 `/home/node/.agents/skills/<name>/SKILL.md`；沒有 symlink／mirror，舊 profile skills root 不存在，v2 manifest 的 `skillsTarget` 為 `home-agents`，migration receipt 已清除。AGENTS／agents／plugins 仍使用原 profile 位置，native config 不再含 `skills.paths`。四個 plugins、既有十一角色 model／variant、hidden Auto Permissions reviewer、Plan 與七個 sub-agent 權限維持；Goal state 在啟動與關閉前後均未建立。Static custom-command 檔案為 0；本輪含受控 project fixtures 的 commands 數為 A 142／B 144，不作一般環境的固定數量承諾。

安全覆核發現並修正 planning reread 的 late-write 問題：caller 傳入先驗核准的 hash／absent，重讀若不同即 collision，不將使用者的新 bytes 重新當作覆寫授權。六個 race cases 的 RED 均證明舊邏輯會把 U 覆成 B；修後保留 U、old copy 及原 manifest，連同正常重啟 case 共 7／7 通過。相關 bootstrap／policy／plugins runs 合計 **78 pass、3 個既有 Windows skips、0 fail**；部署探測另外 **127 pass、0 fail**，支援 legacy 與 v2 混版且不 fallback 到殘留舊路徑。

兩案 source／artifact 5,269 項輸入前後 hash／inventory 不變；原生 dispose 回 200／true、child 退出、精確移除各自容器後查無容器。沒有 provider credentials、模型、Goal tools、command execution、MCP 外網或 SLKE 操作，既有 profile 升級測試亦不代表 filesystem CAS。

### 2026-10-12 完整 image 交付驗證

完整 candidate Dockerfile（包含兩個新增 plugin stages、final COPY 及 readonly artifacts）已完成 build，`verify-profile.mjs` 的 **10 項 checks 全通過，命令 exit 0**。Linux bootstrap **47 pass／0 skip**；native OpenCode 1.18.34 觀察到 31 tools、67 unique skills、66 個 profile aliases 各一份、141 commands。commands 數包含受控 fixtures，不承諾每個專案相同。十一角色 model／variant、Auto Permissions reviewer 與既有權限核對通過；Context7 僅觀察匿名 connected／tool discovery，未執行 docs query 或模型呼叫。

同輪八個上游 Python helpers、原生 shell 工具、Java compiler、10 項 command collision 與 non-root Chromium fixture 通過。root full suite 另為 **472 pass／63 條件式 skip／0 fail**，typecheck 通過；不同 suites 不重複相加。這些結果不代表真帳戶模型、AI permission reviewer 決策、Goal 模型自動續行或 SLKE 已驗收。

補充 observer 曾在帶 shell smoke 的流程末端收到 Stop HTTP 503，未捕捉 response reason，原因仍未知；原 failed report 保留，不宣稱已修復或 flaky。後續一次縮小為 native startup／四 plugins config／state／Stop 的驗證通過：Stop HTTP 200、`stopped=true`，execution 從 occupied 變 available、managed process count 從 1 變 0；Goal state 在啟動、載入、Stop 與 app close 後均不存在，三個 static command roots 僅以 ENOENT 證明不存在。這輪沒有 shell／browser／模型呼叫，不冒充重現並解決原 503。另一次離線 cache 重建因 npm cache 不完整失敗，沒有啟動 fixture；正常 build 恢復後才取得上述結果。

主要 full-image 與最小 seam 均有獨立 scoped cleanup：owned containers／networks／volumes 清空、watchdog 已退出；最小 seam 的 debug image 刻意保留。兩輪 product source／locks／private bundle 均核對未變，後續只有本節文件補證；沒有使用 credentials 或變更線上 Worker。

## Context7 與 omitted host settings

官方 [MCP Clients](https://context7.com/docs/resources/all-clients) 明示 `/mcp` 可匿名使用較低 rate limit（OpenClaw／Pi／Amp 範例）；[上游 README](https://github.com/upstash/context7) 把 API key 標為提高額度的建議。公開 endpoint 是 `https://mcp.context7.com/mcp`，不是私人 host URL。profile 不帶 headers／key，也停用 OAuth 自動偵測，避免隱含登入；只查公開 library 文件，不連企業服務或傳送 private data。

目前 `enabled: true`、`oauth: false`，不需 API key。`resolve-library-id`／`query-docs` 是 read-only MCP tools，不以 model provider 代替。2026-10-07 本切片以非秘密匿名 HTTP JSON-RPC 2.0 探測公開 endpoint（initialize request 的 `protocolVersion` 為 `2024-11-05`）：`initialize` **HTTP 200**、第二個 POST 以 batch 送出 `notifications/initialized` 與 `tools/list`，**HTTP 200**，工具名稱為 `query-docs`、`resolve-library-id`，JSON-RPC error code 均無。總共兩次 HTTP、每次 deadline 10 秒、無重試／redirect／auth headers；若有 session ID 僅留在程序記憶體，沒有輸出或保存 headers／任意 response body。

這是本機到公開 endpoint 的匿名協定／tool discovery 證據，沒有呼叫 docs tool、啟動 OpenCode 或證明 Worker native MCP connected。主 agent 下一輪須在已授權的公開 HTTPS 路徑重新啟動 OpenCode，確認 native `/mcp` 為 connected 與兩個實際 tools；本切片使用的 Context7 documentation MCP 也不代替 Worker 證據。401／403／quota／timeout／網路或 tools 缺少時，依 AGENTS.md 明示 **unavailable** 與精確原因，再具名說明官方 docs／固定版 source 的替代證據；不得隱藏 fallback、讀宿主 key、新增登入或私人 MCP 設定補通。先核對 1.18.34 loader 的 merge precedence：profile 會在 `OPENCODE_CONFIG_DIR` 再 merge，以 effective config 為準；runtime customization 沿下述升級衝突規則保留。

沒有投影宿主 Context7 headers、Vuetify remote、durablememory headers／URL、Serena local command、其他無關 MCP、私人 prompts、完整 host model／agent routing 或所有外部目錄 allow。技能本體、CLI／MCP、登入與外部操作授權是各自需驗證的條件；服務 unavailable 不代表 registry skill 未載入。

## ACP 身分、build 與授權文件

- 正式 repository：[ranxianglei/opencode-acp](https://github.com/ranxianglei/opencode-acp/tree/v1.18.3)，npm：[opencode-acp/1.18.3](https://registry.npmjs.org/opencode-acp/1.18.3)。不是 Agent Client Protocol，也不是 `@tarquinen/opencode-dcp`。
- v1.18.3 tag／npm gitHead 已核對為 `f0502e7eee3430ffb1532d303c4c0b26f6d74494`。npm tarball 的 integrity 在 lockfile；source archive SHA256 為 `0f64c5c4e4ffd73dee296e6428ae9a997402c2c673fdcc4d6e475166b84942ca`。
- 上游授權 **AGPL-3.0-or-later**，保留 LICENSE／NOTICE、完整固定版 source archive 及本切片 build recipe。第三方 npm dependencies 的 license／notice／package metadata 由 build 複製到 `dist/licenses/`，版本／integrity inventory 在 `dist/dependencies.json`；公開散布 artifact 時一併提供整個 `dist/`，不能只 COPY JS。
- `@anthropic-ai/tokenizer`、`tiktoken`、`jsonc-parser`、`zod` 等全部 transitives 由 lockfile 固定。bundle 內嵌 npm JavaScript，Node builtins 由 Node 提供；tiktoken WASM 必須與 `acp.mjs` 同目錄。

Docker 的 ACP stage 在 Node 24、`deploy/worker/acp/` 工作目錄執行：

```sh
npm ci --no-audit --no-fund
npm run build
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
```

只有 image build 可以下載：npm 按 lockfile 安裝，source archive 按 commit＋checksum 下載；不執行浮動 latest、startup `npx` 或 plugin update。`node_modules/`、`dist/` 是 build 產物，不進 Git。build stage 的 platform 要與 image 相符，不能把 Windows 的 node_modules 複製進 Linux。

## Docker／bootstrap 接線契約

| Image 唯讀來源 | non-root runtime 工作副本／用途 |
| --- | --- |
| build stage `COPY deploy/worker/profile` ＋必要 `worker-skills` named context | `skills-profile` stage audit 完整 provenance／hash／references，再將 62 個完整 roots 與 Office 4 合併；image source `/opt/omw/deploy/worker/profile` 及其中 `skills/` 維持唯讀與原位置。bootstrap 將 `skills/` 路由至 `/home/node/.agents/skills/`，AGENTS、agents、references、acp.json、opencode.json 仍至 `/home/node/.config/omw-profile/` |
| 完整 `dist/` 複製至 `/opt/omw-worker/acp/` | plugin 固定 `file:///opt/omw-worker/acp/acp.mjs`；保留 WASM、licenses、source、metafile／inventory |
| package／lock／production `node_modules/` 複製至 `/opt/omw-worker/acp/` | bootstrap 複製可寫 package／lock 至 runtime profile **及普通 global config directory**，兩者 `node_modules` 連到 image 唯讀 `/opt/omw-worker/acp/node_modules`；不遞迴複製 npm `.bin` symlinks，不覆蓋普通 global 的 opencode.json／AGENTS 等使用者設定 |
| 完整 Auto Permissions npm artifact 複製至 `/opt/omw-worker/auto-permissions/` | tuple file URL 指向 `dist/v1-server.js`；MIT／README／全部 dist／package metadata／source lock 與 inventory 同目錄保留，不需加入 ACP node_modules 或修改 bootstrap |
| 完整 Session Plugins artifact 複製至 `/opt/omw-worker/session-plugins/` | `goal.mjs`、`command-inject.mjs` 為 default-only bundles；完整 upstream npm sources／授權／build lock／metafiles／inventory 保留，root-owned readonly；Goal state 另存每個 Worker writable HOME |

環境（不含秘密）：

```sh
OMW_WORKER_PROFILE_SOURCE=/opt/omw/deploy/worker/profile
OMW_WORKER_PROFILE_DIR=/home/node/.config/omw-profile
OMW_WORKER_DEPENDENCIES_SOURCE=/opt/omw-worker/acp
OPENCODE_CONFIG=/home/node/.config/omw-profile/opencode.json
OPENCODE_CONFIG_DIR=/home/node/.config/omw-profile
OFFICECLI_SKIP_UPDATE=1
OFFICECLI_NO_AUTO_INSTALL=1
OFFICECLI_NO_AUTO_RESIDENT=1
```

保持正常 `HOME=/home/node`、XDG config 預設 `/home/node/.config`。普通 global 是 `/home/node/.config/opencode`；不要把 `XDG_CONFIG_HOME` 改成 runtime profile。skills 工作副本固定依已授權 runtime identity 的 `HOME/.agents/skills`，不受 XDG config 改變。若部署更換 HOME／XDG，整合者須一致重寫 profile 內的 absolute instructions 與上述 config 契約。

`OPENCODE_CONFIG` 是新增一層設定，保留 ordinary global merge；`OPENCODE_CONFIG_DIR` 另外讓 agents 及 ACP 的 acp.json 被 discovery。skills 走標準 `HOME/.agents/skills` discovery。各層會 merge，profile directory 也會再載入；驗證要檢查實際 effective config，而非只讀來源檔案。profile 指定上述模型，不設 provider credentials，也不清空使用者其他 MCP；同名 Context7 template 受上述 precedence 影響。

**OpenCode 1.18.34 特有 initialization：**每個可寫 config directory 都檢查 `@opencode-ai/plugin`。有 node_modules 且 package-lock root 包含所有 package.json 宣告及 @plugin 名稱才跳過安裝；因此 fresh Worker 的 ordinary global 與 runtime profile 都需上述 build-prepared package＋lock＋node_modules。專案自行提供 `.opencode/` 或其他 dependencies 時另按該專案的 build／授權處理；不能把額外任意 plugins 可離線啟動寫成保證。

既有 volume 的完整 package／lock／dependencies 與固定 `@opencode-ai/plugin@1.18.34` 相符時原樣保留；不完整或不相容時以固定 `OMW_WORKER_DEPENDENCIES_SOURCE` 錯誤停止，需先準備離線依賴，不覆寫使用者宣告或在 startup 下載。ordinary global 既有目錄權限也保留。profile restart 保留使用者改過的 managed files；source 升級同時碰到使用者修改且內容不同，或新 source 檔案與未追蹤同名 runtime 檔案碰撞時，以固定安全訊息停止，交由操作者備份並明確合併。Runtime 已等於新版 source 時接受，因此完全合併或 partial upgrade 後可重試；source 移除的已修改檔案保留且移出 manifest，重新引入仍受碰撞保護。完整規則見 [Profile 升級](worker-auth-seed.md#profile-升級)。

### Skills 工作副本遷移

1. **先驗再寫：**先驗 source／runtime／global skills 不重疊、root 與 entries 無 symlink／非 regular file、全部同路徑 collisions。自訂 profile 不可包含 HOME／global config／auth 範圍，也不可位於 skills root。碰撞以 `[OMW_WORKER_PROFILE_COLLISION]` 回報已驗證 relative path，沒有內容或 hash；execution 不啟動。auth seed 仍是前一步，可能已完成初始化，這不是整批零副作用 transaction。
2. **v1 → v2：**唯一權威 manifest 仍在 runtime profile 的 `.omw-source-manifest.json`。v1 `files["skills/..."]` 只解釋為 old profile 檔案；v2 明示 `skillsTarget: "home-agents"`，skills entries 路由至 `HOME/.agents/skills`，其餘 entries 仍指 runtime profile。old unchanged managed skills 可更新或移除；old 修改／新增的使用者技能保留 bytes 並搬至 global，`userSkills` 記錄 nullable source baseline，移出 source-owned `files`，重啟不覆蓋。
3. **保留使用者內容：**global 不在 managed list 的檔案不刪。同內容可以 dedup；不同內容的 old／global 同路徑檔案、source 升級與 user edit 分歧、source 新增／rename 與 global custom 相撞皆 fail closed。先備份、明確合併為 incoming source 或相同的待遷移內容後重試；不建立第二份可 discovery 的鏡像。三個舊 managed commands 同輪沿原保留／精確移除規則處理。
4. **逐檔重試：**全量先驗成功後，runtime-only `.omw-skills-migration.json` 暫存 relative paths／hashes／ownership baseline，不存 skill bytes、不進技能 discovery。先 atomic 發布 global 目標，再重新驗證 bytes 並刪 old files，只清 owned 且空的 old directories；技能完成後才發布 opencode.json 與 v2 manifest，最後刪 receipt。中斷後用同一 source 重試；重建 receipt 的語意比對忽略 object key order，但 disk receipt 仍須符合本輪初讀的 raw bytes hash，不能以重建／canonical bytes 當併發檢核基準。receipt pending 時換 source、改 old／global bytes 或新增 child 會停止，需先處理分歧。這不是 filesystem CAS；重新 hash 能阻止已觀察到的 late writes，不能保證排除核對與 unlink／rename 間的任意併發 writer。

原生驗收核對 `/skill` 的全部 66 個 profile locations 均在 `/home/node/.agents/skills/`，每個名稱只出現一次，old profile skills 不存在；`/command` 有全部 `skill:<name>` 且無重複 command names。以上已由本頁 global skills A／B overlay 與後續完整 image 分別驗證；不把 focused Node tests 或較早的 profile-path overlay 當成全域遷移證据。

來源維持唯讀；工作副本、cache、ACP state 由 node 使用者可寫。ACP 預設 state 在 `$XDG_DATA_HOME/opencode/storage/plugin/acp`，log 在普通 global 的 `logs/acp`；不共用多 Worker 的可寫 state。不要將整個 configdir 唯讀掛載使初始化失敗。auth seed 不在 profile 內，也不在此設定流程讀取；auth 初始化／private OAuth／PAT 依另一切片的明確授權契約。

### 為什麼 instructions 用 absolute、skills 用標準 global discovery

已直接核對 OpenCode [v1.18.34 skill loader](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/skill/index.ts)、[instruction loader](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/session/instruction.ts)、[config loader](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/config/config.ts)、[npm initialization](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/core/src/npm.ts)：`skills.paths` 相對值依 project directory；相對 instructions 從 project cwd 向上找，不是依 OPENCODE_CONFIG 所在目錄。instructions 保留 runtime absolute path，plugin 保留 absolute local file URL；skills 改用標準 `HOME/.agents/skills` scan，省略 custom `skills.paths`，避免同一 global root 再掃一次。Profile policy mutation checks 會拒絕重新加入相對、old profile 或重複 global `skills.paths`。

本切片另核對固定版 [ConfigV1 schema](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/core/src/v1/config/config.ts)、[agent schema](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/core/src/v1/config/agent.ts)、[MCP schema](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/core/src/v1/config/mcp.ts)、[agent Markdown loader](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/config/agent.ts)、[task model／depth](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/tool/task.ts)、[tool registry](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/tool/registry.ts)、[shell tool ID](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/tool/shell/id.ts)。permission shell key 仍為 `bash`；websearch、LSP、question 等工具受 provider／flags／client 控制，不保證全部提供。published schema 與 Context7 latest docs 只交叉核對；衝突時以 **1.18.34 source** 為準，拒絕不支援的 key，不自行升版。

## 使用與升級

- 使用 native `skill` 載入來源 name。Seven 的 `finish-and-admin-merge`、`push-post-pr`、`start-from-matt`、`to-spec-or-ticket` 可由使用者明確指定；沒有 command wrappers。使用者要求純分析時維持唯讀，skill 預載不建立 commit／push／merge 或 infra 授權。
- ACP 使用原生 `/acp`，不新增替代壓縮 command；工具預期 `compress`、`decompress`、`search_context`、`acp_status`、`acp_context_recap`。OpenCode 的內建 `/compress` 與 ACP tool 不是同一個命名空間；profile 不覆寫它們。
- 修改版本化 profile，重建固定 image，先以全新 non-secret scratch 完成下列驗證。升級保留使用者本輪修改、ordinary global、auth 與其他 Worker 的 state；source 與工作副本同時改動時由操作者合併，不在 restart 盲目覆蓋。
- 更新 ACP／OpenCode 時同步改 manifest／lock、source revision＋checksum，重新 build 並驗證原生載入。記錄 image digest、版本與檢查結果。設定／agent／skill 是 config-time load，**退出並重新啟動 OpenCode** 才生效。

### Compose 的 opt-in private build

以下命令在 repository root 執行。先依 [bundle 準備流程](worker-skills-bundle.md#rebuild--integration) 取得 checkout 外的 private artifact；build context 必須指向其中的 `worker-skills` 目錄，不可指向含 secrets 的上層目錄。需要支援 [`build.additional_contexts`](https://docs.docker.com/reference/compose-file/build/#additional_contexts) 的 Compose 與 named contexts builder。

```sh
# 先指定 checkout 外、尚未存在的目錄；不使用宿主 secrets／provider 設定作 build input。
PRIVATE_ARTIFACT='/absolute/private/new-worker-artifact'
WORKER_SETUP='/absolute/private/new-worker-setup'
node scripts/worker/skills-bundle.mjs prepare --output "$PRIVATE_ARTIFACT"
node scripts/worker/setup.mjs "$WORKER_SETUP"
export OMW_WORKER_SKILLS_CONTEXT="$PRIVATE_ARTIFACT/worker-skills"
docker compose --env-file "$WORKER_SETUP/worker.env" -f deploy/worker/compose.yaml -f deploy/worker/compose.skills-build.yaml build manager

# 已建好的 image 只需 runtime setup，base Compose 不要求 local bundle 或上述環境變數。
docker compose --env-file "$WORKER_SETUP/worker.env" -f deploy/worker/compose.yaml up -d --no-build
```

`compose.skills-build.yaml` 只增加 manager build 的 `worker-skills` named context，沒有 runtime mount、secret 或 provider 設定。單用 base `compose.yaml build manager` 沒有此 bundle 時，由 Dockerfile 既有 guard 失敗是預期結果；新 private build 必須明確加入 overlay，沒有 latest／wrapper fallback。只有已建 image 的 `up --no-build` 不需要 artifact；使用其他固定 image tag 時，setup 的 `OMW_WORKER_IMAGE` 需與該 tag 一致。

Compose 驗證 harness 的新 build 用法：

```sh
node scripts/worker/verify-compose.mjs --context desktop-linux --skills-context "$PRIVATE_ARTIFACT/worker-skills"
```

只有指定 `--skills-context PATH` 才會加入 overlay；該 run 的 config、build、up、run、exec 與 cleanup 全部使用相同 Compose 檔案列表，context 絕對路徑透專用環境變數傳入。ownership binding 僅保存 `selectedComposeFiles`／`contextpathOnly` 路徑，讓 watchdog 使用同一 project 清理，不讀取或保存 artifact 內容。未指定參數仍使用舊的 base-only 契約；目前完整 skills image 的 build 會依上述 guard 失敗，不自動尋找宿主 bundle。

## Profile policy 靜態檢查

```sh
node --test scripts/worker/profile-policy.test.mjs
git diff --check
```

檢查本切片使用的固定版 config／frontmatter 形狀、absolute 路徑、來源 skill 路由與 references、global／各角色精確 OpenAI model／variant、credential 省略、合法 primary、唯讀與單層委派 gate；agent frontmatter 使用 YAML 可接受的 JSON 子集，靜態檢查不需增加 parser dependency。以 synthetic mutations 驗證錯誤 model／variant、未知 key、unsafe permissions 與漏失引用會被拒絕，也測原生驗收函式拒絕載入結果漏失模型或 primary 權限放大。它是 **static policy subset**，不是完整 OpenCode schema decoder，也不證明 native discovery、MCP 連通、66 個 skill 載入或真實模型流程。原生載入由主 agent 的整合節點驗收。

## 最小 public smoke（image owner 執行）

不以 mock 證明 ACP 載入。Windows host 在 repository root 執行整合 harness；它使用 fresh non-secret scratch、public synthetic PAT fixture，不掛 auth／host config。只有 native container 使用 Docker bridge 連線至已授權的公開 Context7 HTTPS endpoint，沒有 publish host ports；其他 containers 均為 `--network none`。Native namespace 由直接 Node／tini child 持有；Playwright fixture 則由本輪 UID 1000 Docker container 包含 CLI daemon／Chromium，container timeout 160 秒、fixture TTL 150 秒。project label、25 分鐘有限 watchdog 與 `finally` cleanup 綁定官方 Docker ID／label；ownership／evidence 先持久化，長命步驟每 20 秒輸出進度。sanitized `evidence.json` 記錄 Docker allowlist source SHA256、private context manifest digest、image ID、版本、API counts、dependencies 與 cleanup；safe fixture PNG／`skills-tools.json` 保留在 worktree 外 temp directory。

```sh
# 已準備好的 private artifact；不讀 host skills 或任意 global 設定：
node scripts/worker/verify-profile.mjs --context desktop-linux --skills-context <artifact>/worker-skills
# 僅驗原生 native shell／工具 collision（仍走真 RuntimePort、native API）：
node scripts/worker/verify-profile.mjs --context desktop-linux --skills-context <artifact>/worker-skills --shell-only
# 可重用固定版 toolchain cache：--cache-from <toolchain-tag>
# 指定現存固定 image 重跑 smoke：--image sha256:<image-id>
```

Harness 實際使用 `docker buildx build --build-context worker-skills=<artifact>/worker-skills --target worker --output type=docker`，只產生本輪隨機 image tag。缺 context 在 host 啟動前拒絕；Docker stage 也需要此 input，沒有 wrapper／網路 latest fallback。build stage COPY **repo-owned `compiled-lock.json`**、source-lock 與 patch catalog；host／image audit 都以這些可信 metadata 驗證 manifest digest 與完整檔案，不信任 artifact 自報 hash。bundle `git-commit-co-author` 保留完整 scripts／plugin／assets，舊同名 wrapper 已移除；任何其他 name collision 直接失敗。需要重新準備來源時，依 [bundle 固定來源與授權流程](worker-skills-bundle.md#rebuild--integration) 執行 `node scripts/worker/skills-bundle.mjs prepare --output <NEW-PRIVATE-DIRECTORY>`，再將 `<NEW-PRIVATE-DIRECTORY>/worker-skills` 傳入驗收；不把第三方全文放進 Git。

Native API routes 與 tool IDs 已核對固定版 **1.18.34 SDK**：`/experimental/tool/ids`、`/config`、`/skill`、`/command`、`/agent`、`/mcp`。Harness 檢查五個 ACP tool IDs、**66** 個 profile skill names／description／absolute location、全部 489 compiled assets 的 hash、七個 subagent roles、合法 `astra` primary／default agent、global／small model 與十一個角色的 effective model／variant、內建 `title` hidden、有效 permission rules 的 task deny／plan 實作委派 deny、`subagent_depth: 1` 與原生 `/acp`，並確認三個 curated commands／舊三個 source skills／兩個 excluded skills 未載入。fixed native registry baseline 另含內建 `customize-opencode`，共 **67 unique names**；profile 仍精確為 62＋4，不以全 registry 等於 66 否定內建項目。commands 也允許 OpenCode／ACP 自有項目，不要求 total 0。這裡列出驗收項目，不宣稱新版已通過整合；permission／HTTP 證據也**不代表已執行真實 LLM task 或遞迴委派**。

### 2026-10-07 歷史驗收範圍（模型配置更新前）

以下紀錄只適用當時六個 subagents、刻意省略 `model`／`small_model`／`default_agent` 與 role model／variant 的 profile。當時固定版 `task` 對未指定 model 的 role 使用 caller 當前模型；這是舊配置／source 契約，不是本次新版模型 mapping 或真實 LLM 委派的驗收證據。以下原始數字、model calls 0 與 image hashes 保留歷史含義。

fixture slice 另檢查 child env allowlist、GH／Git helper process-scoped availability、禁止的 manager／seed 變數、runtime customization／ordinary config 保留與固定失敗訊息。bootstrap count 解析真實 `node --test` 摘要，保留 `failed: 0`／`skipped: 0` 與有效 checks 不減少的 assertions；本輪 Linux **30 passed／0 failed／0 skipped**，Windows **27 passed／0 failed／3 skipped**（POSIX／symlink 限制）。Context7 effective `enabled: true`、`oauth: false`、無 headers；native `GET /mcp` 以 20 秒上限驗證 `connected`，網路／quota／authentication error 即失敗，沒有停用或 host key fallback。

固定版 `/experimental/tool/ids` 與 `/experimental/tool` 僅列 builtin／plugin，不暴露 native MCP cached definitions。驗收另以 image 內匿名 MCP initialize／tools/list 觀察精確 `query-docs`／`resolve-library-id`、description／inputSchema；由固定版 naming 規則預期 native IDs 為 `context7_query-docs`／`context7_resolve-library-id`，六個 agents 的有效權限另外檢查 read roles 的 ask gate。這份 direct endpoint metadata **不是 native cached tools HTTP inventory 或模型 tool call 證據**；native 連線與 direct tools/list 分別記錄，沒有呼叫模型或文件查詢工具。

同一 image 另執行 bounded toolchain version smoke，包括 OpenCode **1.18.34**、JDK／Maven 與 OfficeCLI **1.0.153** 的 version／help；不生成 Office 文件／PDF。Playwright 使用真正 **CLI 0.1.22**，先讀 CLI help，再開本輪 loopback fixture、run-code 點按 button／assert output、核對 headless Chromium **revision 1247／155.0.8059.12**、保存 PNG、close named session；Docker owner 最後確認 container／network／volume／image tag 全退出。

八個真 upstream Python CLI helpers 實際 `--help`：Jenkins、Kibana、ERP、llms-docs、pr-review stage、go-for-it-remake config、get-pr-ready-remake config、daily-work-log collector。先核對 argparse help 在讀登入設定／外部操作前退出；另做 go-for-it-remake 隔離 config save/read round-trip、兩個 bundled TypeScript plugins 的 Node 24 startup／空訊息 callback。沒有安裝全域 plugins，也沒有執行 PR staging 的 GitHub fetch／write。Python **3.11.2**、`requests` **2.28.1**、`yaml` **6.0** 的 import／version 與工具 metadata 一致，native Bash login shell 也實際 import 成功；依賴在 build 由固定 Debian package lock 安裝，runtime 不執行 pip install。help／import 成功不代表 ERP／Jenkins／Kibana 等外部服務操作已測。

本輪直接觀察成功的範圍為 bootstrap、native registry／ACP／effective permissions、匿名 Context7 連線與 direct definitions、native shell、helpers startup／隔離 config、固定工具版本與本輪安全 Playwright fixture。**六個 agents 載入與 task deny 不代表 LLM 委派成功**；沒有模型呼叫、真實壓縮效果、真實 PAT／登入或全 skills end-to-end 保證。既有 OAuth 證據不因本次 profile 更動而自動失效，本輪沒有重新登入／驗證 OAuth。未來真實模型測試預設 **openai/gpt-6-luna-fast**；指定模型不可用即 blocker，不 fallback；這不是日常 model 設定。

### 2026-10-07 最後整合證據（Context7 connected）

使用 `omw108-skills-n13e17/worker-skills` 的一次完整命令，owner `omw-verify-edf42e3b813c5c91`：**10 個功能 checks 全數 passed**，完整 build 約 224 秒，Linux bootstrap 30／0／0。native profile 66／全 registry 67 unique、upstream 62／Office 4、compiled 489／context 502；native commands 70，三個舊 commands 不存在；六個 agents／depth 1／ACP 5 tools 與 native Context7 connected。Python import、八個 upstream helpers、兩個 plugin startup 與安全 fixture PNG 成功，model calls 0。

- Image ID：`sha256:2559dd7dc66d04b13595c78e4ab260263aaa8d0537ff8e44fb04bbea6b3c6961`。
- Private manifest SHA256：`5a9cf1b03234cae76750a50806954ee28aaf12e73e7b50e0dced90903f7a951b`。
- Repo compiled-lock SHA256：`fdd00e860693990d8c62547c66b5415b780234a0954c620ed42a4e109cbddfda`。
- Docker owner cleanup **stopped**：container／network／volume／本輪 image tag remaining 全空、errors 全空；image tag 已移除，只保留 image ID 證據與 temp artifacts。

原始完整命令最後 **exit 1**，原因是 raw-byte source comparison：生成的 `packages/launcher/THIRD_PARTY_NOTICES.md` 在執行中由 CRLF（SHA256 `5258ad82ef7fa2871e914bdca82b70d1a6aec61043883a5b6ddc6de4e9bc1fe0`）轉為 LF（`cfc0dcfd04952730041b8b39786bc1573648af5ac0062e72748128ddd7d1a0c2`）。已確認 LF 內容與 HEAD 完全一致，反轉為 CRLF 的 hash 也精確等於 build 前 hash；不是 profile／工具內容改動。不覆寫其他 owner 的檔案、不重跑 full harness，不把此結果寫成 exit 0 或全輸入 byte-identical。原始 `evidence.json` 的 checks-only downstream boolean 不涵蓋這個末尾錯誤；以原始 exit code 及另存 reconciliation 為準，harness 已補 `failure`／sourceChanges 持久化與正確 downstream false。

### 2026-10-07 切換前整合證據（Context7 disabled）

本輪 owner `omw-verify-6d7bbb0bc5cdbaac` 的上述單一完整命令 **10 checks passed**，包括缺 named context 的預期失敗、完整 build、Linux bootstrap、fixture／native API、10 個 toolchain collision cases、version smoke 與 skills／Playwright CLI smoke。native profile 66／全 registry 67 unique、upstream 62／Office 4、compiled assets 489、完整 private context 502 files；profile custom commands 0，native commands 實際 70，舊三個 commands 不在其中。Context7 disabled；model calls 0。

- Image ID：`sha256:c7542a70f41b4a4a7d866970b4761288a056a08145b5d79aae8c1c1546f000a1`。
- Private manifest SHA256：`5a9cf1b03234cae76750a50806954ee28aaf12e73e7b50e0dced90903f7a951b`。
- Safe PNG SHA256：`16372529d6693c972010138358f588ee64cfc35a4df59b497c5198dc6fe2ec06`。
- 本輪 temp directory 的 `evidence.json`、`skills-tools.json`、`fixture.png` 與 bounded logs 保留；Docker owner 的 `cleanup.status: stopped`，container／network／volume／本輪 image tag 的 remaining 均為空。此前 RED runs 也依各自 binding 完成 Stop。

這些 evidence hashes 綁定驗證當時的 dirty source 狀態，並非目前 HEAD 的 commit 證明；source 或 input 改動後需使用新 evidence，不將舊 image digest 當作新內容已通過。

### 原生 shell 的工具查找

固定版 [shell handler](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/session/prompt.ts) 使用 [Shell.preferred／Shell.args](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/core/src/shell.ts)：Linux 預設 Bash 以 `-l -c` 執行，繼承 runtime env，再載入 login profile。Bookworm `/etc/profile` 會重設 non-root PATH，移除 Docker ENV 中的 `/opt/omw-worker/toolchain/*/bin`。因此 image build 將 `java`、`javac`、`mvn`、`gh` 及既有 `officecli` 安裝成 `/usr/local/bin` symlinks，指向固定、root-owned、不可由 node 寫入的 toolchain；任何既有 regular file 或 symlink（包括 dangling）碰撞直接停止，不覆寫 `node`／`git` 或加入 HOME／workspace 到 PATH。

native smoke 透 `POST /session/{id}/shell` 執行 script，script 繼承原生 login shell 的 PATH，沒有 `export PATH`。驗證八項工具 `command -v`／version、JDK 25 compile／classpath run、Maven home／Java runtime、唯讀命令邊界，以及 bootstrap URL-scoped Git helper 透 PATH 找到 gh（只回傳 synthetic fixture 的 boolean）。OfficeCLI 只查 version。固定版 shell 的 multiline `eval` quoting 不適用於多行命令，因此 API 只傳單行 script invocation；這不改變產品 shell 或 env。`--shell-only` 可搭配 `--image` 做舊 image RED，或搭配 `--cache-from` fresh build 做 GREEN；沿既有 Docker current-run owner／獨立有限 watchdog／`finally` cleanup，沒有模型呼叫或真 credentials。

## OfficeCLI 固定版來源

[iOfficeAI/OfficeCLI v1.0.153 release](https://github.com/iOfficeAI/OfficeCLI/releases/tag/v1.0.153) 為 self-contained Linux binary（Apache-2.0）。image owner 在 build 下載並核對：Linux x64 SHA256 `dc1bf7ec9e0bf3ac45c5bd32934842ca2f8939775660526e057642ea68606a80`；Linux arm64 SHA256 `29c2527491331ac7b1ad6ebb4aa5ff9a666f06353675463aae9a832237ef0fda`。CLI upstream LICENSE 由 binary image 一併保留；本 profile 的 Office skills 為原創簡短 help-first wrappers，沒有第三方 skills bundling。
