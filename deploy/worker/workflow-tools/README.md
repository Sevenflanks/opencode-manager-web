# Worker workflow tools

獨立 npm package，只在 image build 安裝，不使用 runtime `npx @latest`。

| 工具 | 固定版本 |
| --- | --- |
| `@playwright/cli` | `0.1.22` |
| CLI 自帶 `playwright`／`playwright-core` | `1.64.0-alpha-1790635538000` |
| Chromium | revision `1247`，`155.0.8059.12` |
| `@commitlint/cli`／`@commitlint/config-conventional` | `21.2.3` |
| distro Python3 | `python3=3.11.2-1+b1`，`python3.11=3.11.2-6+deb12u8` |
| Requests | `python3-requests=2.28.1+dfsg-1` |
| PyYAML | `python3-yaml=6.0-3+b2` |

版本取自 npm release metadata，CLI 的 Playwright bundle 必須完全配對。
`npm ci --ignore-scripts` 後，由該 bundle 的 `install-deps chromium` 與
`install --no-shell chromium` 在 build time 安裝。Linux system libraries 使用既有
`toolchain.lock.json` 的 Debian snapshot `20260930T000000Z`，resolved versions
寫入 `/opt/omw-worker/workflow-tools-debian.tsv`；browser／npm versions 寫入
`/opt/omw-worker/workflow-tools-versions.json`。

Python 使用同一 signed snapshot 的 apt 套件，沒有 pip／venv 或 runtime 補下載。
`python-packages.lock.json` 固定 Requests、PyYAML、Python interpreter 與 resolver
新增的必要相依套件，共 26 個 exact apt versions；既有 base／Chromium libraries
沿用 digest 與 snapshot，完整 resolved package versions 仍記錄在 Debian TSV。
版本經該 snapshot 的 `apt-cache policy/show` 與 `apt-get --simulate
--no-install-recommends install python3-requests python3-yaml` 核對；amd64／arm64
metadata 均已確認，runtime build／smoke 的實證以實際執行架構為準。
Build 會核對 Python lock snapshot、每個 installed package version，並立即 import
requests、yaml、urllib3、idna、chardet、certifi、charset_normalizer、six。
Manifest 的 `python` 記錄 interpreter version／executable、import versions 及
26 個 apt package versions；build 缺少依賴或不符 lock 時直接失敗。

## Runtime 契約

- 新 CLI 位於 `/usr/local/bin`，可由 native `bash -l -c` 找到。同名既有路徑
  （含 dangling symlink）使 build 失敗，不覆蓋既有命令。
- Chromium 穩定 executable alias：`/opt/omw-worker/chromium`。
  `PLAYWRIGHT_BROWSERS_PATH=/opt/omw-worker/browsers`；browser／npm bundle 唯讀。
- 預設 `PLAYWRIGHT_MCP_BROWSER=chromium`、`PLAYWRIGHT_MCP_HEADLESS=true`、
  `PLAYWRIGHT_MCP_EXECUTABLE_PATH=/opt/omw-worker/chromium`。bundled Chromium channel
  使用 Playwright 官方 Linux no-sandbox 預設，隔離邊界為 non-root container，
  不新增 privileged、capabilities、host IPC 或 host mounts。
- `HOME`／XDG cache 與 profile 使用既有 node-owned writable 目錄。
  CLI update notifier 停用，無首次呼叫 npm 下載。commitlint wrapper 預設載入
  本 package 的 conventional config，接受繁中 conventional title。
- Smoke 使用 private IPC namespace 與 `--shm-size=256m`，不需 `--ipc=host`。
  Playwright 預設 Chromium launch 也帶 `--disable-dev-shm-usage`。正式負載可依頁面
  數量調整 shared memory，無需提升權限。
- 原生 `bash -l -c` 的 `python3` 是 `/usr/bin/python3`，imports 使用 distro
  `/usr/lib/python3/dist-packages`，不覆蓋 root commands、不修改 user source 或
  profile PATH。Helpers 可在 import 後顯示 CLI help；外部服務登入不屬於此 smoke。

## 最小驗證

在 repository root 執行，host 只安裝 scoped package 的開發驗證依賴：

```powershell
npm ci --prefix deploy/worker/workflow-tools --ignore-scripts --no-audit --no-fund --workspaces=false
node --test scripts/worker/workflow-tools.test.mjs
node scripts/worker/workflow-tools-smoke.mjs --docker desktop-linux
```

最後一項只 build `workflow-tools` target。使用 explicit local Docker context、
fresh unique label/name/tag、`create --rm --init --user node --network none`，再以
`start --attach` 於程序啟動前綁定 stdout／stderr，保留快速失敗的 import error，限制 CPU／memory，
container 有 180 秒 lifetime，browser session 有 15 秒 idle deadline。
驗證 native login Python imports／version／exact apt versions、離線 CLI helper help、
YAML safe load/dump round-trip、Request.prepare（不 send）、native login PATH、
CLI version/help、commitlint 正反例、loopback HTML button
action 與 PNG screenshot。finally 關閉本次 named browser、fixture server，Stop
本輪 container 並移除 image tag，分別回報 downstream 與 lifecycle cleanup。
不使用 `close-all`、全域 container cleanup 或 prune。Docker build cache 由 engine
管理並保留，不視為存活的 browser/container。

Host harness 在任何 process launch 前，先於 checkout 外的 temp 目錄寫入
`owner.json` 並輸出 `OWNER <path>`。該 record 包含 fresh nonce／context／project／
exact labels／image tag、每步 before/after checkpoint、build 後 imageID、create 後
containerID、downstream／cleanup 狀態。`commands.log` 保存完整非秘密 command output；
長步驟每 20 秒輸出並保存 elapsed，不輸出 host environment。
沿用 repo 的 `dockerOwner`／`watchdog.mjs`，額外 current-run compose label 讓既有
25 分鐘 deadline watchdog 能清理同一 scope；正常 cleanup 後只 Stop 本次 spawn
handle。Command timeout／abort 不等待可能被 plugin child 持有的 stdio，會返回
`unknownToolOutcome`，保留 watchdog/evidence，不能將 kill CLI 當作 BuildKit Stop。
Workload budget 為 13 分鐘（build deadline 660 秒），finally 的 Docker queries 與
Stop 另有界限；被中斷的舊 run 狀態獨立保留，不以新 run 通過覆蓋。

如需重新核對 package metadata，可在同一 scoped owner 中只跑 apt metadata query：

```powershell
node scripts/worker/workflow-tools-smoke.mjs --docker desktop-linux --python-packages
node scripts/worker/workflow-tools-smoke.mjs --docker desktop-linux --python-packages arm64
```

這個明示的 metadata-only fixture 以 root、bridge network 查 signed snapshot
package indexes，不執行 helpers／browser、不安裝套件；同樣 bounded 並 finally
Stop／remove 本輪資源。一般 runtime smoke 始終 non-root、network none。

## 主 session 整合契約

`toolchain` 繼承 `workflow-tools`，既有 Node／JDK／OpenCode／ACP／profile bootstrap
維持原契約。本層不依賴 skills input。

Final `worker` stage 的 profile bundle 使用 mandatory named build context
**`worker-skills`**，來源為在 public repository 外準備的完整 compiled skills。
工具層 smoke 無此 mandatory input。
最終 worker build／驗收必須包含完整 bundle，不能以 tools-only smoke 取代。
Python3 與 helpers dependencies 已前移至此 tools layer；後續原 toolchain installer
的 `python3` apt 安裝沿用同一 snapshot，無 runtime venv/PATH 切換。
