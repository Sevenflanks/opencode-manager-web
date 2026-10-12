# Session plugins 上游授權

- `@prevalentware/opencode-goal-plugin@0.1.60`：MIT。原始 `LICENSE`、README、package metadata 與完整 npm 檔案保留於 artifact 的 `sources/`。
- `opencode-command-inject@1.3.1`：package metadata 與 README 宣告 MIT。固定 commit `14787ebc26c950c3410330837be2314971218ea4` 的 Git tree 及 npm package 均沒有獨立 LICENSE；保留原始宣告與完整 npm source，不自行捏造 upstream copyright notice。
- Bundle 實際使用的第三方 dependencies 也保留完整 npm source、LICENSE／notice／package metadata；精確版本與 integrity 見 `artifact.json` 及 `source/package-lock.json`。

本 artifact 僅載入 server entry。Goal 的 `@opentui/solid`、`solid-js` peers 是 TUI 所需；不是上游宣告的 optional peers。以 `.npmrc` 的 `legacy-peer-deps=true` 明確省略它們，build 的實際 import graph 不可出現這些依賴。`@opencode-ai/plugin@1.18.34` 自身的 OpenTUI peers 為 optional，同樣不納入。此安排不宣稱完整 TUI package 的 peer 驗證通過。
