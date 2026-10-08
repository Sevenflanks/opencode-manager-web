# Worker skills source bundle

建置契約與 rebuild 指令見 [`docs/worker-skills-bundle.md`](../../../docs/worker-skills-bundle.md)。

Docker owner 使用 `worker-skills` named build context，根目錄提供：

- `skills/<62 canonical names>/SKILL.md` 與完整 resources / helpers（60 指定 + web-design-guidelines + 必要依賴 pr-review-remake）。原 image Office 4 保留後 runtime 預期 66。
- `manifest.json`：來源 commit、原檔與 compiled 檔案 SHA-256、原始與 compiled folder hash、catalog basis、license metadata、patch-map hash（亦為 provenance）。
- `linux-patches.json`：精確原檔 preimage hash、插入位置、adapter hash 與新增 helper map。
- `licenses/<source>/`：上游 license 原檔及 `STATUS.txt`；缺授權宣告者如實記錄 unknown，不推定授權。

必要輸入為 `--build-context worker-skills=<private-artifact>/worker-skills`。
image 只 COPY 此 context 的 compiled tree，不執行 download、installer 或 upstream scripts。
缺少 context 應建置失敗，不產生 wrapper fallback。

目前來源 488 files，compiled 489 files，含 licenses/provenance 的 context 共 502 files。
整合前執行 `node scripts/worker/skills-bundle-audit.mjs <private-artifact>/worker-skills --compiled`。
audit 以此 repo 的 `compiled-lock.json` 固定 expected manifest hash（包含全部 compiled file hashes），並驗證 catalog/source-lock/patch-map digest；artifact 自改 manifest 或自帶 lock 不構成信任依據。只有 explicit `lock`／`lock-compiled` 會從已驗證原始檔與精確 patches 重算 repo lock，prepare 不自動更新。

本資料夾可提交的內容只有來源 metadata、hash lock、自有 Linux adapter 及安全 extraction 程式；**完整 upstream 技能不在 Git**。公開 CI 的測試使用合成來源，不下載私有內容。真正準備需使用已授權的官方 GitHub CLI credential store。
