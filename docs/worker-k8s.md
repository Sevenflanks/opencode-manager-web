# Worker Kubernetes 操作草稿

本文件對應 #102 的部署 slice。離線 render 通過不代表 SLKE、公司 SSO、雙真 Worker 或真實模型已驗收。下列 cluster 指令僅供取得當輪明確授權的 operator 執行。

## 產物與版本

單一 JSON 宣告 `workers` 的 name、managerHost、nativeHost、secretName、browserUsername；CLI 同時產生 Deployment、Service、NetworkPolicy、gateway routes 與 Ingress。名稱皆以 `omw-` 開頭，穩定身分 label 為 `omw.io/identity`，不把 image version 放進 selector。

```powershell
node --test scripts/k8s/render.test.mjs
node scripts/k8s/render.mjs --config deploy/k8s/example.json --out C:/private/omw/render-001
kubectl kustomize C:/private/omw/render-001 --output C:/private/omw/render-001/rendered.yaml
```

`C:/private/omw` 必須預先存在、位於 checkout 外並有受限 ACL；`render-001` 必須不存在。輸出為 JSON 格式的合法 YAML；Kustomize 必須使用 `kustomization.yaml` 檔名。產生的 root overlay 引用 `base`；可在外部 overlay 加入經核准的環境 annotations，不能直接修改 shared Ingress／Edge／DNS。生成器不呼叫 kubectl、不 apply、不刪除任何資源，只輸出資源數與非秘密資源 hash。`inventory.json` 是本輪精確資源清單。

公開 example 使用 `example.test`、示範 digest 及示範 selectors，**不能直接當成可運作環境**。私有宣告需替換 worker image 為已發布且 pull 驗證過的 digest、現有 imagePullSecret、Ingress class、auth／app flat hosts、issuer、edgePeer、dnsPeer。Worker image 應保留 OpenCode 1.18.34、ACP 1.18.3 與同版 curated profile，並含本票 health／tini runtime 修改；以 digest 固定全部內容。Pomerium 固定 `v0.33.4@sha256:d6e1d438b3ee88e2391feead5e39463b89da58eee0e39e78c80b94ee498a23af`（已知 linux/amd64 manifest）；其他架構未驗。

## Runtime 交接契約

每 Worker 一個 replica、`Recreate` Deployment，兩個 containers 使用相同 image：

| 容器 | PID 1 與直接 child | 連線 |
| --- | --- | --- |
| manager | `/usr/bin/tini -- node apps/manager/dist/src/server.js`，`OMW_MODE=worker` | public 4174；health 4176；control client `http://127.0.0.1:4175` |
| execution | `/usr/bin/tini -- node apps/manager/dist/src/worker/execution-server.js` | native 4180；`OMW_EXECUTION_HOST=127.0.0.1` control 4175；health 4177 |

`OMW_HEALTH_PORT` 獨立 listener 須可由 kubelet 連線；`GET /health/live`、`GET /health/ready` 正常回 `200 {"status":"ok"}`，終止時 readiness 503。等待登入、沒有 Instance、provider 不可用不是 liveness failure。HTTP probes 沒有 auth/header，也沒有 exec probe。Service 只暴露 4174、4180；4096、4175、4176、4177 無 Service。runtime 未實作以上契約或 image 沒有 tini 前不得部署。

UID/GID/fsGroup 1000，drop ALL capabilities、`allowPrivilegeEscalation=false`、RuntimeDefault seccomp、不掛 ServiceAccount token、不使用 hostPID 或 shareProcessNamespace。每 Worker 的 manager-data、execution-home、workspace 都是私有 emptyDir；manager 不掛 workspace，filesystem 操作走 execution。預設每容器 request 100m/256Mi/256Mi ephemeral，limit 2 CPU/2Gi/4Gi ephemeral，Pod termination grace 30 秒；這是待目標容量 preflight 的提案，不是 cluster 容量保證。

## Secrets 與首次登入

公開 artifact 不包含 Secret、dummy Secret、Basic value 或 OIDC secret。每 Worker 私有 Secret 的 key 為 `browser_password`、`execution_token`；username 在 Worker 宣告，必須非空且不可含冒號、CR、LF 或 NUL。兩容器 read-only 掛載該 Worker Secret，不掛 gateway OIDC config。password 至少 16 字元、executionToken 至少 32 字元，UTF-8 掛載檔各不得超過 4096 bytes；兩者不可含 CR、LF 或 NUL，password 不接受首尾空白，token 不接受任何 whitespace。renderer 不 trim 原值，內部空白 password 原樣保留；`workerSecret()` 僅移除檔尾一個 LF／CRLF，不 trim，生成的 Secret value 不附換行。Basic password 必須與 gateway 私有輸入完全一致；控制 token 每 Worker 獨立。

gateway 私有 JSON 放 checkout 外，欄位：

- `clientSecret`：OIDC client secret，固定 client ID `omw`。
- `cookieSecret`、`sharedSecret`：各為 32 random bytes 的 Base64，分別獨立產生並保管。
- `workers`：以 Worker name 為 key，每項含 `password`；加上選用 `executionToken` 時，CLI 同時產生該 Worker 的獨立 private Secret bundle，避免手工同步 password。不同 Worker 的 token 必須不同；生成的 Secret 名稱必須以 `omw-` 開頭。省略 `executionToken` 表示沿用操作者已提供的 Secret，CLI 不會讀取或更新它，操作者需自行核對 password 一致。

私有輸入只含上述 gateway／Worker credentials，不含 CI、registry 或 imagePullSecret credentials。本文件不提供可誤 apply 的完整秘密範例。私有輸入有真實值時才執行：

```powershell
node scripts/k8s/render.mjs --config C:/private/omw/environment.json --out C:/private/omw/render-002 --private C:/private/omw/gateway-private.json
kubectl kustomize C:/private/omw/render-002 --output C:/private/omw/render-002/rendered.yaml
```

`gateway-secret.json` 是獨立 immutable Secret，**不加入公開 Kustomize resources**；只由 gateway 掛載。POSIX mode 0600/0700 不能取代 Windows ACL，操作者須限制 parent ACL，不把私密 JSON、rendered private Secret、kubectl secret 輸出放入 log／PR。CLI 錯誤不回印輸入。若 private validation 失敗，輸出可能已有公開檔案，改用新目錄重跑。

選用 `executionToken` 產生的 `worker-secrets.json` 同樣不在公開 Kustomize，包含 immutable Secrets。新秘密用 `kubectl create`（存在即失敗）而非覆寫既存 Secret；輪替使用新的版本化 secretName，會替換 Worker Pod，必須先處理正在執行的工作。

首次沒有 seed 時 Worker 宣告省略 `seed`；不設定 `OMW_AUTH_SEED_FILE`／`OMW_GITHUB_TOKEN_FILE`，允許原生 Headless login。非秘密 profile 由 image 的既有 ENV/固定來源初始化，不覆蓋 Compose 預設。

後續 Worker 可加 `seed`，欄位 `claimName`、`subPath`、選用 `authFile`／`patFile`。這是預先建立、專屬本專案的 PVC reference，subPath 指向該 PVC 內受保護的目錄，檔名只允許單層名稱。execution 唯讀掛 `/seed`；只在私有 OAuth 副本不存在時由既有 bootstrap 複製完整 bundle。manager 不掛 seed；同 Pod 重啟不得覆寫 refreshed auth。首次 export／更新來源是另行授權的 operator 流程；生成器只引用 claim，不 export／寫入 NFS、不建立 PV/PVC/StorageClass/namespace。

seed 失效或來源初始化失敗須人工重新登入／更新，不能 fallback 到本機 auth 或其他帳號。Git PAT 是不同授權，既有 HTTPS helper 使用 `OMW_GITHUB_TOKEN_FILE`。NFS UID/GID 1000 可讀及保護權限必須實測。來源 auth/PAT **永不隨部署 prune/delete**。

### 專屬 seed PVC（operator create-only）

已核對的 SLKE 官方 manual（2526–2587 行）定義 managed NFS 動態 PVC：`metadata.annotations['volume.beta.kubernetes.io/storage-class']='managed-nfs-storage'`，且本票必須明設 `nfs.io/storage-path` 為專屬相對 path；省略會共用 namespace root，不能作為 seed 來源。獨立範本為 `deploy/k8s/seed-claim.example.yaml`：name `omw-auth-seed-v1`、namespace `ai-tools`，穩定 labels 為 `app.kubernetes.io/part-of=omw`／`omw.io/identity=auth-seed`；annotation path 為 `omw/auth-seed-v1`，modern `spec.storageClassName` 同為 `managed-nfs-storage`、`ReadWriteMany`、request `1Gi`。`1Gi` 是容量宣告，**不是 NFS disk quota 保證**；不設定 `nfs.io/include-pvc-name`，避免再疊一層 claim name。

`omw/auth-seed-v1` 是可公開的 generic 相對路徑 example；具權 operator 必須先核對它未與其他 claim／應用共用、claim 名稱不存在，取得當輪明確 create 授權後才執行下列單檔指令。存在即失敗並停止查核，不改用 apply 覆寫；既有 claims 保持原狀。沿用平台既有 namespace、StorageClass 與 dynamic provisioner，不需 agent 建 PV／namespace／StorageClass。公開文件不記錄 self-host NFS root、host 或 IP。

```powershell
kubectl create -f deploy/k8s/seed-claim.example.yaml
```

此檔**不加入正常 generated Kustomize、`inventory.json` 或部署 deletion／cleanup**；PVC/PV 與來源不隨部署刪除。範本存在或 create 成功都不代表 provisioning 完成：operator 仍須確認實際 `Bound`、path 獨享、沒有其他 app 使用，並實測 UID/GID 1000 可讀。初期沒有 auth seed 時可先建 claim，但 Worker 宣告仍省略 `seed`，不掛載空來源；source publisher 由下節另行授權的 operator 流程處理。

來源發布並核准後，Worker 的 `seed` 可宣告為：

```json
{"claimName":"omw-auth-seed-v1","subPath":".","authFile":"auth.json"}
```

`subPath='.'` 代表**此專屬 PVC 的 root**，也可改為 operator 在 PVC 內建立的 private 子目錄（例如 `private`，owner 1000:1000、mode 0700）。`nfs.io/storage-path` 已決定 PVC 的 NFS 來源位置，不得將 `omw/auth-seed-v1` 重複填入 subPath，也不把 subPath 當完整檔案路徑。已唯讀核對既有 renderer 接受 `'.'`，execution 仍只讀 `/seed/auth.json`；bootstrap 使用 `path.resolve()`、`lstat`／`noSymlinks` 檢查 regular file，沒有將 annotation path 帶入或拒絕此 mount root 的邏輯。這是靜態相容性核對，真實 NFS mount／初始化仍待實測。

專屬 mount root 或 private 子目錄須有受保護權限；publisher 另須能以 UID 1000 建立 pending 與原子 link。NFS root-squash 可能使 rootless Pod 無法建目錄／檔案，`fsGroup=1000` 不能保證可寫；遇到權限不足由 operator／平台修正**本專屬來源**，不自動 chown／chmod 共用 NFS。

### 首次 seed 發布操作（待環境核准與實測）

先只部署 alpha（無 seed），由操作者在原生 OpenCode 完成 Headless login，再從 OMW Stop Instance。確認停止成功才允許一次性 `exec/cp` 匯出；這不是日常 Instance 控制介面。下面指令僅供取得明確授權的 operator 手動執行，agent 不執行。`$WorkerPod` 必須是核對過 UID 的 alpha Pod，`$PrivateDir` 是 checkout 外受限 ACL 私有目錄；不要把 auth 內容印至終端、用 `cat`／stdout 重導或從宿主既有 auth 複製。

`bootstrap.mjs` 確有 `--export-auth-seed ABSOLUTE_FILE` CLI；其 `exportAuthSeed()` 要求來源 auth 為目前 UID 擁有的 0600 檔、parent 為 0700。首次 provider login 的 parent 可能維持一般權限，不能為了 export 修改它。下例透過實際 exported API，先讓 `initializeWorker()` 在 `/workspace` 新的 owned export HOME 建立完整、驗證過的 0600／0700 工作副本，再由 `exportAuthSeed()` create-only 匯出；不帶入原 environment 的 profile／PAT 初始化。operator 只可建立或處理本輪 owned export 工作目錄、pending 檔及核准 NFS subPath，不 chmod 原 provider auth／parent。

```powershell
$ExportDir = '/workspace/omw-seed-export-001' # 本輪不存在的專屬目錄；mkdir 存在即失敗。
kubectl -n ai-tools exec $WorkerPod -c execution -- node --input-type=module -e "const f=await import('node:fs/promises');const {initializeWorker,exportAuthSeed}=await import('/opt/omw/scripts/worker/bootstrap.mjs');const home=process.argv[1];await f.mkdir(home,{mode:0o700});await initializeWorker({HOME:home,OMW_AUTH_SEED_FILE:'/home/node/.local/share/opencode/auth.json'});await exportAuthSeed(home+'/auth.pending.json',{HOME:home});" "$ExportDir"
if ($LASTEXITCODE -ne 0) { throw '私有 export 失敗，停止發布。' }
# Windows drive 冒號會被 kubectl cp 當作 remote；在受限 ACL 目錄使用 ./filename。
Push-Location -LiteralPath $PrivateDir
try {
  if (Test-Path -LiteralPath './auth.pending.json') { throw 'pending 檔已存在，停止。' }
  kubectl -n ai-tools cp "${WorkerPod}:${ExportDir}/auth.pending.json" ./auth.pending.json -c execution
  if ($LASTEXITCODE -ne 0) { throw '下載失敗，停止發布。' }
} finally { Pop-Location }
```

上節 PVC 已經 operator 核准 create、實際 `Bound`，且來源獨享與權限查核完成後，才可在 checkout 外產生下列 operator Pod JSON。`$Claim='omw-auth-seed-v1'`，`$SubPath='.'` 使用本專屬 PVC root；若核准的是 PVC 內 private 子目錄，改填該相對目錄。`$WorkerImage`、`$PullSecret` 需替換為實際核准值，檢閱後才 create。NFS 管理者須先確認 root／子目錄 owner 1000:1000、mode 0700，UID 1000 可讀寫；rootless Pod 不負責 chown 其他人的目錄。動態 PVC 契約已核對，實際 provisioning／發布／Worker 掛載仍未驗收，不可用共用資料 claim 代替。

```powershell
$Claim = 'omw-auth-seed-v1'
$SubPath = '.' # 本專屬 PVC root；若使用已核准的 private 子目錄，改填該相對目錄。
$Publisher = @{
  apiVersion='v1'; kind='Pod'
  metadata=@{name='omw-seed-publisher';namespace='ai-tools';labels=@{'omw.io/owned'='seed-publisher'}}
  spec=@{
    restartPolicy='Never';activeDeadlineSeconds=600;automountServiceAccountToken=$false
    securityContext=@{runAsNonRoot=$true;runAsUser=1000;runAsGroup=1000;fsGroup=1000;seccompProfile=@{type='RuntimeDefault'}}
    imagePullSecrets=@(@{name=$PullSecret})
    containers=@(@{name='publisher';image=$WorkerImage;command=@('node','-e','setTimeout(()=>{},540000)');securityContext=@{allowPrivilegeEscalation=$false;capabilities=@{drop=@('ALL')}};volumeMounts=@(@{name='seed';mountPath='/publish';subPath=$SubPath})})
    volumes=@(@{name='seed';persistentVolumeClaim=@{claimName=$Claim}})
  }
}
$Publisher | ConvertTo-Json -Depth 20 | Set-Content "$PrivateDir/seed-publisher.json"
kubectl create -f "$PrivateDir/seed-publisher.json"
kubectl -n ai-tools wait --for=condition=Ready pod/omw-seed-publisher --timeout=120s
Push-Location -LiteralPath $PrivateDir
try {
  kubectl -n ai-tools cp ./auth.pending.json omw-seed-publisher:/publish/auth.pending.json -c publisher
  if ($LASTEXITCODE -ne 0) { throw '上傳失敗，停止發布。' }
} finally { Pop-Location }
# 只允許首次發布；existing auth.json 時拒絕，不覆寫。link 是同 filesystem 原子建立。
kubectl -n ai-tools exec omw-seed-publisher -c publisher -- node -e "const f=require('fs');f.chmodSync('/publish/auth.pending.json',0o600);f.linkSync('/publish/auth.pending.json','/publish/auth.json')"
if ($LASTEXITCODE -ne 0) { throw '原子發布失敗，保留 pending 並停止。' }
```

確認檔案 owner/mode 及 hash（不讀出內容）、NFS 支援原子 hard link 後，beta 宣告 `seed.claimName=$Claim`、`seed.subPath=$SubPath`、`seed.authFile=auth.json`；重新 render/review/apply beta。若 NFS 不支援 link，停止並選定等價 no-overwrite 原子發布方式，不降級成直接覆寫。比對來源 hash 與唯讀 mount、實測 beta 的私有 copy／refresh；同 Pod 重啟不覆寫。PAT 必須另行核准，以同樣受限私檔、獨立檔名 no-overwrite 發布，再設定 `patFile`，不可拿 OAuth grant 代替。publisher 清理僅刪核對 UID 的 `omw-seed-publisher` Pod，**不刪 PVC/PV／來源**。失敗時保留 pending 檔，先查核再重試；來源輪替需另行批准及備份，不重跑首次發布去覆寫。

私有下載／render 輸出全程維持受限 ACL，NFS pending 僅限本輪 owned 檔且須事先不存在；不得覆寫他人 pending。發布後本機私檔、`/workspace` export 副本及 NFS pending 的刪除須另取得使用者同意，僅處理明確檔名，不做 recursive cleanup；NFS 已發布來源保留。

## 入口與 policy

auth 與所有 app hosts 必須同 flat parent domain。唯一 callback 是 `https://<authenticateHost>/oauth2/callback`；新增 Worker 不改 IdP client。既有 Edge TLS 到 HTTP gateway :8080；gateway 的多 rules Ingress 固定帶 `ingress.softleader.com.tw/automanaged: "true"`，沿用已核對 controller 的原生 annotation。實際 Edge headers／既有 wildcard certificate 配置仍待核准環境驗證；本產物不建立憑證或修改共享 Edge。

Pomerium all-in-one、單副本 memory databroker，不是 HA。沒有 cookie_domain，app cookie 保持 host-only。route 保留 Host/Origin（不做 path rewrite）、explicit WebSocket、timeout/idle_timeout 0s 供長 SSE；移除列出的不可信 identity headers，`pass_identity_headers=false`，覆寫 Authorization 為該 Worker 的固定 Basic。不把 ID token／refresh token／client secret設為 upstream headers。

`allowedRoles` 預設 `["admin"]`，`[]` 拒絕全部，非 array definition 直接拒絕 render。比對 exact-case OR。**不能直接用 PPL `claim/groups` 判斷型別**：固定版本 `pkg/identity/claims.go` 的 Flatten 將 scalar 也轉成 array。本實作自訂 Rego 讀已驗證 session 的 `id_token.raw`，以 `io.jwt.decode` 取得原始 groups，要求 array 且所有元素 string 後才比 role；缺原始 token／claim 或格式錯誤即 deny。JWT 驗證仍由 Pomerium authenticate/session 負責，policy 不信任 browser 自帶 token。

完整 synthetic gateway 契約檢查（Docker Desktop Linux、已安裝 Chrome 及現有 playwright-core；不需 OPA）：

```powershell
node scripts/k8s/verify-gateway.mjs
```

此 bounded harness 使用 pinned Pomerium 0.33.4、mock OIDC、browser 與 **render CLI 實際生成的私有 config**，驗證 admin 正向、Operator OR、空清單與 malformed／missing／wrong-case 拒絕，以及 Basic、Host/Origin、偽造 identity header。每輪 unique Docker ownership、fixture TTL、19 分鐘 watchdog、finally browser close 與 scoped cleanup；證據／合成私密資料留 temp。它不是公司 SSO／真 Worker／NetworkPolicy 證據。

NetworkPolicy 只選本專案 Pod；Worker ingress 只接受同 namespace gateway 的 4174/4180，gateway ingress 必須同時符合 `edgePeer.namespaceSelector` **AND** `podSelector`，不預設信任所有 namespace。DNS selectors 也需實際環境輸入（NodeLocal DNS 需另評估）。`httpsEgress.mode=allow443` 明確放行任何 TCP 443，**不是只允許某些網域**；`mode=cidrs` 加 `cidrs` array 可限制核准位址範圍，但 CDN／IdP／provider／Git IP 變更須 operator 維護。image pull 由 node 執行，不由 Pod egress policy 控制。

K8s NetworkPolicy 是 additive，既有 permissive policy 可能另外放行；需 baseline 查核及實際 CNI enforcement。Node/kubelet traffic 有特例，這不是 namespace 管理者或 node compromise 的隔離措施。控制 port 必須同時 loopback bind，不能只依賴 Service 未暴露。

## 經授權部署與更新（本次未執行）

先確認相容 kubectl/client-server skew（kubectl 官方支援 server 前後一個 minor；曾觀察 1.34.3/1.32.13，需另用相容 client），現有 ai-tools 資源名稱無碰撞、selectors 無誤選、registry push/pull、NFS permission、CNI、Edge peer selectors、IdP、provider/Git outbound 與 node capacity。保存非秘密 baseline；不要輸出 Secret data。

```powershell
kubectl version --output=yaml
kubectl -n ai-tools get deployment,service,ingress,networkpolicy -o wide
# 只在檢閱 inventory.json 並核對名稱均屬本次資源後：
kubectl -n ai-tools create -f C:/private/omw/render-002/gateway-secret.json
# 只有本輪有產生且名稱不存在時：
kubectl -n ai-tools create -f C:/private/omw/render-002/worker-secrets.json
kubectl -n ai-tools apply -f C:/private/omw/render-002/rendered.yaml
kubectl -n ai-tools rollout status deployment/omw-gateway
kubectl -n ai-tools rollout status deployment/omw-alpha
kubectl -n ai-tools rollout status deployment/omw-beta
```

不使用 `--prune`、namespace delete、寬泛 label delete 或 server dry-run 冒充部署。Secret 採版本化新名稱，例如 `omw-gateway-config-v2`；修改角色／路由／私密設定時更新宣告的 secret name，生成新 immutable Secret，再 apply 新 deployment。gateway 會 Recreate，可能重新登入、WS/SSE 中斷，但不應影響 Worker execution。舊 Secret 保留，另經授權處理，不自動清理。

Worker image/env/mount 更新會替換 Pod；`Recreate` 避免同邏輯 Worker 新舊 Pod 同時服務，**不是無中斷更新**。更新／rollback 前確認並處理執行中工作，保留精確舊 rendered 檔供人工回復；舊檔回復也不能恢復 emptyDir。

- Stop Instance：使用 OMW Stop，之後可 Start，Pod 與資料仍存在。
- 停止 Worker：授權後 `kubectl -n ai-tools scale deployment/omw-alpha --replicas=0`；Pod 刪除、emptyDir 消失。
- 再啟動 Worker：`kubectl -n ai-tools scale deployment/omw-alpha --replicas=1`；建立新 Pod，重新初始化，不恢復舊工作。
- 重部署：apply 新 manifest；若 Pod template 改變則相同資料遺失契約。
- 更新 seed：另行核准來源寫入；已有私有 auth 不覆蓋，更新來源不等於既有 Worker 立即套用。
- 清除部署：只對已核准 inventory 的明確 Deployment/Service/Ingress/NetworkPolicy 名稱逐一操作。不得刪來源 PVC/PV、auth/PAT、他人 Secret；失聯不是強制刪 Pod／自動重派授權。

## 真實部署驗收矩陣（均 pending）

| 項目 | 必須保存的去敏證據 |
| --- | --- |
| image/平台 | 固定 digest、OpenCode/profile 版本、pull 成功、client/server 版本、namespace baseline 與 inventory 差異 |
| SSO 正向 | admin（含非原部門）允許；其他精確允許角色 OR；manager/native 同政策 |
| SSO 負向 | 無 role、缺 claim、scalar/null/object/mixed array、大小寫不同、空 allowlist 全拒絕 |
| header/cookie | 所有 app/auth host 無 cookie Domain；forged identity 無效；Host/Origin/CSRF 與 Basic 生效；OIDC tokens 不入 upstream |
| 網路 | 非 gateway Pod 對 Worker public/control 皆拒絕；control loopback；edge 只到 gateway；CNI additive policy 實測 |
| 新 Worker | 新增第三組 origins 只修改 Worker 宣告／gateway，IdP callback 不變 |
| UI/streams | browse/shortcuts/Start/Stop/recheck/Session/primary Session/native URL/assets/SSE/WS |
| 真雙 Worker | 至少兩個真 Worker 同時不同可控任務，Project/Session/auth/Service/selectors 不串台 |
| 初始化 | 首個原生 Headless login；核准 export seed；第二 Worker readonly seed；source hash/permissions 保持、同 Pod 不覆寫 |
| 容器重啟 | 真工作中經明確 operator 授權只終止 manager container；確認同 execution epoch/Instance/PID、無 prompt 重送，不新增 production restart API，不以 rollout Pod 代替 |
| execution/Pod | execution 退出安全狀態；Pod 替換 emptyDir 清空、seed 重初始化、無任務重跑 |
| seed 失效 | 初始化失敗／撤銷／provider 拒絕時 fail closed、人工更新、無回寫來源 |
| 角色更新 | 新請求政策變更、既有 claim/session refresh 與 WS/SSE 撤銷邊界，不能宣稱立即踢除 |
| 真實業務 | 核准 ChatGPT 訂閱模型/工具預設 `openai/gpt-6-luna-fast`；不可用即 report pending、不換模型；受限 PAT scratch Git/gh 另行驗證 |
| Compose | 同交付 image lifecycle/Web/bootstrap 回歸，原 Compose 持久化不變 |

## 原始語意來源

- Pomerium v0.33.4：`https://github.com/pomerium/pomerium/blob/v0.33.4/config/policy.go`、`pkg/identity/claims.go`、`pkg/grpc/session/session.proto`、`authorize/evaluator/policy_evaluator.go`、`go.mod`。
- Kubernetes 1.32 NetworkPolicy：`https://v1-32.docs.kubernetes.io/docs/concepts/services-networking/network-policies/`。
- kubectl skew：`https://kubernetes.io/releases/version-skew-policy/`。
