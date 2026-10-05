# Worker profile 與暫行 auth seed

Bootstrap 在 `execution-server.ts` 中以同程序 `await initializeWorker(process.env)` 執行，先於 supervisor 建立及兩個 listener。Node 仍是 PID 1 或 tini 的直接 child；不可用 npm、shell 或 bootstrap CLI 包住 execution。初始化失敗時 execution 不 listening，不偷偷切換 API key、帳號或重送工作。

這是 #105 的暫行共享帳號能力。每個 Worker 使用私有可寫 OAuth 副本，但 provider grant、配額及帳號權限不是獨立的。此文件的 CLI 測試只用 synthetic credentials；真實 Headless、refresh、多 Worker 與 scratch repository 驗證須另依當輪授權執行。

## Startup hook 與環境契約

| 變數 | 用途／預設 |
| --- | --- |
| `OMW_WORKER_PROFILE_SOURCE` | 可選、absolute readonly curated tree，例如 `/opt/omw/deploy/worker/profile`。未設定就略過 profile copy。image 須預先安裝 config 引用的 ACP；bootstrap 不下載 plugin。 |
| `OMW_WORKER_PROFILE_DIR` | 私有可寫 profile，預設 `$HOME/.config/omw-profile`；image 的 HOME 為 `/home/node`。 |
| `OPENCODE_CONFIG` | 有 profile source 時，bootstrap 設為 `$OMW_WORKER_PROFILE_DIR/opencode.json`；已設定者必須指向同一檔案。 |
| `OPENCODE_CONFIG_DIR` | 有 profile source 時，bootstrap 設為 runtime profile dir，讓全域 AGENTS、skills、commands 可載入；已設定者必須一致。 |
| `OMW_AUTH_SEED_FILE` | 可選、absolute readonly 外部 seed file。不設定就讓 OpenCode 原生首次人工登入。沒有新的 HTTP export／seed API。 |
| `HOME`／`XDG_DATA_HOME` | auth destination 與 OpenCode 相同：`$XDG_DATA_HOME/opencode/auth.json`，未設定 XDG 時為 `$HOME/.local/share/opencode/auth.json`。HOME 必須是 absolute path。 |
| `OMW_GITHUB_TOKEN_FILE` | 可選、absolute readonly PAT file；單行 token，可有一個尾端 newline。讀入記憶體為 `GH_TOKEN`，不寫入 token store。 |
| `GH_CONFIG_DIR` | PAT 模式時保留明示的私有可寫目錄；未設定則用 `$OMW_WORKER_PROFILE_DIR/gh`。不讀取或修改現有 gh credentials。 |
| `GIT_CONFIG_GLOBAL` | PAT 模式時設為 `$OMW_WORKER_PROFILE_DIR/gitconfig`。此 process-scoped 檔案 include 原先的 `GIT_CONFIG_GLOBAL`，未設定時 include `$HOME/.gitconfig`；只設定 `https://github.com` 的官方 `!gh auth git-credential` helper，不設定 Git user identity。 |

`supervisor.ts` 的 child environment allowlist 必須保留 `OPENCODE_CONFIG`、`OPENCODE_CONFIG_DIR`、`GH_TOKEN`、`GH_CONFIG_DIR`、`GIT_CONFIG_GLOBAL`；保留既有 HOME/XDG allowlist，不把 `OMW_*_FILE` 或 manager secrets 傳給工具。image 必須保留 `/opt/omw/scripts/worker/bootstrap.mjs`（repo 對應路徑為 `scripts/worker/bootstrap.mjs`），source 與編譯後 `dist/src` 啟動都由 execution hook 解到 repo/image root。

## Profile 升級

Bootstrap 複製完整 curated source tree，包括 `opencode.json`、`AGENTS.md`、skills、commands 等 regular files；來源可唯讀。拒絕 symlink、來源／runtime 重疊及原生全域 `$XDG_CONFIG_HOME/opencode`（預設 `$HOME/.config/opencode`）重疊。

Runtime 的 `.omw-source-manifest.json` 格式版本為 1，記錄上次完成 reconciliation 的各 curated source file SHA-256。每次 execution startup 重新計算 source hash，依以下規則保留使用者內容，不遞迴刪除 runtime 目錄：

- Runtime 內容已等於目前 source 時直接接受，包括操作者完全合併或上次 partial upgrade 後 manifest 尚未更新的情況；重試可繼續更新其餘檔案。
- Runtime 仍等於 manifest 記錄的 prior source 時，可原子更新到新版 source。只有 runtime 修改、source 未改時保留 runtime；兩邊都改且內容不同則 fail closed，不覆寫使用者內容。
- Manifest 沒有 provenance 的同名 runtime 檔案，若與新增 source 內容不同也 fail closed；cache／自訂新增檔案不因新版 source 出現同名檔案就被覆蓋。
- Source 移除檔案時，只刪除仍等於 prior source 的 runtime file；已修改者保留，並在成功 reconciliation 後移出 manifest。Source 日後重新加入同名檔案時，仍套用未追蹤檔案的碰撞保護。

分歧時固定錯誤訊息要求操作者備份並明確合併，不輸出檔案內容、hash 或原始 filesystem 錯誤。先停止 execution、備份自訂修改；需要保留的變更合併回版本化 curated source／image，再讓同名 runtime file 與新版 source 內容一致後重新啟動。每個 file 原子更新，但整個 tree 不是多檔 transaction；失敗前已完成的 file 更新會保留，manifest 只在全部 reconciliation 成功後更新，重試接受已完成的相同內容。

`auth.json`、manifest、bootstrap 的 `gitconfig`／`gh` 名稱保留，不允許放進 curated source。Profile reconciliation 不讀 auth、不碰既有 `$HOME/.config/opencode` 全域設定，也不更新 seed。更新 image/source 後重建 execution 容器，下一次 startup reconcile 生效；不是 live reload。需要 writable plugin cache 的項目留在自己的 runtime profile。

## Auth seed：只在私有副本缺少時初始化

1. 先 `lstat` auth destination。已有 regular private file 時略過 seed；即使 seed 已移除、失效或不可讀也不讀它，不解析既有 auth，更不覆蓋最新 refresh。
2. Destination 缺少時才讀 seed，要求完整 provider-map JSON，且 `openai.type` 必須是 `oauth`。`access`、`refresh` 為非空字串，`expires` 為非負整數；保留 `accountId` 等資訊及其他合法 OAuth／API／wellknown entries，完整複製，不抽出單一 token。`expires: 0` 可讓 OpenCode 正常 refresh，不代表 bootstrap 能驗證 provider grant 仍有效。
3. 先寫同目錄 private temporary file、sync，再用 hard-link no-replace publish；併發者不覆寫 winner，也不出現半份 auth。正常完成後清除 temporary file。目的 filesystem 須支援同目錄 hard links；不支援就 fail closed，沒有覆寫式 fallback。Interrupted startup 可能留下 `.omw-bootstrap-*.tmp`；Stop execution 後，操作者只清理該次 scoped temporary artifact。
4. File 為 `0600`、直接 parent 為 `0700`，且是 execution UID 擁有；拒絕 symlink／非 regular destination、非 owner 或 insecure existing permissions，不自動 chmod 既有資料。新建目錄使用 `0700`，不改既有祖先目錄的 permissions。先人工登入所建立的 auth 若權限較寬，操作者應只對自己擁有的該檔與直接 parent 做 `chmod 600`／`chmod 700`，再選用 seed 模式。
5. OpenCode 持續 refresh／更新自己的 auth；不回寫 seed，不同步其他 Worker。缺少或 invalid configured seed 時，輸出固定、不含秘密內容／hash／原始檔案錯誤的訊息，execution 不啟動。Provider 後續拒絕 refresh 時依 OpenCode 原生提示重新登入，bootstrap 不做遠端驗證或 auth fallback。

Windows 本機 synthetic tests 可驗證原子檔案與 no-overwrite 行為；POSIX `0600/0700` 的 enforcement 及 auth file symlink case 必須在 Linux 驗證，不能用 Windows mode 結果宣稱通過。

## Opt-in Compose

Base `deploy/worker/compose.yaml` 的命令與 `execution-home`／workspace persistent defaults 保留。只有選用 override 時才要求 auth seed；PAT 不會成為 ChatGPT-only 使用者的必填設定。

操作者在版本庫外的受保護路徑準備完整 seed，並設定 `OMW_AUTH_SEED_SOURCE`（是 filepath，不是 token 值）；沿用 base 的 execution token、browser password 等設定：

```sh
docker compose -f deploy/worker/compose.yaml -f deploy/worker/compose.seed.yaml up -d
```

`auth_seed` 由 Compose readonly secrets 掛到 `/run/secrets/auth_seed`。外部 host file 必須讓 execution UID 1000 可讀；一般 Compose file-backed secrets 的 UID/mode 受 bind mount 行為限制，不假設 override 自動替來源套用 permissions。不要把 seed 放進 Git、image、remote URL 或一般 log。

如另外需要 PAT，在版本庫外建立自己的 `compose.github.yaml`，只額外設定 execution 與 `github_pat`：

```yaml
services:
  execution:
    environment:
      OMW_GITHUB_TOKEN_FILE: /run/secrets/github_pat
    secrets:
      - github_pat
secrets:
  github_pat:
    file: ${OMW_GITHUB_TOKEN_SOURCE:?請指定版本庫外受保護的 PAT file}
```

使用者明確選用此檔時才要求 PAT：

```sh
docker compose -f deploy/worker/compose.yaml -f deploy/worker/compose.seed.yaml -f /protected/compose.github.yaml up -d
```

PAT-only 也可只合併 base 與外部 GitHub override，不合併 auth seed override。PAT 使用核准的 scratch repository，限定必要的 Contents／Issues／Pull requests 權限。使用普通 HTTPS remote URL，不執行 `gh auth login --with-token` 或 `credential-store`；`GH_TOKEN` 本身可供 gh 與 credential helper 使用。owner 自行設定 author identity，bootstrap 不指定 Git name/email。

## 操作者明確 export／更新 seed

首次不選用 seed override，於第一個 Worker 完成 OpenCode 原生 Headless 登入。為避免額外 `docker exec` 程序干擾 supervisor namespace ownership，先以 OMW Stop 該 Instance，再停止 execution container。確認 auth 已寫完、私有 permissions 正確後，使用相同固定 image 的**離線 one-off 容器**，readonly 掛入該 Worker 自己的 execution-home volume，另外掛入版本庫外的 private 可寫 export directory；不得直接讀宿主機既有 provider credentials。沿用相同 HOME/XDG 與 execution UID，明確執行：

```sh
node /opt/omw/scripts/worker/bootstrap.mjs --export-auth-seed /protected-export/auth-seed.new.json
```

這個 export CLI 不啟動 execution／listener，不載入 profile、不讀 PAT，也不做網路請求；只有此明確 export flow 會讀當前 auth。目的 file 必須不存在；命令只輸出 `{"exported":true}`，不輸出內容或 hash。One-off 容器依操作者當輪 ownership／bounded cleanup 執行，保留原 auth volume，結束後移除該 one-off 容器，不使用 `down -v`。

更新 seed 時先匯出到新的檔名，核對成功後由操作者在受保護來源目錄切換引用。不要用終端 `cat` 顯示秘密。Worker 已有 auth 時更新 seed 不會替換自己的副本；只對新建的私有工作資料生效。需要重新登入現有 Worker 時，由操作者明確處理該 Worker 的 auth，不批量刪除含真實 auth 的 volume。#102 才驗收實際 NFS／emptyDir；此模式沒有建立 NFS 或 Secret 回寫機制。

## Synthetic CLI 驗證

```sh
node --test scripts/worker/bootstrap.test.mjs
npm run build -w @omw/manager
npm run typecheck -w @omw/manager
```

測試只建立 scoped temp HOME/XDG/profile/seed，使用 public bootstrap CLI 的檔案效果及 subprocess 回傳的非秘密 env booleans；每個 fixture `finally` cleanup。涵蓋 absent seed、完整 readonly source、HOME/XDG、restart 不讀 seed、12-way race、invalid scalar／OAuth 欄位、private mode、symlink/junction、錯誤 redaction、profile source 更新與 runtime extras、PAT memory／helper 以及明確 export no-overwrite。它們不代表真實 provider／GitHub／Docker／Linux image 驗收。

## Bounded seed／雙 Worker 驗收

在 Windows worktree root 執行 `scripts/worker/verify-seed-workers.mjs`。使用明示的本機 Docker context；預設建立兩個獨立 Compose projects，每個恰好 manager／execution 兩個服務，合併 base 與 `compose.seed.yaml`。未加 `--allow-provider` 時只使用 synthetic seed、不送模型 prompt；真實 seed 必須先獲當輪授權。

先由操作者設定 `$ApprovedOwnerRecord`、`$ApprovedSeedVolume`、`$ApprovedAuthPath`，分別為版本庫外 owner JSON、該 record 記錄且本輪批准的 volume exact name，以及 volume root 下的 auth absolute path。不要輸入 token 值，也不要由其他帳號或 host 的 OpenCode auth 尋找 fallback：

```powershell
node scripts/worker/verify-seed-workers.mjs --context desktop-linux `
  --allow-provider --seed-owner-record "$ApprovedOwnerRecord" `
  --seed-source-volume "$ApprovedSeedVolume" --seed-auth-path "$ApprovedAuthPath" `
  --temp-root "C:/Users/rhys/AppData/Local/Temp/opencode"
```

若已有操作者明確匯出的完整 seed，改用 `--allow-provider --seed-source "$ApprovedSeedFile"`。此 file 必須是版本庫外 absolute path。`--image "$VerifiedImageId"` 可重用已核對的當前 worker image；省略時在本機 build `worker` target，不 publish image。

Harness 以 readonly、無網路 one-shot 讀指定 source volume，複製至本輪 Linux private snapshot，再呼叫現有 bootstrap export；以 exclusive 新檔名存入有私有 Windows ACL 的 temp directory。此 snapshot 避免 Windows bind mount 與舊來源的 Unix parent permissions 差異，並不修改來源權限。原始來源與匯出的 full provider map 必須相同；來源／seed 未改變的 digest 比較只在 private fixture 中進行，evidence 僅記 booleans。原始 source volume、來源 auth 與所有既有版本保留。

### 驗收內容與判讀

- Execution 尚未 live 時，one-shot 初始化每個私有 auth、合成 workspace 與不同 marker；只把**本輪私有副本**的 `openai.expires` 設為 `0`，記錄為人工過期，讓固定 OpenCode `1.18.34` 自己 refresh。這不是自然 expiry 驗收。
- 經 OMW API 各建立新的 Instance／primary session，核對 Basic gates、版本、不同 session IDs、peer session／marker 不存在，以及三種 persistent volumes 不共用。全程不對 live execution 使用 `docker exec`。
- 只擷取 provider 的 connected、指定 model ID 存在／identity 相符、API target 同 Luna 家族及 SDK 分類；模型固定為 `openai/gpt-6-luna-fast`，不新增 alias、fallback 或換帳號。原生 preset 的 canonical API ID 可與 preset 字串不同，仍送出指定 OpenCode model ID；跨家族 target（例如 Terra）會被擋下。兩個 Worker 各送一次無工具 prompt，預期 `WORKER_A_OK`／`WORKER_B_OK`。停用 title／summary、compaction 與全部工具；首個 native retry event 即經 native API abort，不自行重送。
- 工作完成後先 OMW Stop、停止 execution，再以離線 one-shot 核對 auth `0600`、parent `0700`、UID、不同 inode/device 及 token／expiry 變更 booleans。只重啟 execution，確認自己的 session 與 private auth 留存；manager 不重啟、restart 不追加 prompt。
- 只有兩次固定回覆、兩次原生 refresh 與重啟後保留都通過，才可報 seed／雙 Worker 部分通過。Metadata 有模型不等於真 prompt 成功；auth refresh 被拒絕也不能當成模型不存在。沒有成功 refresh 時，只能證明原私有副本被保留，不能宣稱「最新 refreshed auth 未被 stale seed 覆蓋」。PAT／scratch Git、gh 是另一項驗收，未提供 PAT 時明確列為未測。

每輪 unique run ID 及 ownership labels、25 分鐘 watchdog、HTTP／Docker operation deadlines 綁定 `owner.json`／`binding.json`；`finally` scoped Stop 移除該輪 containers／networks。**所有 volumes、真實 auth、seed files 與 image 保留，禁止 `down -v`。** `owner.json`、sanitized `evidence.json` 與 `proof-ready.md` 全部位於本輪版本庫外 temp directory；不公開 credentials、provider body、hash、claims、account ID 或 private URL。

`--resume-owned "$StoppedOwnerRecord"` 僅適用同一來源、同一 worktree、已確認 Stop 且尚未提交任何 prompt 的本輪 owner；它重用原 seed version，不覆寫來源、不重新匯出。已有 prompt 的 run 禁止 resume，以免突破每 Worker 一次的預算。遇到 provider 拒絕，先保存 partial evidence，完成其他不需 LLM 的檢查，不試其他 seed／模型。

### Provider 要求重新登入時

建立新的無 seed 環境，不自動開始 OAuth、不抓 code：

```powershell
node scripts/worker/verify-seed-workers.mjs --context desktop-linux `
  --prepare-login --image "$VerifiedImageId" `
  --temp-root "C:/Users/rhys/AppData/Local/Temp/opencode"
```

成功後 disposition 為 **Preserve**，later owner 為主 agent／使用者；private `owner.json` 記錄 `loginReadyUrl`、browser `passwordFile`、精確 resource identity 與 later Stop。操作者由該 URL 開啟 native primary，以 `worker` 登入，再於原生 Providers 選 OpenAI／ChatGPT Headless，依 UI 完成人工登入。Code、token 不貼到 evidence 或一般 terminal output。

完成後先透過 OMW Stop Instance，再在 worktree root 執行 owner 記錄的 scoped Stop：

```powershell
node scripts/worker/seed-worker-owner.mjs "$PrivateBindingFile" --stop
```

Stop 的結果寫到該 owner 的 `watchdog-cleanup.json`；須確認 `cleanup.status` 為 `stopped` 且 containers／networks 為空。所有 auth／workspace／manager-data volumes 保留。之後依前節 export 流程，readonly 掛入**這個新登入環境**的已停止 volume，以相同固定 image 匯出新的 exclusive seed 檔名；下一輪雙 Worker prompt 需沿用當輪明確授權，不重用已耗盡 prompt budget 的 run。
