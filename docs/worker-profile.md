# 精選 Linux Worker profile

本文件是 [#105](https://github.com/Sevenflanks/opencode-manager-web/issues/105) 的 image 契約與 [#108](https://github.com/Sevenflanks/opencode-manager-web/issues/108) 的完整 skills／Linux 全域指引整合契約。規則依本輪已確認需求投影；沒有複製宿主 credentials、私人 URL 或整份 model／permission 設定。

## Inventory

| 納入 | 來源／用途／依賴 |
| --- | --- |
| `profile/opencode.json` | OpenCode **1.18.34**，`/bin/bash`、本機 ACP plugin、absolute instructions／skills、單層 task 與最小權限；`compaction.auto: false`、`autoupdate: false`；不指定日常模型 |
| `profile/acp.json` | Active Context Pruning **opencode-acp@1.18.3**，enabled，autoUpdate false |
| `profile/AGENTS.md` | 最小範圍、明確授權、zh-TW、worktree 保留、委派／驗收、秘密、Linux process owner 與工具可用性 |
| `profile/agents/*.md` | `general`、`general-simple`、`general-complex`、`verifier`、`explore`、`scout`，可被原生 `task` 呼叫；都不指定 model，不遞迴委派 |
| `profile/references/skill-routing.md` | 依觸發條件指向來源同名 skill，不複製流程或固定 handoff 格式 |
| 完整 source bundle | **62** 個 selected skill roots（60 個指定＋`web-design-guidelines`＋`pr-review-remake`），含 references／scripts／templates／metadata；固定來源與 private artifact 契約見 [worker-skills-bundle.md](worker-skills-bundle.md) |
| `officecli`、`officecli-docx`、`officecli-xlsx`、`officecli-pptx` | 原創 help-first skills；依 OfficeCLI **v1.0.153**；沒有複製第三方技能全文 |
| Context7 public MCP | 官方 public remote `/mcp`，無 headers、`oauth: false`、**預設啟用**，匿名 read-only docs 查詢；協定與 Worker 連線證據見下節 |
| ACP plugin dependencies | `acp/package.json` 及完整 `package-lock.json`，直接固定 `@opencode-ai/plugin`／`sdk` **1.18.34**；esbuild **0.25.10** 只在 build 使用 |

完整 bundle 與四個既有 Office wrappers 組成 **66** 個 profile registry names；原 `development-test`、`git-github-workflow`、`linux-process-lifecycle` source 與三個 curated commands 由 image／bootstrap owner 移除。全域指引不再要求載入它們。`agent-process-lifecycle`、`self-challenge` 不納入。OpenCode 內建 commands／auth plugin 與 ACP `/acp` 仍由各自 owner 提供；profile **沒有 custom commands**。

ERP／Mantis／Jenkins／Kibana／Kubernetes 技能流程納入 bundle，但登入整合、credentials 與服務可用性另行核對。沒有帶入 Windows shell／IDE／桌面、宿主 history／deja／memory 強制依賴、Manager heartbeat、OMO、session-memory 或宿主 handoff 服務。工具 image 提供 non-root Linux、Node 24／npm、Git／gh、JDK 25／Maven、Python、curl、CA、SSH client、shell、搜尋、JSON、解壓與 timeout；精確 patch versions／來源／checksums 由 image inventory 記錄。browser／fonts／PDF exporter 不因載入 skill 自動具備。

## 原生 agent、model 與權限

`OPENCODE_CONFIG_DIR` 讓原生 loader discovery `agents/*.md`；不要用 commands wrapper 模擬 role。`general` 是預設實作選擇，simple／complex 依問題風險與不確定性選擇；`verifier` 做細部檢查／已授權 tests，`explore` 定位 repo，`scout` 查官方外部資料。主 agent 總驗收。全部 subagents 的 `task: deny` 加上 `subagent_depth: 1` 避免遞迴；`plan` 另外禁止委派三個實作 roles。

唯讀 roles 以 `permission["*"]: deny` 作底，按實際 native tools 開啟 read／glob／grep／list／skill／文件查詢；edit（涵蓋 write／apply_patch）與 task 明確 deny。`explore`／`scout` 的 bash deny；`verifier` 的 bash ask，允許 caller 明確授權的測試衍生 artifact，不允許透 shell 修改 source 或繞過 edit 禁止。未知 plugin／MCP tools 維持 deny，Context7 tools 需 ask。這是工具 gate 加行為契約，**不是 OS sandbox**；shell 的 ask 不等於任意命令已獲授權。

全域保留 `bash: ask`、`external_directory: ask`、`doom_loop: ask`，並以 `context7_*: deny` 先封閉其他 Context7 tools，再精確 allow read-only `context7_resolve-library-id`／`context7_query-docs`；名稱依 [1.18.34 MCP catalog](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/mcp/catalog.ts) 的 server prefix／sanitize 規則，保留 hyphen。唯讀 subagents 仍依自己的 Context7 ask gate 取得 caller 核可。保留 runtime 其他原生邊界，不搬整份宿主 permission 或 `external_directory: "allow"`。read roles 延續 env 檔案 ask，example 可以 read；不是全面秘密掃描防線，資料範圍仍依明確授權。

`model`、`small_model`、`default_agent` 與各 role 的 model／variant 均刻意省略。固定版 `task` 對未指定 model 的 role 使用 caller 當前模型。**這不是已複製宿主成本／算力配置**：角色命名只分任務，各 role 不因 simple／complex 就自動有價差。使用者可在自有 non-versioned overlay 設定合法 provider／model／variant；不要用不存在的 resource-control key 製造差異。普通 global 或 project overlay 仍會影響 effective config，敏感 credential 維持外部管理。

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
| build stage `COPY deploy/worker/profile` ＋必要 `worker-skills` named context | `skills-profile` stage audit 完整 provenance／hash／references，再將 62 個完整 roots 與 Office 4 合併；image source `/opt/omw/deploy/worker/profile` 包括 AGENTS、agents、references、skills、acp.json、opencode.json，bootstrap 複製至 `/home/node/.config/omw-profile/` |
| 完整 `dist/` 複製至 `/opt/omw-worker/acp/` | plugin 固定 `file:///opt/omw-worker/acp/acp.mjs`；保留 WASM、licenses、source、metafile／inventory |
| package／lock／production `node_modules/` 複製至 `/opt/omw-worker/acp/` | bootstrap 複製可寫 package／lock 至 runtime profile **及普通 global config directory**，兩者 `node_modules` 連到 image 唯讀 `/opt/omw-worker/acp/node_modules`；不遞迴複製 npm `.bin` symlinks，不覆蓋普通 global 的 opencode.json／AGENTS 等使用者設定 |

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

保持正常 `HOME=/home/node`、XDG config 預設 `/home/node/.config`。普通 global 是 `/home/node/.config/opencode`；不要把 `XDG_CONFIG_HOME` 改成 runtime profile。若部署更換 HOME／XDG，整合者須一致重寫 profile 內的 absolute instructions／skills 路徑與上述契約。

`OPENCODE_CONFIG` 是新增一層設定，保留 ordinary global merge；`OPENCODE_CONFIG_DIR` 另外讓 agents、skills 及 ACP 的 acp.json 被 discovery。各層會 merge，profile directory 也會再載入；驗證要檢查實際 effective config，而非只讀來源檔案。profile 不設 model／provider credentials，也不清空使用者其他 MCP；同名 Context7 template 受上述 precedence 影響。

**OpenCode 1.18.34 特有 initialization：**每個可寫 config directory 都檢查 `@opencode-ai/plugin`。有 node_modules 且 package-lock root 包含所有 package.json 宣告及 @plugin 名稱才跳過安裝；因此 fresh Worker 的 ordinary global 與 runtime profile 都需上述 build-prepared package＋lock＋node_modules。專案自行提供 `.opencode/` 或其他 dependencies 時另按該專案的 build／授權處理；不能把額外任意 plugins 可離線啟動寫成保證。

既有 volume 的完整 package／lock／dependencies 與固定 `@opencode-ai/plugin@1.18.34` 相符時原樣保留；不完整或不相容時以固定 `OMW_WORKER_DEPENDENCIES_SOURCE` 錯誤停止，需先準備離線依賴，不覆寫使用者宣告或在 startup 下載。ordinary global 既有目錄權限也保留。profile restart 保留使用者改過的 managed files；source 升級同時碰到使用者修改且內容不同，或新 source 檔案與未追蹤同名 runtime 檔案碰撞時，以固定安全訊息停止，交由操作者備份並明確合併。Runtime 已等於新版 source 時接受，因此完全合併或 partial upgrade 後可重試；source 移除的已修改檔案保留且移出 manifest，重新引入仍受碰撞保護。完整規則見 [Profile 升級](worker-auth-seed.md#profile-升級)。

來源維持唯讀；工作副本、cache、ACP state 由 node 使用者可寫。ACP 預設 state 在 `$XDG_DATA_HOME/opencode/storage/plugin/acp`，log 在普通 global 的 `logs/acp`；不共用多 Worker 的可寫 state。不要將整個 configdir 唯讀掛載使初始化失敗。auth seed 不在 profile 內，也不在此設定流程讀取；auth 初始化／private OAuth／PAT 依另一切片的明確授權契約。

### 為什麼不用相對 instructions／skills

已直接核對 OpenCode [v1.18.34 skill loader](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/skill/index.ts)、[instruction loader](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/session/instruction.ts)、[config loader](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/config/config.ts)、[npm initialization](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/core/src/npm.ts)：`skills.paths` 相對值依 project directory；相對 instructions 從 project cwd 向上找，不是依 OPENCODE_CONFIG 所在目錄。選用固定 runtime absolute paths，讓不同 repository 都載入同一 profile；plugin 也採 absolute local file URL。

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

檢查本切片使用的固定版 config／frontmatter 形狀、absolute 路徑、來源 skill 路由與 references、model／credential 省略、唯讀與單層委派 gate；agent frontmatter 使用 YAML 可接受的 JSON 子集，靜態檢查不需增加 parser dependency。以 synthetic mutations 驗證未知 key、unsafe permissions 與漏失引用會被拒絕。它是 **static policy subset**，不是完整 OpenCode schema decoder，也不證明 native discovery、MCP 連通、66 個 skill 載入或真實模型流程。原生完整 image 載入由主 agent 的整合節點驗收。

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

Native API routes 與 tool IDs 已核對固定版 **1.18.34 SDK**：`/experimental/tool/ids`、`/config`、`/skill`、`/command`、`/agent`、`/mcp`。Harness 驗證五個 ACP tool IDs、**66** 個 profile skill names／description／absolute location、全部 489 compiled assets 的 hash、六個 subagent roles、有效 permission rules 的 task deny／plan 實作委派 deny、`subagent_depth: 1` 與原生 `/acp`，並確認三個 curated commands／舊三個 source skills／兩個 excluded skills 未載入。fresh scratch 的 native registry 實際另含內建 `customize-opencode`，共 **67 unique names**；profile 仍精確為 62＋4，不以全 registry 等於 66 否定內建項目。commands 也允許 OpenCode／ACP 自有項目，不要求 total 0。permission／HTTP 是 native config 生效證據，**不是已執行真實 LLM task 或遞迴委派的證據**。

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
