# Coordinator 部署與外部 Job 接入

**先執行離線 renderer 測試，再由取得當輪授權的 operator 準備環境輸入。** 本文件對應 [#118](https://github.com/Sevenflanks/opencode-manager-web/issues/118)，不是通用 Task launcher。Coordinator 觀察外部 Workers；不建立 Job、不判定任務成功、不重送有副作用的操作、不刪環境。

```powershell
node --test scripts/k8s/coordinator-render.test.mjs
```

## 1. 離線產物：可 render，不代表可直接部署

使用 Node built-ins，沒有額外 production dependency。CLI 只讀本機檔案、建立新輸出目錄；不呼叫 Kubernetes、SSO、DNS 或公司 API。JSON 同時是合法 YAML。公開 example 使用 `example.test`、示範 digest、selectors 與 Pod CIDR，必須改成當輪核准輸入；image 必須已含正式 Coordinator／Worker registration backend，不可拿 prototype image 替代。

```powershell
# parent 必須已存在；以下 Temp 只適合公開／synthetic 離線產物。
$Out = Join-Path $env:TEMP ('omw-coordinator-public-' + [guid]::NewGuid().ToString('N'))
node scripts/k8s/coordinator-render.mjs --config deploy/k8s/coordinator/example.json --out $Out
if ($LASTEXITCODE -ne 0) { throw 'Coordinator render 失敗。' }
$WorkerOut = Join-Path $env:TEMP ('omw-coordinator-template-' + [guid]::NewGuid().ToString('N'))
node scripts/k8s/coordinator-job.mjs --config deploy/k8s/coordinator/example.json --worker deploy/k8s/coordinator/worker.example.json --out $WorkerOut
if ($LASTEXITCODE -ne 0) { throw 'Worker template render 失敗。' }
```

| CLI／輸出 | 用途 |
| --- | --- |
| `coordinator-render.mjs` → `resources.json`, `kustomization.yaml`, `inventory.json` | 單副本普通 Coordinator Deployment、Service、project-scoped NetworkPolicies，以及唯一 shared Pomerium Deployment／Service／精確 Ingress |
| `gateway-public.json` | 可 review 的 Core config：沒有 client/cookie/shared secrets，沒有 Basic header，因此不是可直接啟動的完整 gateway config |
| `coordinator-job.mjs` → `worker-pod-template.json` | 沿既有 manager＋execution 的兩 core containers；預設常駐命令不會自動完成 Job |
| `worker.json`, `ingress.json` | resident 時輸出 Deployment；task 只有外部供應兩容器退出命令才輸出 Job；Ingress 只有傳入 create 後的真 Job JSON 才輸出 |
| `private-secrets.json` | 只在明示 `--private` 時生成，**不加入公開 Kustomization**；必須放 checkout 外受限 ACL 目錄 |

`--out` 的 parent 必須存在，out 必須不存在；不得覆寫舊輸出或 symlink。私有輸入與其 referenced files 都須在 checkout 外，以絕對路徑指定。模式 0600／0700 不能取代 Windows ACL，私有 JSON、Secret 產物與 logs 不得提交或公開。CLI 只列資源數／布林結果，不回印秘密，錯誤也不印原值。private validation 在建立 output 前完成。

此 renderer 獨立於 `scripts/k8s/render.mjs`。既有 base renderer 保持 Worker standalone 部署契約。**兩者都能產生 `omw-gateway`，部署時必須選定一份 shared gateway 的權威設定，不能輪流 apply 覆蓋彼此。** 既有 standalone Workers 要保留時，將原宣告之 `name/managerHost/nativeHost/secretName/browserUsername` 複製進 `standaloneWorkers`；本 renderer 保留其 exact routes、Ingress hosts 與 gateway egress，沿用原 Deployment／Service／Secrets，不產生第二 gateway 或重建 Workers。省略表示沒有既有 standalone routes，不能用於尚須保留它們的環境。

## 2. Public config 與 runtime 契約

`deploy/k8s/coordinator/example.json` 是公共 schema 範例。namespace 固定 `ai-tools`，gateway Service 固定既有 `omw-gateway:8080`。`workerImage` 必須為 digest-pinned image；registry credential 只用現有 `imagePullSecret` reference。`authenticateHost` 與 coordinator／standalone app hosts 皆為同一 parent 下單層精確 hostname，root origin 只有 HTTPS，不接受 URL path、port、wildcard、不同 parent 或 class route 內的 exact collision。

### Coordinator

| Public config | 產生的 env／行為 |
| --- | --- |
| `coordinator.host`, `browserUsername`, `secretName` | `OMW_MODE=coordinator`、`OMW_PUBLIC_ORIGIN=https://<fixed-root>`、`OMW_BROWSER_USERNAME`、`OMW_BROWSER_PASSWORD_FILE=/run/omw/browser_password` |
| `registrationSecretName` | 獨立 Secret，`OMW_COORDINATOR_REGISTRATION_SECRET_FILE=/run/registration/registration_secret`；只 Coordinator 與 trusted external operator 擁有 master secret |
| `allowedCidrs` | **必填非空 canonical IPv4 network CIDR array，/1–/32** → `OMW_COORDINATOR_ALLOWED_CIDRS` comma-separated；operator 提供真實、核准 Pod 網段，不能把範例當實際保證 |
| authenticate host 的 parent | `OMW_COORDINATOR_NATIVE_HOST_SUFFIX=<parent>`；native class 固定 `omw-job-<id>-code.<parent>` |
| `healthIntervalMs`, `healthTimeoutMs`, `failureThreshold` | 選用，對應 `OMW_COORDINATOR_HEALTH_INTERVAL_MS`／`OMW_COORDINATOR_HEALTH_TIMEOUT_MS`／`OMW_COORDINATOR_HEALTH_FAILURE_THRESHOLD`；範例 15000／3000／3 是 proposed defaults；各為正整數且上限 3600000／10000／100 |

固定 `OMW_DATA_DIR=/data/coordinator`、`OMW_PORT=4174`、`OMW_HEALTH_PORT=4176`；Service 只提供 4174，health 使用 `/health/live`／`/health/ready` HTTP probes。PID 1 為 `/usr/bin/tini -- node apps/manager/dist/src/server.js`。沒有 ServiceAccount token、RBAC、Kubernetes API、exec probes、hostPID 或 shared PID namespace。UID/GID/fsGroup 1000、RuntimeDefault seccomp、drop ALL、禁止 privilege escalation。普通單副本 `Recreate` Deployment，不是 HA。

registry 預設小型 `emptyDir`：**同 Pod 的 process/container restart 保留檔案，Pod replacement 遺失**。Worker 定期 idempotent registration 可重建當前映射，不保證恢復沒保存的歷史、Session logs 或結果。選用 `registryClaimName` 只引用已核准且專用的小 PVC；不建立 PV/PVC/StorageClass、不要求 durable DB 平台。checkpoint 只保存經投影的 metadata 與 generation fence，不保存 Worker management credentials；credentials 僅在記憶體，重啟後須等 Worker 重新註冊。metadata 仍可能含內部位址與工作摘要，claim／備份及檔案權限須受保護。Coordinator restart 不應停止 execution 或重播 mutations。

### Worker opt-in

`deploy/k8s/coordinator/worker.example.json` 欄位：`id` 為 1–40 個 lowercase DNS-safe 字元，兩端 alphanumeric；`kind=task|resident`，`name` 選用。`secretName` 與 `keySecretName` 須分離且不同於 Coordinator／gateway 的 references。`nativeHost` 可省略由 renderer 推導，若提供必須逐字相等。每次新 Job 用新 id；Pod generation 用真 Pod UID，不以 logical id 冒充 generation。

| manager env | 值 |
| --- | --- |
| `OMW_COORDINATOR_URL` | `http://omw-coordinator:4174`，同 namespace M2M registration，與人類 SSO 分離 |
| `OMW_COORDINATOR_WORKER_ID`, `OMW_COORDINATOR_WORKER_KIND`, `OMW_COORDINATOR_WORKER_NAME` | 外部短 id、task/resident、選用名稱 |
| `OMW_COORDINATOR_GENERATION` | Downward API `metadata.uid`（Pod UID，**不是 Ingress owner 的 Job UID**） |
| `OMW_COORDINATOR_ADVERTISE_ADDRESS` | Downward API `status.podIP`；只允許 Coordinator 核准的 IPv4 CIDRs 與固定 remote ports |
| `OMW_COORDINATOR_WORKER_KEY_FILE` | `/run/worker-key/worker_key`，僅 manager mount；key 是 `base64url(HMAC-SHA256(registrationSecret UTF-8 bytes, workerId UTF-8 bytes))`，不是 Base64 decode master 後 HMAC |

manager 固定 public 4174、health 4176，`OMW_PUBLIC_ORIGIN` 是 **Coordinator fixed HTTPS root**，management API 收到固定 Host／Origin；`OMW_NATIVE_ORIGIN=https://omw-job-<id>-code.<parent>`。execution 維持 native 4180、health 4177、control `127.0.0.1:4175`、runtime 4096。Coordinator remote targets 只使用 4174／4176／4180；4096／4175 無 Service/public route，control 同時須 loopback bind。

各 Worker browser Basic password 與 execution control token 由 external operator 獨立提供且每 Worker 不同。manager／execution 只掛各自 Worker 的 `browser_password`／`execution_token`；worker key 掛獨立 projected Secret **僅 manager 可見**，registration master 不入 Worker Pod。Coordinator 用 master 對 id 同式 derive 驗證 Bearer；M2M authentication 不能改成人類 Basic，也不搭建 token broker。

manager-data、execution-home、workspace 沿既有獨立 emptyDirs；manager 不掛 workspace。選用 `seed={claimName,subPath,authFile?,patFile?}` 只允許 execution 唯讀引用既有、專屬且受保護的 NFS seed PVC，不寫來源、不 export provider auth、不清理 PVC。`.` 可表示專屬 claim root。seed 發布與 NFS UID 1000 permissions 流程見 [worker-k8s.md](worker-k8s.md)，本輪不操作來源。

### NetworkPolicy 邊界

1. gateway → Coordinator 4174；edge peer 必須同時符合明示 namespaceSelector **AND** podSelector 才能到 gateway 8080。
2. Worker → Coordinator 4174，Coordinator → Worker 4174／4176／4180；所有這些 peers 只有同 namespace podSelector，且含 `app.kubernetes.io/part-of=omw`。Worker class 另含 `omw.io/coordinator-worker=true`，不以任意 image/name selector 擴及其他服務。
3. DNS 明示 `dnsPeer`，Worker/gateway HTTPS outbound 使用 `httpsEgress.mode=allow443`（任何 TCP443，非 domain allowlist）或核准 IPv4 CIDRs。Coordinator 只需 DNS 與 Worker 固定 ports，不放一般 HTTPS/Kubernetes API egress。

destination CIDRs 的 backend 驗證與 NetworkPolicy project labels 是不同邊界，兩者都須成立。label 並非對 namespace 管理者的保護；registration 還須驗 key 與 Worker management identity，不可信任自報 UID／HTTP200。NetworkPolicy additive，其他 permissive policies、CNI enforcement、node/kubelet 例外仍須實際檢查。

## 3. Shared Pomerium：初始化一次 class routes

固定官方 image `pomerium/pomerium:v0.33.4@sha256:d6e1d438b3ee88e2391feead5e39463b89da58eee0e39e78c80b94ee498a23af`（已知 amd64）。兩條新增 routes 都到 `http://omw-coordinator.ai-tools.svc.cluster.local:4174`：

```json
[
  {"from":"https://coordinator.example.test","preserve_host_header":true},
  {"from":"https://omw-job-*-code.example.test","preserve_host_header":true}
]
```

以上是節錄，不是完整可啟動設定。完整 `gateway-public.json` 含 shared OIDC client `omw`、唯一 `https://<authenticateHost>/oauth2/callback`、memory databroker、host-only cookie（省略 cookie_domain）、WebSocket 與 SSE 無 route/idle timeout、既有 untrusted identity header removal 及 `pass_identity_headers=false`。

精確 array Rego 直接沿用 base renderer 已驗 syntax：從已驗證 session 的 `id_token.raw` decode 原始 `groups`，要求 array 且全部 string，再 exact-case OR 比對 `allowedRoles`。預設 `['admin']`；`[]` deny all；scalar/null/object/mixed array 不合法。不可改成 generic allowEveryone／allow-any-authenticated，也不能用會 flatten scalar 的 PPL claim 取代。私有 config 只對兩條 Coordinator routes 設 Coordinator Basic，**不是把所有 Worker Basic 注入 wildcard route**；Coordinator 隨後才選 authenticated registration 的精確 Worker credential。既有 standalone routes 仍逐一注入其原 Basic。

Pomerium 0.33.4 把 `*` 轉成 `(.*)`，**可 match 空字串與跨 dot**。class route 並非 hostname validation。Coordinator backend 必須雙重檢查「固定 prefix/suffix、單 DNS label、非空合法 id」及「完整已註冊 host」；unknown／offline／malformed host fail closed，不得 Host 拼 IP、fallback 或跨 Worker load balance。不能依賴未釘版驗證的 exact-vs-wildcard priority，renderer 預先拒絕 class 中的 standalone/root hosts。

**Ingress 永遠不含 wildcard。** 初始化 shared Ingress 只含 auth／Coordinator root／需保留的 standalone exact hosts。外部每 Job 建一個 exact native Ingress 到同 gateway Service。新增第三個 Worker 不更新 class config、不改 IdP、不 restart gateway；已有 parent DNS／TLS 是否覆蓋此單 label 平面仍待當輪驗證，本票不建立 perJob Service/headless Service、不修改 DNS／Edge、不申請 public cert、不寫 Kubernetes operator。

官方來源：

- [v0.33.4 config/from.go](https://github.com/pomerium/pomerium/blob/v0.33.4/config/from.go) 與 [from_test.go](https://github.com/pomerium/pomerium/blob/v0.33.4/config/from_test.go)：wildcard `(.*)` 與 match 行為。
- [v0.33.4 config/policy.go](https://github.com/pomerium/pomerium/blob/v0.33.4/config/policy.go)：`preserve_host_header`、`sub_policies.rego`、WebSockets、headers、timeout。
- [官方 from 文件](https://www.pomerium.com/docs/reference/routes/from)、[headers 文件](https://www.pomerium.com/docs/reference/routes/headers)：Context7 已交叉核對；新版文件不能取代釘版 source。沿用 base 已實測的 Authorization removal/set 行為。

## 4. Secrets：只接受明示的 private file references

**沒有 dummy Secret 範例。** operator 以當輪核准私有管道取得 credentials，將內容寫至 checkout 外受限 ACL 的既有 private files（不透過 CLI arguments、stdout、query strings、logs）。檔案原值不 trim，不加 newline；browser password 至少 16 字元、master/control token 至少 32 字元，最多 4096 UTF-8 bytes，拒絕 CR/LF/NUL／首尾空白，master/control token 不含 whitespace。cookie/shared secret 各為獨立 random 32 bytes Base64。registration secret 是高 entropy UTF-8 secret 的**原字串**。

Coordinator 的 `--private` JSON 只存 path：

```json
{
  "clientSecretFile":"C:/private/omw/oidc-client-secret",
  "cookieSecretFile":"C:/private/omw/gateway-cookie-secret",
  "sharedSecretFile":"C:/private/omw/gateway-shared-secret",
  "coordinatorPasswordFile":"C:/private/omw/coordinator-browser-password",
  "registrationSecretFile":"C:/private/omw/coordinator-registration-secret"
}
```

若保留 standalone routes，另加 `standalonePasswordFiles` map（key 是其 name，value 是絕對 password file path），並核對與原 Worker Secret 一致。renderer 不改 standalone Secret。Worker 的 private JSON：

```json
{
  "registrationSecretFile":"C:/private/omw/coordinator-registration-secret",
  "passwordFile":"C:/private/omw/job-a-browser-password",
  "executionTokenFile":"C:/private/omw/job-a-execution-token"
}
```

**只有獲得本輪 credential 使用授權，才執行帶 `--private` 的本機 renderer。** deriveWorkerKey 在 renderer 記憶體完成，不 stdout、不提供通用 token 發放服務。Job private bundle 只含該 Worker 的 browser/control Secret 與 derived worker-key Secret，沒有 master。兩類 Secrets 名稱版本化且 immutable；create-only，存在即失敗。不把 private bundle 加入公開 Kustomization。rotation 會涉及相應 Pod replacement／registration 失效，必須處理正在執行的工作。

```powershell
# C:/private/omw 必須已存在、ACL 經核對；本輪新 out 都不得存在。
node scripts/k8s/coordinator-render.mjs --config C:/private/omw/coordinator.json --out C:/private/omw/coordinator-render-001 --private C:/private/omw/coordinator-private.json
node scripts/k8s/coordinator-job.mjs --config C:/private/omw/coordinator.json --worker C:/private/omw/job-a.json --out C:/private/omw/job-a-render-001 --private C:/private/omw/job-a-private.json
```

## 5. External Job 的兩容器退出契約

公開 worker example **只輸出 Pod template，不輸出可誤認會完成的 Job**。原 manager／execution server 都是常駐普通 containers；Task 做完不會自動讓 Job `Complete`，TTL 也不會開始。external starter 必須另提供兩容器的 command/exit authority，renderer 才輸出 `worker.json`。

operator 在 private `job-a.json` 加入 `taskCommands`，格式 `{ "manager": ["executable", "arg"], "execution": ["executable", "arg"] }`。這些 executable／scripts **須已存在於其核准 image**；renderer 自動以 `/usr/bin/tini --` 包住，不生成任務程式、不塞 prompt、不新增第三 sidecar。不要直接把兩個原 server 命令填入此欄位並宣稱能完成。

外部供應者必須確認：

1. 正確啟動 manager／execution 既有 runtime，execution 的任務命令、輸入與 completion/failure 判定由外部提供。
2. 任務已結束／終止後，外部 authority 能讓 **兩容器及各自 owned children** 正確退出，保留失敗 exit code；不要求 shareProcessNamespace、不用 exec liveness probe。
3. 若外部以精確 operator `exec` 或其他 lifecycle API 結束容器，只能用當輪核准權限及已核對 Pod UID/container，不能讓 Coordinator 持 Kubernetes credentials。

範例 Job 設 `restartPolicy=Never`、`backoffLimit=0`，選用 `ttlSecondsAfterFinished`；這是限制 Kubernetes 自動重試，**不是 exactly-once 保證**。Job controller／node failure／外部重送仍需外部 authority 判斷，Coordinator 不重派。resident 不需要 taskCommands，輸出 ordinary Deployment；它失聯只顯示 offline。

## 6. Operator 操作：真 SLKE 全部 pending

**以下僅供當輪已獲具體部署授權的 operator 手動執行；本次沒有執行任何 cluster mutation。** 每輪從核准管道取得 namespace-scoped credentials／context 與目標 namespace，不能沿用 PoC 或上一輪權限、不能把本票當作 SSO／shared infrastructure 操作授權。

### 6.1 核對本輪 identity 與能力

使用核准 kubeconfig 的絕對檔案路徑，避免意外使用 default context。先比對 context、cluster／namespace 與本輪授權記錄；不要把 kubeconfig/token 內容列印。

```powershell
$Kubeconfig = 'C:/private/omw/approved-kubeconfig'
$Context = 'approved-omw-context' # 換成此輪明示的 context 名稱
$Namespace = 'ai-tools'
$K = @('--kubeconfig', $Kubeconfig, '--context', $Context, '--namespace', $Namespace)
kubectl @K config current-context
kubectl @K version --output=yaml
foreach ($Resource in @('jobs.batch', 'ingresses.networking.k8s.io')) {
  foreach ($Verb in @('create', 'get')) {
    $Allowed = kubectl @K auth can-i $Verb $Resource
    if ($LASTEXITCODE -ne 0 -or $Allowed -ne 'yes') { throw "缺少 $Verb $Resource，停止。" }
  }
}
```

`--context` 為每個實際 API request 的權威選擇；`config current-context` 只顯示檔案預設值，不代替核對指定 Context。使用 server 前後一個 minor 內的 kubectl。外部 Job operator 所需最小能力是該 namespace Job create/get、Ingress create/get；owner 使用 `blockOwnerDeletion=false`，不要求 Job finalizer update 權限。Secret create、shared gateway 的 Deployment/Service/Ingress/NetworkPolicy 更新、rollout/get/wait、Pod exec 或刪除資源各須另行核准所需權限，不替 operator 建 Role/RoleBinding。

### 6.2 初始化 shared Coordinator／gateway（一次）

先 review `inventory.json` 及 shared baseline（含既有 standalone exact routes），確認既有 Service、Ingress class、edge/dns selectors、parent TLS/DNS、CIDRs、CNI、image pull／tini／backend env、容量、Secrets/PVC 歸屬。Secret 名稱必須尚未存在；已有 registryClaimName／seed 只引用，不刪。經授權才能建立新版 secrets 及更新本專案 shared gateway：

```powershell
kubectl @K create -f C:/private/omw/coordinator-render-001/private-secrets.json
if ($LASTEXITCODE -ne 0) { throw 'Secret create 失敗；停止，不改為覆寫。' }
kubectl kustomize C:/private/omw/coordinator-render-001 --output C:/private/omw/coordinator-render-001/rendered.yaml
if ($LASTEXITCODE -ne 0) { throw 'Kustomize 失敗。' }
# 檢閱 rendered.yaml；本輪明示允許 inventory 中 shared 資源更新後：
kubectl @K apply -f C:/private/omw/coordinator-render-001/rendered.yaml
if ($LASTEXITCODE -ne 0) { throw 'Apply 失敗，查核結果後再決定。' }
kubectl @K rollout status deployment/omw-coordinator --timeout=120s
kubectl @K rollout status deployment/omw-gateway --timeout=120s
```

gateway 初始化／config rotation 的 `Recreate` 會中斷 SSO sessions／streams；之後新 Job 不再改這份 config。禁止 apply 原 base gateway 回蓋 class routes；權威整合入口待主 integration 接手。不要用 prune、namespace delete、寬泛 label delete。

### 6.3 建 Job，取得當輪 Job UID，再 render exact Ingress

operator 已供應並驗證兩容器 exit commands，review `worker.json` 中只有兩 core containers、master 未掛入、Worker auth/key 名稱獨立後：

```powershell
kubectl @K create -f C:/private/omw/job-a-render-001/private-secrets.json
if ($LASTEXITCODE -ne 0) { throw 'Worker Secret create 失敗。' }
kubectl @K create -f C:/private/omw/job-a-render-001/worker.json
if ($LASTEXITCODE -ne 0) { throw 'Job create 失敗，不猜 UID、不重送任務。' }
# 使用 private job-a.json 中 id 對應的精確名稱；不要 get 全 namespace JSON。
kubectl @K get job omw-job-example-a -o json | Set-Content -LiteralPath C:/private/omw/job-a-created.json -Encoding utf8NoBOM
if ($LASTEXITCODE -ne 0) { throw '取 Job UID 失敗。' }
node scripts/k8s/coordinator-job.mjs --config C:/private/omw/coordinator.json --worker C:/private/omw/job-a.json --created-job C:/private/omw/job-a-created.json --out C:/private/omw/job-a-ingress-001
if ($LASTEXITCODE -ne 0) { throw 'Ingress render 失敗。' }
```

在 review ingress 後、create 前再次核對該 Job 存在且 UID 未變（Kubernetes create 與後續 get/render/create 不是交易；名稱可能被外部替換）。不要硬塞 unknownUID 或把範例測試 UUID 當真 owner：

```powershell
$ExpectedUid = (Get-Content -LiteralPath C:/private/omw/job-a-created.json -Raw | ConvertFrom-Json).metadata.uid
$CurrentUid = kubectl @K get job omw-job-example-a -o 'jsonpath={.metadata.uid}'
if ($LASTEXITCODE -ne 0 -or !$ExpectedUid -or $CurrentUid -ne $ExpectedUid) { throw 'Job incarnation 已變，停止。' }
kubectl @K create -f C:/private/omw/job-a-ingress-001/ingress.json
if ($LASTEXITCODE -ne 0) { throw 'Ingress create 失敗，查核 ownership 後處理。' }
kubectl @K get ingress omw-job-example-a-code -o wide
```

Ingress 與 Job 同 namespace，`ownerReferences` 精確指向已取得的 Job UID，backend 為既有 `omw-gateway:8080`。owner UID 正確性來自本輪外部 operator 的 create/get 與重新核對；離線 CLI 不替它查 Kubernetes，也不能僅憑 UUID 格式證明物件存在。Job 已完成且 TTL 到期或經授權精確刪除 Job 後，由 Kubernetes GC 回收 owner Ingress；Worker health offline **不觸發清理**。Job failure before ingress 也不重送 task；依當輪 ownership 查核結果處理。derived credential Secret 沒有自動 Job owner，保留後另獲授權處理，不能用寬泛清除。

### 6.4 第三 Worker 與故障驗收

以全新 id、獨立 Basic/control Secret、同式 derived key 重複 6.3；不要修改 OIDC client、class route 或 restart gateway。保存去敏 evidence：第三完整 host 命中第三 Pod，舊兩個 Workers 的 Instance／Session/credentials 不串台；非法 prefix、跨 dot、空 id、未知完整 host、錯誤 Bearer、錯誤 management identity、CIDR 外與 private/control ports 全拒絕。Coordinator restart 不停止 execution、不 replay mutations，registrations 重建後 registry/history 語意正確。

task exit/Job TTL/Ingress GC 要由有權 external starter 驗證，與 offline/recovery 分開。health 短暫失敗、門檻、late generation fencing、pending permission、Start/Session/native assets、真 HTTP SSE 及實際 native WebSocket、手機／桌面 UI 與 admin/非admin SSO 仍須真環境驗收。

## 7. 證據範圍與 backend 對齊點

| 證據 | 本輪可證明／仍 pending |
| --- | --- |
| 本機 renderer tests | 公開/private CLI offline、精確 Job owner/host/gateway、固定 ports/project peers、Downward API、credential mount 隔離、private/public 分離與角色 Rego artifact 沿用 |
| 既有 main gateway mock | base renderer 的 Pomerium 0.33.4 array Rego／Basic／Host/Origin synthetic SSO syntax 已驗；本輪比對 policy 產物相同，不宣稱 Coordinator wildcard 真 SSO 已測 |
| 歷史 Coordinator PoC | 兩個 cached 真 Worker pairs、本機 renewal/restart/health/management、32 秒真 SSE、synthetic echo WS；預先配置 IP/hosts；**不是第三個動態 Job、real SSO、native UI WS 或 Kubernetes 的證據** |
| 真 SLKE／公司 SSO | **pending**：當輪 namespace credentials/能力、shared update 授權、CNI/TLS/DNS、第三 Worker dynamic admission、真 stream/WS、exit/GC；本輪沒有 cluster/SSO/DNS 操作 |

本機 PoC source 僅唯讀參考，正式產物不引用其未 commit worktree 為 remote dependency。

主 integration 上線前須對齊：

1. backend 最終 env 名稱、Coordinator server/health bind 與讀檔 normalization；本 renderer 依本文確切 contract，不應偷偷 fallback。
2. registration payload／Bearer HMAC 與 fixed management Host、Worker Basic identity 檢查；manager key 不傳 execution，allowed CIDRs/ports、strict registered native host 雙重驗證。
3. Worker periodic idempotent re-register、新 Pod UID fencing、late probes、health counter 不因 renew 清零；registry file 的私密資料保護與 emptyDir/PVC restart 語意。
4. image 必須包含 tini／rootless runtime 與正式 backend；external task command/exit authority 另行供應及測試，Coordinator renderer 不實作它。
5. shared gateway 權威入口與既有 standalone declarations 整合；完成真 wildcard SSO／SSE／native WS／SLKE 驗收後，才可勾對應 #118 acceptance。
