# 發版流程

OMW 使用 release-please 維護單一 root release unit。`apps/manager`、`apps/web`、
`packages/launcher`、`packages/contracts` 與 repository scripts 的 Conventional Commits 都會進入同一份
Release PR；唯一會發布至 npm 的 package 是 `@sevenflanks/omw`。

## 版本增幅

目前沿用 release-please 的 default versioning strategy，沒有啟用 pre-major 的特別降級選項：

- `fix:` 產生 patch，例如 `0.1.0` 到 `0.1.1`。
- `feat:` 產生 minor，例如 `0.1.0` 到 `0.2.0`。
- `feat!:`、`fix!:` 或包含 `BREAKING CHANGE:` footer 的 commit 產生 major；即使目前是 `0.x`，例如
  `0.1.0` 仍會到 `1.0.0`。

也就是說，`0.x` 不會把 breaking change 自動降為 minor，也不會把 feature 自動降為 patch。若要改變這項
SemVer 契約，必須明確調整 release-please config，而不是只改文件或 commit 習慣。

## 自動流程

1. `main` push 執行 `.github/workflows/release.yml`，建立或更新一份 Release PR。
2. release-please 以 `cb87fc68df98fc310834ac24dc4c9bddc51bccda` 作為首次 bootstrap 邊界，並以
   `.release-please-manifest.json` 的 `0.1.0` 作為既有版本。這與
   [`0.1.0` release verification](acceptance/release-verification-0.1.0-2026-09-21.md) 的 release commit 相同。
3. 因內建 `GITHUB_TOKEN` 建立的 PR 不會再觸發 `pull_request` workflow，同一個 workflow 會在
   `windows-2025` 驗證 Release PR head，並將結果寫成該 head SHA 的 `Release PR validation` Check Run。
4. 合併 Release PR 後，下一次 `main` push 由 release-please 建立 `vMAJOR.MINOR.PATCH` tag 與 published
   GitHub Release。只有 `release_created=true` 時才會 checkout action 回傳的 immutable SHA，核對 tag、
   package versions 與 lockfile，然後執行 `npm publish --workspace @sevenflanks/omw`。
   publish 前會在該 immutable release SHA 重新執行 `npm test` 與 `npm run typecheck`；不依賴 Release PR
   曾經通過或 branch protection 是否要求該 Check Run。

Release PR 會同步 root、Manager、Web、contracts、launcher 的 version，Manager/Web/launcher 的 exact
`@omw/contracts` dependency，以及 `package-lock.json` 對應 workspace entries。可在本機檢查：

```powershell
npm run test:release
npm run release:verify -- v0.1.0
```

`packages/launcher/package.json` 的 `prepack` 是 package 建置與組裝入口；它會將 private contracts runtime
納入 tarball，並讓 staged Manager 使用 package 內的相對路徑，不依賴 workspace 或 consumer devDependencies。
workflow 不複製這段邏輯。

## 驗證證據邊界

`npm run test:release` 包含 repo 外的 production consumer smoke：建立真正 `npm pack` 產物、以 `--omit=dev`
安裝、使用隔離資料與每次執行隨機產生的 fixture credentials 執行 local `omw`，再核對 identity 的 product 與
protocolVersion。npm、CLI 與 Manager process tree 在 resume 前綁入本次測試持有的 Windows Job Object；正常路徑仍只
透過已確認 identity 的 Manager shutdown API 停止服務，timeout 與 finally 則以 Job close 保證不留下 late descendant。
無法確認官方停止或 Job cleanup 時會保留隔離 root 並失敗，不以 PID 或 port 猜測 ownership。

尚未在真實 GitHub Actions run 驗證 Release PR 建立或更新、`Release PR validation` Check Run、GitHub Release/tag
建立，也尚未以 npm OIDC 執行 `npm publish`。因此本文件與本機測試不構成上述外部流程已成功的驗收證據；首次
正式發版仍須核對 workflow run、Check Run、GitHub Release/tag 與 npm package metadata。

## npm Trusted Publishing

Repository maintainer 必須在 npm package `@sevenflanks/omw` 的 Trusted Publisher 設定中加入：

- Provider：GitHub Actions
- Organization：`Sevenflanks`
- Repository：`opencode-manager-web`
- Workflow filename：`release.yml`
- Allowed action：允許 `npm publish`
- Environment：留空，除非 workflow 與 npm 設定要一起改成相同 environment

Workflow 使用 GitHub-hosted `windows-2025`、Node 24、npm 11.19.1 與 `id-token: write`，不保存 npm token。
不能改用 Ubuntu 執行 `npm ci` 或 publish，因 `@sevenflanks/omw` 宣告 `os: ["win32"]`。Trusted Publishing
要求 npm CLI 11.5.1 以上、Node 22.14.0 以上及 cloud-hosted runner；Node 24 與上述 npm pin 滿足要求。

Repository 的 Actions 設定也必須允許 GitHub Actions 建立 pull request。這些 npm/GitHub 外部權限不由
repository config 自動修改。

相關官方契約：

- [release-please manifest configuration](https://github.com/googleapis/release-please/blob/main/docs/manifest-releaser.md)
- [release-please-action outputs and `GITHUB_TOKEN` caveat](https://github.com/googleapis/release-please-action)
- [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)

## 手動補發

只有自動流程已建立 GitHub Release/tag、但 npm publish 未完成時，才從 default branch 手動執行
`Release` workflow，輸入既有的 `vMAJOR.MINOR.PATCH`。

Recovery job 明確要求 workflow ref 是 `refs/heads/main`，先用 main 上的受信任 script 查 GitHub API，確認
Release 已 published 且 tag 可解析成 immutable commit，再 checkout 該 commit。package/tag/version 或 lockfile
不一致會失敗；該 immutable commit 也必須通過 `npm test` 與 `npm run typecheck`。npm registry 已存在同版本時
安全結束而不重複 publish。任意 branch、尚未存在的 Release、draft Release 或只有 branch 名稱的輸入都不能
進入 publish。
