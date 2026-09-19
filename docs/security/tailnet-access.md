# Tailnet 存取契約與 loopback PoC

## 已核准的決策

已核准的 MVP 形狀是 **每個 HTTPS port 一個 native root entry**：

- OMW 與所有 Manager-launched OpenCode process 繼續只 bind 到 `127.0.0.1`。
- 單一 Windows Tailscale Serve deployment 將不同的 public HTTPS ports 對應到 OpenCode 相同編號的 plain HTTP loopback ports。OMW 使用另外設定的 HTTPS port。
- Tailscale Serve 仍是終止 TLS 的 reverse proxy。OMW 不實作或承載 OpenCode 的 HTTP、asset、SSE 或 WebSocket streams。
- OMW browser routes 使用 Basic auth；launcher token 是另一組 credential，供已實作的 local reserve/register endpoints 使用，且永遠不能授權 browser routes。Managed OpenCode endpoint 不另設 Basic auth。
- 本 repository 只驗證契約與 URL mapping，不設定 Tailscale、Firewall、PATH、ACL 或 production secrets。

這是 #8 的 user-approved plan。真實 Windows Serve configuration 與 phone verification 仍屬 #9，且在 operator 明確授權外部變更前不執行。

## 為何不用 path-prefix OMW proxy

像 `/instances/<id>/...` 這種 path-prefix proxy 會讓 OMW 負責 OpenCode transport compatibility。已知風險包括 absolute asset URLs、SPA deep links、API path rewriting、SSE buffering 與 cancellation、WebSocket upgrades、PTY bidirectional framing、cookie/auth realm scope、redirect rewriting，以及不同 OpenCode versions 間的 behavior drift。HTML `200` 成功不代表這些 surfaces 都能工作。

Root-per-port 保留 OpenCode 的 native root URL 與 official route shape。它仍使用 Tailscale Serve 作為 reverse proxy，但移除 OMW 自行撰寫的 proxy 及其 compatibility surface。

## Credentials 與 request boundaries

`npm run credentials:setup -w @omw/manager` 是 interactive local TTY command。它要求 user 以 masked input 設定至少 16 字元的 OMW password，建立 random launcher token 但不顯示 token，並只將 OMW Basic credential 與 launcher token 的 Windows current-user DPAPI ciphertext 寫入 `<OMW_DATA_DIR>/credentials.dpapi`。Plaintext 透過 stdin 進入 PowerShell helper，不進 process argv。Ciphertext 以同一 directory 的 temporary file 與 rename 替換。OMW 不修改 Windows ACLs。

既有 DPAPI payload 若仍含 `openCode` 欄位，Manager 與 launcher 會相容讀取並忽略該欄位，不會自動 rotation、migration、重寫或刪除 credential file。升級不需要重跑 setup，也不會因此換掉 launcher token。

設定 `OMW_REMOTE_ACCESS=1` 時，除非以下項目全部有效，startup 才不會 fail closed：

- DPAPI credential file 存在，且可解密成 expected schema；
- `OMW_EXPECTED_LOOPBACK_ORIGIN` exactly matches `http://127.0.0.1:<OMW_PORT>`；
- `OMW_TAILNET_DNS_HOST` 是不含 scheme、path、credentials 或 port 的 lowercase `*.ts.net` hostname；
- Manager HTTPS port 與 bounded OpenCode same-port mapping range 有效且不重疊；
- `OMW_REMOTE_MAPPING_READY=1` 表示 operator 已檢查 external mapping。

OMW 保持 Fastify `trustProxy=false`。它將 raw `Host` header 與固定 loopback/public authorities 比對，並將 `Origin` 與固定 origins 比對。它永遠不從 `X-Forwarded-Host`、`X-Forwarded-Proto` 或其他 forwarded header 推導 authority 或 authorization。完成 Basic auth 後，mutations 仍須有 trusted Origin 加上 `x-omw-csrf: 1`。

成功的 managed headless 與 managed TUI launch 都會從複製的 child environment 明確移除 `OPENCODE_SERVER_USERNAME` 與 `OPENCODE_SERVER_PASSWORD`，Manager internal OpenCode API calls 不送 Basic `Authorization`。Native launcher bypass 與 Manager/DPAPI fail-open 仍原樣保留 user environment，避免改變 user 自己的獨立原生 OpenCode auth 流程。

這代表 OMW Basic 只保護 OMW，不是 OpenCode gate。經 Serve 暴露的每個 OpenCode port 可由 Tailnet policy 允許的任一 endpoint 直接存取；#9 deployment 必須把 policy 限制為 user devices。沒有 OpenCode 帳密不等於 public internet：仍須保持 Tailnet-only、不得啟用 Funnel，且不能省略 device policy。

## 設定形式

以下是 configuration shape，不是 production setup command。本文件不執行 Tailscale command；`<device>`、`<tailnet>` 與 credential values 都是 placeholders。埠號與 README 一致，僅是範例 mapping，不保證每台電腦都可 bind；仍須核對既有服務、實際 bind 與 Windows excluded range。

```powershell
$env:OMW_PORT = '40443'
$env:OMW_REMOTE_ACCESS = '1'
$env:OMW_EXPECTED_LOOPBACK_ORIGIN = 'http://127.0.0.1:40443'
$env:OMW_TAILNET_DNS_HOST = '<device>.<tailnet>.ts.net'
$env:OMW_MANAGER_PUBLIC_HTTPS_PORT = '40443'
$env:OMW_INSTANCE_PUBLIC_PORT_MIN = '40444'
$env:OMW_INSTANCE_PUBLIC_PORT_MAX = '40463'
# 只有 operator 核對 external mappings 後才設定為 1
$env:OMW_REMOTE_MAPPING_READY = '1'
```

`OMW_PORT` 的 server default 是 `4174`；上例的 `40443` 是需明示設定的 example，不是 default。Instance 範例 range 是 `40444-40463`；這些範例不保證可 bind。`OMW_REMOTE_MAPPING_READY=1` 只能在 operator 實際核對 mappings 後設定。

`OpenCodeRuntime.openUrl()` 只有在 instance port 位於已確認的 fixed range 內時，才產生 remote HTTPS URL。它不會將 remote browser redirect 到 `127.0.0.1`。Headless Start 與 opt-in Local TUI launcher 使用 [launcher contract](launcher-contract.md) 定義、由 registry 管理的 fixed pool。本 implementation 刻意不加入 Tailscale Serve management framework。

## Rotation 與 revocation

再次執行 interactive setup 會替換 OMW Basic credential 與 launcher token；之後須重啟 OMW 才會重新載入。升級到無 OpenCode auth 不需要重跑 setup，但既有 OpenCode process 必須由 user 重啟才會套用 managed launch 的 environment 清理；OMW 不會自動 stop 或 reload 真實 credentials。

只替換 credential file 不會立刻 revoke 已載入舊 OMW Basic 或 launcher token 的 process。Basic auth 也沒有可在 server side invalidate 的 browser session；browser 可能會將 credentials cache 在 origin/realm，直到 browser context 關閉或清除 credential cache。在 old processes/endpoints 停止且 clients 重新測試前，不得宣稱已完成 revocation。

## 歷史 PoC 證據

PoC 只使用 loopback listeners 與 temporary random/fake credentials，不接觸 Tailnet。以下表格只記錄
歷史 loopback PoC 證據，不可把它說成 real Tailscale 驗證，也不可把表內的 `NOT VERIFIED` 回填成
fake `PASS`。

| 面向 | 結果 | 證據 |
|---|---|---|
| OpenCode root `/` | PASS | Real OpenCode 透過保留 root 的 loopback proxy 回傳 HTML shell。 |
| Static asset | PASS | PoC 從 shell 取出實際 asset URL，並透過 proxy fetch。 |
| Session deep link | PASS | Official base64url directory route 透過 proxy 回傳 SPA shell。 |
| API | PASS | `/path` 回傳 isolated temporary Project directory。 |
| OpenCode unauthenticated health | PASS | 不帶 `Authorization` 的 `/global/health` 回傳 `200`。 |
| SSE | PASS | `/global/event` 透過 proxy 回傳 `text/event-stream` 與實際 `data:` event。 |
| PTY WebSocket | PASS | Temporary safe echo PTY 透過 proxy upgrade 並回傳 client input；PTY 在 `finally` 刪除。 |
| Two-instance transport isolation | PASS | 兩個 fake marker-protected backends 不會 cross-route，只回傳各自 backend identity；這不是 deployed OpenCode auth 證據。 |
| Listener/process cleanup | PASS | Proxy sockets/listeners 關閉，real OpenCode 以 exact identity 停止；loopback port 確認已關閉。 |
| Real Tailscale Serve/TLS | NOT VERIFIED | 保留給 #9；沒有變更 Serve configuration。 |
| Real phone | NOT VERIFIED | 保留給 #9。 |
| Firewall/PATH/ACL behavior | NOT VERIFIED | 沒有變更 external 或 global settings。 |

最新的真手機基本流程、多 Instance、TTY 與 server guards 分層證據，以及 user 對 cross-instance
同 Session live update 現況與 device policy 負面測試的決策，請以[手機驗收操作手冊](mobile-acceptance.md)
為準。user 已確認目前能接該 Windows PC 的 Tailnet devices 都由本人控管，接受本輪不另準備未授權
裝置負面測試；該項為獲准延後／`NOT RUN`，不是 `PASS`，不代表已 audit 所有 ACL。跨 Instance
同 Session 不保證 live update 是已接受限制，不新增 feature。

使用明示的 test executable 重現 real OpenCode-only PoC：

```powershell
npm run build -w @omw/manager
$env:OMW_REAL_OPENCODE_TEST = '1'
$env:OMW_OPENCODE_EXECUTABLE = '<absolute-opencode.exe>'
node --test apps/manager/dist/test/tailnet-root-poc.test.js
```
