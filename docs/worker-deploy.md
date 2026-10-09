# Worker 本機 operator 更新

先執行無參數 CLI，確認操作介面：

```powershell
node scripts/worker/deploy.mjs
node --test scripts/worker/deploy.test.mjs
```

本輪交付 **已發布 image digest 的 release gate → plan → deploy → status**。Node 24、現有 `gh`／Docker Buildx／kubectl／npm 即可，不新增 dependency。build／publish 是下方獨立的人工流程，CLI **尚未自動化**這兩階段；也沒有聲稱替人工流程提供自動 source hash／tag 防覆寫保護。

## 1. 身分與權限決策

使用本機 operator。SLKE 的 `oidc@slke` 需人類互動登入，目前沒有授權 CI service identity，因此不把個人 kubeconfig、token cache 或 registry credentials 搬到 GitHub Actions。腳本不讀 kubeconfig／credential helper 設定、不登入 registry、不修改 RBAC、TLS 或 kubeconfig。它讓各官方 CLI 沿用操作者既有認證。

需要的 Kubernetes 權限限於 `ai-tools`：

| 操作 | 資源／用途 |
| --- | --- |
| `get` | 指定 Deployments：`omw-beta`、`omw-alpha`、`omw-gateway` |
| `patch` | 僅 `omw-beta`、`omw-alpha` Deployment；namespace scoped、可用 `resourceNames` 限定 |
| `list`／`get` | Pods／ReplicaSets：證明 Deployment → RS → Pod owner UID；不採名稱 prefix |
| `create` on `pods/exec` | 一次性 Node readonly inspection；不需 Secret API |

**`pods/exec` RBAC 本身無法限制成只讀 GET、指定 Node 程式或指定 container。** 此腳本收窄命令不等於 RBAC 收窄所有可執行命令；仍須可信 operator 與 namespace 維運授權，不授予 CI／一般使用者。現有權限不足由平台核准，不由腳本提權。不需要 Secret、PVC/PV、Ingress、Service、NetworkPolicy、namespace create/delete 或 cluster-admin。上述是需求清單，不是已套用的 Role。

缺少有效 OIDC session 時，先由人類依平台既有方式互動登入，再重新 plan。kubectl exec plugin 可能啟動瀏覽器；command timeout 不代表 plugin／browser descendants 已退出。腳本只記本次直接 producer PID（若有）與 `descendantExitVerified:false`，保留 unresolved，不掃描／強殺整機程序。外層 shell tool timeout 也不是 cleanup。

## 2. 準備 image 與 release 證據（人工 build／publish）

這節供已取得 build／registry publish 授權的 operator 執行。**不操作 Kubernetes。** 所有範例 host 都是 generic，請使用自己的私有目標。私有 skills context、reports 與 journal 放 checkout 外受限 ACL 目錄；POSIX mode `0600/0700` 不能代替 Windows ACL。

### Release gate

固定 `Sevenflanks/opencode-manager-web` 的 `vX.Y.Z` tag，取得 immutable commit。annotated tag 必須 peel 到 commit，遇 cycle 或超過 8 層停止。核對 GitHub Release 已 published、非 draft／prerelease；`release.yml` run 的 `head_sha` 必須等於該 commit、同 repository，`publish-release` job `completed/success`；`release-please`、`recover-publish` 或其他 SHA 的成功不替代此 gate。npm `@sevenflanks/omw@X.Y.Z` 必須已存在，401／timeout／未知結果都停止，不重跑 workflow 或 merge。

下列是 operator 查核指令，JSON 須人工核對上述欄位；不是只以 command exit 0 判定成功。CLI plan/deploy 另會自行重做 release gate。

```powershell
$Repo = 'Sevenflanks/opencode-manager-web'
$Tag = 'v0.8.0'
$Version = '0.8.0'
gh api "repos/$Repo/releases/tags/$Tag"
gh api "repos/$Repo/git/ref/tags/$Tag"
# 若 object.type=tag，以 object.sha 查 git/tags/<sha>，最多 8 層；最後才設定 $Sha。
$Sha = '<immutable-40-character-commit>'
gh api "repos/$Repo/actions/workflows/release.yml/runs?head_sha=$Sha&per_page=100"
# 用同 SHA 成功 run 的 id 查 jobs，確定 publish-release 成功：
gh api "repos/$Repo/actions/runs/<run-id>/jobs?per_page=100"
npm view "@sevenflanks/omw@$Version" version --json --registry=https://registry.npmjs.org
```

### Clean release checkout 與 build

Operator 預先準備獨立、乾淨 release checkout；**不要在腳本開發 worktree build release**。HEAD 與 `$Sha` 完全相符，`git status --porcelain --untracked-files=all` 空白；build 前後保存 tree 與 tracked content hash，確認每個 Docker input 的實際 bytes 與 release 一致。只比較 HEAD 不足以證明 source 未變；也需核對 `.dockerignore` 的實際 context，避免 ignored 檔混入。出現任何 source drift，停止，重新準備 checkout，不偽裝成同 SHA。

使用既有 `deploy/worker/Dockerfile`，必要 private named context 明確提供；不重寫 Dockerfile、不 fallback pull public `worker-skills:latest`。缺少 skills directory 或 compiled lock／audit 不符就停止。可沿用已核對版本、lock 與來源的既有 toolchain cache；不因 cache 下載失敗改版本。

```powershell
$Source = 'C:/release/omw-clean'
$Skills = 'C:/private/omw/compiled-skills'
$BuildRun = 'C:/private/omw/build-001' # operator 預先建立，須本輪專屬且 iidfile 不存在
$LocalImage = 'omw-worker-build-<unique-run-id>:verification'
if (!(Test-Path -LiteralPath $Skills -PathType Container)) { throw '必要 skills context 不存在' }
if ((git -C $Source rev-parse HEAD) -ne $Sha) { throw 'release checkout HEAD 不符' }
if (git -C $Source status --porcelain --untracked-files=all) { throw 'release checkout 不乾淨' }
if ($LASTEXITCODE -ne 0) { throw 'git 查核失敗' }
# 先核對 LocalImage 不存在、保存 source hash 與 skills audit 證據。清除 host DOCKER_/COMPOSE_ override。
docker --context desktop-linux buildx build --file "$Source/deploy/worker/Dockerfile" --build-context "worker-skills=$Skills" --label "org.opencontainers.image.revision=$Sha" --label "org.opencontainers.image.version=$Version" --tag $LocalImage --iidfile "$BuildRun/image-id.txt" --load $Source
if ($LASTEXITCODE -ne 0) { throw 'build 失敗／未知；保存報告，不接續 publish' }
docker --context desktop-linux image inspect $LocalImage --format '{{.Id}}'
```

建置後再次核對 source bytes/hash、image ID、release labels、固定工具鏈與 profile。`image-id.txt` 是本機 config image ID，**不是 registry manifest digest**。必要驗證依既有 `scripts/worker/verify-profile.mjs`／Docker owner 契約選擇執行；不要把舊 cache image 的測試當成新產品 source 已驗證。本輪 CLI 的 offline tests 不取代 image smoke。

### 私有 registry publish

只選 operator 指定的 private repository，採固定版本＋完整 SHA tag。先查該 tag 的 remote manifest；**只有 registry 明確證明 tag 不存在才允許首次 push**。401、TLS、network、timeout 或泛稱 `manifest unknown` 未釐清 scope 的結果都不是不存在。已存在且 config image ID／source labels 不同，拒覆寫；相同則沿用並做 remote validation，不重 push。既有官方 Docker credential helper 處理 credentials，不讀 host config、不 login、不 echo credential。

```powershell
$RegistryRepo = 'registry.example.test/private/omw-worker'
$RemoteTag = "${RegistryRepo}:v${Version}-${Sha}"
docker --context desktop-linux buildx imagetools inspect --raw $RemoteTag
# 此處必須完成上述 existing/absent 判定。只有明確 absent 才執行下兩行。
$ImageID = '<matched-build-report-sha256-config-image-id>'
docker --context desktop-linux tag $ImageID $RemoteTag
if ($LASTEXITCODE -ne 0) { throw 'tag 失敗' }
docker --context desktop-linux push $RemoteTag
if ($LASTEXITCODE -ne 0) { throw 'push 失敗／未知；不重送，不部署' }
docker --context desktop-linux buildx imagetools inspect $RemoteTag
docker --context desktop-linux buildx imagetools inspect --raw '<registry-repo>@sha256:<remote-index-or-manifest>'
docker --context desktop-linux buildx imagetools inspect --raw '<registry-repo>@sha256:<linux-amd64-child>'
docker --context desktop-linux buildx imagetools inspect --format '{{json .Image}}' '<registry-repo>@sha256:<linux-amd64-child>'
```

私有 publish report 保存：source SHA/version、build 前後 source hash、matched local image ID、target repo/tag、remote index/child/config digest tuple、remote validation 方法。config digest 必須等於 matched build image ID；不能把 image ID 當 registry manifest。完整 producer logs 只在私有報告，公開交付只列摘要。CLI 不接受 tag 作 deploy image，僅 `repo@sha256:...`。

CLI remote validation 的邊界：重新 GET raw manifest、驗 hash；若為 index 選唯一 linux/amd64 child 並驗其 hash；核對 child config digest 與 operator 設定的 `configDigest`；查 `.Image` 的 linux/amd64 與 release SHA/version labels。這驗證 manifest 的 config reference 與 tool 回傳 labels，**未獨立下載 config blob 重算其 hash，也未驗 layer bytes、簽章或完整 build provenance**。operator 須將設定綁到已驗證的 build/publish report，不能自行填一個看似合理的 image ID。raw output 僅移除 CLI 結尾 whitespace；若不能重現 registry digest，fail closed，不跳過 hash。

## 3. Plan：先確認要淘汰的資料

在私有 `environment.json` 填入非秘密 metadata。不要加入 username/password/token、kubeconfig 或 private auth file 路徑。以下 digest／SHA 是示意，不可直接部署：

```json
{
  "repository": "Sevenflanks/opencode-manager-web",
  "namespace": "ai-tools",
  "context": "operator-context",
  "targets": ["omw-beta", "omw-alpha"],
  "tag": "v0.8.0",
  "sha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "expectedManagerVersion": "0.8.0",
  "image": "registry.example.test/private/omw-worker@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "configDigest": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
}
```

只 beta 時 `targets` 改為 `["omw-beta"]`；不接受單獨 alpha、倒序、gateway 或其他 namespace。

```powershell
# 純 readonly：不建立檔案；stdout 仍含 operator context／資料 metadata，勿貼公開 log。
node scripts/worker/deploy.mjs plan --config C:/private/omw/environment.json
# --execute 此處只授權建立私有 plan/journal，不寫 cluster。
node scripts/worker/deploy.mjs plan --config C:/private/omw/environment.json --execute --out C:/private/omw/plan-001
```

Plan 做 named Deployment GET 與 Pods/RS list，保存 UID/RV、兩 container names/images、non-image fingerprint、owner UID、gateway／非目標 baseline。Worker 必須 `Recreate`、replicas 1、一個 Ready owned Pod。

Manager 一次性 Node 只做 public connectivity/capacity/current overview/history 與 loopback control GET。Basic/control credentials 只由該 Pod 既有 mounted files 在記憶體讀取，不從 host／Secret API 讀，也不輸出 header、token、原始 body/error。current scope 包含 hidden；任何 active／pending／busy／unknown 都拒絕。control `available` 依現有 supervisor 語意表示 namespace 0 且沒有 mutation；不能以失聯、空 response、query failure 或 timeout 代替。

Manager 版本來源是 **`GET /api/v1/connectivity` → `manager.version`**，不是 top-level `managerVersion`。Inspection 將這個 nested string 投影成報告的 `managerVersion`；缺少／malformed nested version 一律 unknown，沒有 flat-field fallback。回歸直接執行 `managerInspection()`，只注入 config loader／fetch／env 三個外部邊界；remote 無參數 `fn.toString()` 路徑仍使用既有 Pod config module、原生 fetch 與 env。

namespace 0 才進行 execution 的一次性 metadata filesystem inventory：只 recursive `readdir/lstat /workspace`，不開檔、不跟 symlink、不讀 auth/DB。深度超 32、超 5000 entries、permission/type unknown 都拒絕；另查原生 profile config 可讀與 skills directory 非空，不啟動 OpenCode。Manager clearance 在 inventory 前後必須完全相同。

**Recreate 會丟失 manager history、execution HOME 內的 auth 工作副本，以及 workspace emptyDir。** Plan 包含 stopped history IDs／Session bindings、workspace file/directory metadata 與 data snapshot hash。原 PVC/seed/PAT/Secret 來源未變不代表 emptyDir 副本仍保留。stopped history 的 `activity=unknown` 是產品 stopped summary，不當成活躍 busy，但也不代表 Session messages 或資料內容已驗證；不讀 DB 重新證明。未提供檔案 content hash、auth copy 或 history content 完整 inventory；metadata 的相同不能排除同 size/mtime 的内容變動。

Operator 必須檢閱每個 Pod UID、history／files metadata，完成必要另行授權的保存／確認，再以 **整個 plan digest** 確認丟棄；腳本不自動認定任何檔案是 own fixture。unknown metadata／active 狀態不能靠 ack 繞過。新 files／state／IDs／epoch／metadata hash／Deployment RV 或 Pod 身分變更須新 plan、新 ack。

## 4. Deploy：beta 通過才 alpha

先安排 **maintenance window，停止使用兩個 Worker**，避免在 clearance 到 patch 之間有人開始新工作。UID/RV/container CAS 不是跨 Manager／execution 的原子鎖；腳本沒有阻止新 Start 的跨服務鎖，不能宣稱消除了此 race。

```powershell
# 預設僅本機 preview，不 launch CLI、不建立 journal。
node scripts/worker/deploy.mjs deploy --plan C:/private/omw/plan-001/plan.json
# 取得計畫 digest 後明確授權；out 須本輪全新。
node scripts/worker/deploy.mjs deploy --plan C:/private/omw/plan-001/plan.json --execute --out C:/private/omw/deploy-001 --ack-discard 'sha256:<plan-digest>' --maintenance-window
```

Mutation 前再次查 release/image 與 cluster/data facts。每個 Worker 只送 **一次 JSONPatch**，tests UID、RV、container name、old image，同 request replace manager/execution 兩個 images；不更動 env/mount/security/template 其他欄位、不 apply/delete/scale/start/stop。先寫 durable `intent` checkpoint（scope/target/expected facts/patch digest），成功 response 再寫 `accepted` receipt。

Rollout 每 target 預設 120 秒，poll GET、驗 fresh Deployment generation/observedGeneration、replicas、new Pod UID，經 Deployment → RS → Pod owner UID 與 template spec 證明，兩 containers Ready。runtime imageID 可回 recorded index 或 linux/amd64 child digest；其他 digest／config-only imageID 會拒絕。不把 Pod name prefix 當 identity。完整命令各自 bounded，因此一個已開始的 GET 可能超過 rollout loop deadline；120 秒不是整個 run 的 hard wall clock。

Postverify 只做 Manager expected version、public/control available、空 namespace/current/pending、profile 可讀與 metadata，並核對非 image spec、非目標 Worker／gateway UID、spec、container identity 未變。beta 確認通過才 alpha；任何階段失敗立即停。Pod 刻意 **Preserve**。

這是 **health/version/profile metadata proof，不是 business proof**。不自動做 LLM、GitHub writes、SSO／provider grant、Start/Stop、Session creation 或真瀏覽器操作。本輪也未做 served assets 比對。若要業務 smoke，由人類另行授權使用 public API Start → empty Session／native profile → exact Stop，另保存 owned IDs、namespace0／capacity 證據；不要把原生 idle gateway 無 Instance 時的不可用當成部署失敗。

## 5. Lost reply／失敗與 status

```powershell
node scripts/worker/deploy.mjs status --journal C:/private/omw/deploy-001
```

Journal 每 checkpoint 以 exclusive file 建立並 `fsync`；new run 目錄不得覆寫。若 patch timeout／connection loss／invalid response，可能已套用，**不重送、不 auto rollback**。保留 intent、unresolved／halted 與已收到的 receipts；中断時可能只留下 intent，仍須當未知。不宣稱 root kill 已清完 descendants。執行中的 Docker engine／kubectl auth plugin 需要 operator／平台另行 reconciliation。

`status` 讀同 journal 的 plan、checkpoint，再做 readonly GET，分成 old image observed、new image observed、drift/unknown，永遠 `completionClaimed:false`。new image 不等於健康或整輪完成；old image 不等於允許重送。沒有完整 evidence graph 時不宣告成功、不自動恢復執行。先確認 producer／cluster 狀態，再由 operator 決定是否重新 plan；已改完 beta 但 alpha 尚未完成時，這版沒有自動 resume／alpha-only escape。需要另行人工程序決策，不重跑舊計畫。

Pending、CrashLoop、缺少 container status 或 RS template 不符時，`status` 仍輸出 Deployment facts 與 exact owner UID chain 找到的 `podObservations`：Pod UID、phase、Ready、container state／restart count 及 validation error；缺少欄位表示 unknown。這些觀察不帶 raw status message／termination log，也不是健康、完成或重試授權。plan/deploy 與 rollout 仍使用 strict Pod validation。

若 readonly GET 失敗（例如 API unreachable 或 JSON response unknown），`status` 先輸出已讀 journal 的 status／target／reason／producer，以及 `status:unresolved`、sanitized reason、`completionClaimed:false`，再以原錯誤結束（CLI exit 1）。不把觀察失敗當作成功，不新增 checkpoint、不改寫原 journal。

### 本輪驗證範圍

`node --test scripts/worker/deploy.test.mjs` 使用 injected fake process runner、fixture API responses、短命 Node argument-array fixture，所有 temp resources `finally` 清理。另以不修改本體的 serialized `processRunner`、持有實際 spawn handle 的邊界執行 timeout／output-limit Node fixtures；fixtures 無 descendants、兩秒自行退出，`finally` 確認當次 child close。歷史結果保留：初版 `867c963` 為 **63 passed**，status 修正版本 `292fccb` 為 **82 passed**，均 0 failed／0 skipped。

本次 review workset 2 新增 8 tests：固定 1／2／3／4／7-byte 切分的 controlled stdout streams 執行未修改的 serialized runner，驗中文／emoji JSON path、一般文本與 hash；涵蓋 ASCII、結尾不完整 UTF-8 bytes 的 flush、4 MB 邊界與超量去敏。公開 CLI plan/deploy 使用不同 byte 切分，驗相同 workspace data hash 與 plan digest；rollout fixture 則在 patch 後先 Pending／缺 status，再 Ready，驗 beta verified 先於 alpha patch，且每 target 僅 patch 一次。正式 runner 已改用 `StringDecoder`，跨 chunk 保留 UTF-8 狀態並在 close flush，原始 bytes 與解碼後輸出均受 4 MB 限制。

本次同一組 **90 tests：修正前 RED 為 85 passed／5 failed；修正後 GREEN 為 90 passed／0 failed／0 skipped**。既有 timeout、output-limit、raw stderr 去敏與 readonly status 回歸皆通過；streams 與 journal fixtures 清理完成。測試沒有真正 build/push、kubectl、models、production credentials／auth DB 存取或 cluster 變更。

2026-10-09 的歷史實機紀錄（保留於原交付版本 `867c963`；本次未重跑）曾成功執行 **readonly plan**：核對已發布 v0.8.0 的 release／npm、remote manifest/index-child-config reference 與 source labels；取得兩個 Worker 的 owner UID chain、Ready、Manager 0.8.0、空 current／pending／execution namespace、各兩筆 stopped history 及三個 workspace metadata entries。原生 profile 可讀；前後兩 Worker 與 gateway 的 UID、container identities、non-image fingerprint 與 snapshot 均相同。29 個 external CLI 全部 exit 0、無 timeout；當時約 16.6 秒。隨後 no-execute deploy preview 回傳相同 plan digest，**沒有額外 external CLI calls**。這是舊版本的實機證據，不是 `292fccb` 或本次 UTF-8 修正的實機驗收。

第一輪 readonly plan 曾因誤讀 `connectivity.managerVersion` 而安全拒絕；實際欄位為 `connectivity.manager.version`。已修正並以直接執行 inspection 邏輯的 regression 保護，原失敗報告保留。這兩輪都沒有 patch、Start／Stop、模型請求或新登入，沒有以 mock 取代實機結果。

**仍未實測的是新腳本的 mutating deploy／真 rollout 分支，以及登入失效時的 OIDC subprocess lifetime。** 當時兩個 Worker 已在目標 image，未為了測試再次替換 Pod。手動完成的 v0.8.0 部署不是新腳本的寫入驗收；沒有 config blob 獨立 hash、provider grant 或業務流程成功的額外主張。下次實際升級仍須 fresh plan、maintenance window、精確資料丟棄確認與 rollout 證據，不可重用這次 plan 當成未來 mutation authority。
