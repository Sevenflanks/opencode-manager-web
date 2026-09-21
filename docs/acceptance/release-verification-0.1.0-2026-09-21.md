# `@sevenflanks/omw@0.1.0` release verification

- 驗證日期：2026-09-21
- Release：PR [#22](https://github.com/Sevenflanks/opencode-manager-web/pull/22) 已合併
- Release commit：`cb87fc68df98fc310834ac24dc4c9bddc51bccda`
- npm registry：`https://registry.npmjs.org`
- Package：`@sevenflanks/omw@0.1.0`
- Registry latest：`0.1.0`
- 結論：**release package、fresh consumer 安裝與 CLI/Manager/Web smoke 通過**；這不是完整 OpenCode TUI 或 browser UI E2E。

## Fresh consumer install

在沒有使用 repository local `.tgz` 的 fresh consumer 中執行：

```powershell
npm install --save-exact @sevenflanks/omw@0.1.0 --registry=https://registry.npmjs.org
```

結果：exit `0`，安裝 `50 packages`，`0 vulnerabilities`。Lockfile resolved package tarball 為：

```text
https://registry.npmjs.org/@sevenflanks/omw/-/omw-0.1.0.tgz
```

Artifact identity：

- integrity：`sha512-NTRofvEA8QDAY+/NxUx0rdb18TAvbEEeY8cYGdvtu8ROOtWmkB6bNjFn1w+nnyp8QdhQNWK0jHLzWZ14oKS7xQ==`
- shasum：`f3b7cdd30cd73f9ad588c0733330ac742a241d37`

## CLI/Manager/Web smoke

上述 consumer 安裝的 package 啟動後觀察到：

| Check | 結果 | 證據 |
| --- | --- | --- |
| CLI Manager 啟動 | VERIFIED | exit `0`；identity probe HTTP `200`，回報 `omw-manager`、protocol `1` |
| Web readiness | VERIFIED | HTTP `200`；HTML 包含 app container |
| Manager shutdown | VERIFIED | shutdown 回 HTTP `202`；後續 probe 無法連線 |
| Consumer cleanup | VERIFIED | 驗證完成後移除 consumer |

## Scope limits

Node help fixture 只證明 bypass 與 argument forwarding。以下項目本次沒有以真實 OpenCode TUI 或完整產品流程驗證，不能宣稱為 E2E：

- 真實 OpenCode TUI 操作。
- reservation、register、finalize lifecycle。
- browser UI 操作或完整 Web walkthrough。
- Tailnet、真手機、個人既有 OpenCode 設定與資料相容性。

因此本紀錄只支持 `0.1.0` 已在 public npm 可供 fresh consumer 安裝，以及 packaged CLI/Manager/Web 的基本啟動、readiness、shutdown smoke；不取代既有人工 TUI、mock UI 或 Tailnet 驗收紀錄。
