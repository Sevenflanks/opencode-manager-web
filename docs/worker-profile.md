# 精選 Linux Worker profile

本文件是 [#105](https://github.com/Sevenflanks/opencode-manager-web/issues/105) 的非秘密 profile 與 image 整合契約。profile 全新撰寫，沒有讀取或複製宿主機私人設定。

## Inventory

| 納入 | 來源／用途／依賴 |
| --- | --- |
| `profile/opencode.json` | OpenCode **1.18.34**，`$schema`、本機 ACP plugin、instructions、skills；只設 `compaction.auto: false`，沒有額外 prune flag；不指定日常模型 |
| `profile/acp.json` | Active Context Pruning **opencode-acp@1.18.3**，enabled，autoUpdate false |
| `profile/AGENTS.md` | 原創精選 Linux 規則：worktree、授權、秘密、真實驗證、skills 路由 |
| `development-test` | repository checks、bounded tests、真實模型測試規則；依專案工具 |
| `git-github-workflow`、`git-commit-co-author` | Git／gh／Issue／PR 流程與 scoped attribution；依 Git、gh、HTTPS credential helper |
| `linux-process-lifecycle` | Linux ownership、timeout、scoped cleanup；依 coreutils timeout、shell／runtime owner |
| `officecli`、`officecli-docx`、`officecli-xlsx`、`officecli-pptx` | 原創 help-first skills；依 OfficeCLI **v1.0.153**；沒有複製第三方技能全文 |
| `/task-plan`、`/verify`、`/deliver` | 規劃、驗證、明確授權交付；不 shadow ACP `/acp`、`/dcp` 或 `compress` tool／既有 `/compress` |
| ACP plugin dependencies | `acp/package.json` 及完整 `package-lock.json`，直接固定 `@opencode-ai/plugin`／`sdk` **1.18.34**；esbuild **0.25.10** 只在 build 使用 |

沒有新增 MCP server。OpenCode 內建 skills／commands／auth plugin 仍由 OpenCode 提供。
排除：Windows／PowerShell／桌面自動化與私人 prompts、deja／durable-memory 強制依賴、ERP／Mantis／Jenkins／Kibana／Kubernetes 登入整合及 credentials、額外 Office 產品子類技能、browser／fonts／PDF exporter。工具 image 提供 non-root Linux、Node 24／npm、Git／gh、JDK 25／Maven、Python、curl、CA、SSH client、shell、搜尋、JSON、解壓與 timeout；精確工具 patch versions／來源／checksums 由 image inventory 記錄。

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
| `COPY deploy/worker /opt/omw/deploy/worker` | source `/opt/omw/deploy/worker/profile` 完整複製至 `/home/node/.config/omw-profile/`，包括 AGENTS、commands、skills、acp.json、opencode.json |
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

`OPENCODE_CONFIG` 是新增一層設定，保留 ordinary global merge；`OPENCODE_CONFIG_DIR` 另外讓 commands 及 ACP 的 acp.json 被 discovery。後續 project config 仍可能 override，驗證要檢查實際 effective config，而非只讀來源檔案。profile 不設 model／provider credentials／MCP，不清空使用者的 model 或 MCP。

**OpenCode 1.18.34 特有 initialization：**每個可寫 config directory 都檢查 `@opencode-ai/plugin`。有 node_modules 且 package-lock root 包含所有 package.json 宣告及 @plugin 名稱才跳過安裝；因此 fresh Worker 的 ordinary global 與 runtime profile 都需上述 build-prepared package＋lock＋node_modules。專案自行提供 `.opencode/` 或其他 dependencies 時另按該專案的 build／授權處理；不能把額外任意 plugins 可離線啟動寫成保證。

既有 volume 的完整 package／lock／dependencies 與固定 `@opencode-ai/plugin@1.18.34` 相符時原樣保留；不完整或不相容時以固定 `OMW_WORKER_DEPENDENCIES_SOURCE` 錯誤停止，需先準備離線依賴，不覆寫使用者宣告或在 startup 下載。ordinary global 既有目錄權限也保留。profile restart 保留使用者改過的 managed files；source 升級同時碰到使用者修改且內容不同，或新 source 檔案與未追蹤同名 runtime 檔案碰撞時，以固定安全訊息停止，交由操作者備份並明確合併。Runtime 已等於新版 source 時接受，因此完全合併或 partial upgrade 後可重試；source 移除的已修改檔案保留且移出 manifest，重新引入仍受碰撞保護。完整規則見 [Profile 升級](worker-auth-seed.md#profile-升級)。

來源維持唯讀；工作副本、cache、ACP state 由 node 使用者可寫。ACP 預設 state 在 `$XDG_DATA_HOME/opencode/storage/plugin/acp`，log 在普通 global 的 `logs/acp`；不共用多 Worker 的可寫 state。不要將整個 configdir 唯讀掛載使初始化失敗。auth seed 不在 profile 內，也不在此設定流程讀取；auth 初始化／private OAuth／PAT 依另一切片的明確授權契約。

### 為什麼不用相對 instructions／skills

已直接核對 OpenCode [v1.18.34 skill loader](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/skill/index.ts)、[instruction loader](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/session/instruction.ts)、[config loader](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/config/config.ts)、[npm initialization](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/core/src/npm.ts)：`skills.paths` 相對值依 project directory；相對 instructions 從 project cwd 向上找，不是依 OPENCODE_CONFIG 所在目錄。選用固定 runtime absolute paths，讓不同 repository 都載入同一精選 profile；plugin 也採 absolute local file URL。設定形狀另以 [published schema](https://opencode.ai/config.json) 與 Context7 官方文件交叉核對。

## 使用與升級

- `/task-plan <需求或 Issue>` 整理計畫；`/verify <範圍>` 執行最小 checks；`/deliver <已明確授權的操作>` 整理證據或執行指定交付。技能也可由 OpenCode `skill` tool 載入。
- ACP 使用原生 `/acp`，不新增替代壓縮 command；工具預期 `compress`、`decompress`、`search_context`、`acp_status`、`acp_context_recap`。OpenCode 的內建 `/compress` 與 ACP tool 不是同一個命名空間；profile 不覆寫它們。
- 修改版本化 profile，重建固定 image，先以全新 non-secret scratch 完成下列驗證。升級保留使用者本輪修改、ordinary global、auth 與其他 Worker 的 state；source 與工作副本同時改動時由操作者合併，不在 restart 盲目覆蓋。
- 更新 ACP／OpenCode 時同步改 manifest／lock、source revision＋checksum，重新 build 並驗證原生載入。記錄 image digest、版本與檢查結果。設定／skill／command 是 config-time load，**退出並重新啟動 OpenCode** 才生效。

## 最小 public smoke（image owner 執行）

不以 mock 證明 ACP 載入。Windows host 在 repository root 執行整合 harness；它使用 fresh non-secret scratch、public synthetic PAT fixture，不掛 auth／host config，所有 smoke containers 均為 `--network none`。每個 namespace 由直接 Node／tini child 持有；本輪 project label、bounded lifetime、獨立 watchdog 與 `finally` cleanup 綁定官方 Docker ID／label。sanitized `evidence.json` 記錄 image ID、版本、API counts 與 cleanup，位於 worktree 外 temp directory。

```sh
node scripts/worker/verify-profile.mjs --context desktop-linux
# 可重用固定版 toolchain cache：--cache-from <toolchain-tag>
# 指定現存固定 image 重跑 smoke：--image sha256:<image-id>
```

Native API routes 與 tool IDs 已核對固定版 source／SDK：`/experimental/tool/ids`、`/config`、`/skill`、`/command`。API 配置只看 plugin 字串不足以證明載入；五個 tool IDs、八個 skills、三個 curated commands 與原生 `/acp` 同時存在才是此 smoke 的實際證據。fixture slice 另外檢查 child env allowlist、GH／Git helper process-scoped availability、禁止的 manager／seed 變數、runtime customization／ordinary config 保留與固定失敗訊息。Linux bootstrap 預期 **20 passed、0 skipped**；其中新增四例驗證完全合併、未追蹤碰撞、partial upgrade 重試與移除後重新引入。

同一 image 另執行 bounded toolchain version smoke，包括 OpenCode **1.18.34**、JDK／Maven 與 OfficeCLI **1.0.153** 的 version／help；不生成 Office 文件、render、截圖或 PDF。不呼叫模型、不驗證真實對話壓縮效果，也不要求空 Session 產生 ACP state file。未來真實模型測試預設 **openai/gpt-6-luna-fast**；指定模型不可用即 blocker，不 fallback；這不是日常 model 設定。

## OfficeCLI 固定版來源

[iOfficeAI/OfficeCLI v1.0.153 release](https://github.com/iOfficeAI/OfficeCLI/releases/tag/v1.0.153) 為 self-contained Linux binary（Apache-2.0）。image owner 在 build 下載並核對：Linux x64 SHA256 `dc1bf7ec9e0bf3ac45c5bd32934842ca2f8939775660526e057642ea68606a80`；Linux arm64 SHA256 `29c2527491331ac7b1ad6ebb4aa5ff9a666f06353675463aae9a832237ef0fda`。CLI upstream LICENSE 由 binary image 一併保留；本 profile 的 Office skills 為原創簡短 help-first wrappers，沒有第三方 skills bundling。
