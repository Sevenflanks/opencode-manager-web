# Issue #91：面板 swipe 瀏覽器回歸驗收（2026-09-29）

## 修正與範圍

- 基準 `ef06ffc346dfce9b57ed64fb155e03b9e2778749`；工作分支 `fix/91-swipe-test-stability`。Windows、Node `v24.15.0`、npm `11.12.1`、Microsoft Edge `154.0.4258.37`。
- `apps/web/test/overview-refresh.test.mjs` 的啟動面板連續手勢在下一次起手前，等待 `.panel-drag-area` 返回最初的 bounding box，跨兩個 animation frame 維持位置一致，且起手中心的 `elementFromPoint` 命中拖曳區。保留 title、touchcancel、35px 短距離及 110px 達門檻關閉的原斷言；未改產品程式、延長 timeout、插入固定 sleep 或略過測試。
- 觀察到的是 Edge headless、390px viewport 的合成觸控回歸行為；未以實機觸控或其他瀏覽器宣稱相同結果。

## 執行證據

先執行 `npm ci`、`npm run build`（成功），在每次 browser 執行的 PowerShell shell 中設定 `OMW_BROWSER_TEST=1` 與 `OMW_BROWSER_EXECUTABLE=<本機 Edge executable>`。下述 browser 命令均使用既有 `scripts/isolated-entry.mjs test`，隔離 root 由專案契約保留，未清除。

1. **red**：修改前執行 `node scripts/isolated-entry.mjs test node --test --test-name-pattern='^touch panels dismiss only' apps/web/test/overview-refresh.test.mjs`；第 1 次 1 pass，第 2 次 0 pass／1 fail，`locator.waitFor: Timeout 3000ms exceeded.`，位置 `apps/web/test/overview-refresh.test.mjs:1013`，等待啟動面板 hidden。先前診斷指出前次短距離手勢之後的起手 hit-test 可能落在 `.start-panel-body`；本輪 red 證實症狀復現，未用一次成功當基準結論。
2. **green／重複**：相同 focused 命令修正後先單次通過；再串行執行 **10 次，每次獨立 Node process**，每次 1 pass／0 fail／0 skip，process exit code 均 0。各輪原輸出 totals／exit、red 錯誤、完整檔與 full suite totals、typecheck 結果見 [issue91-test-output-excerpts.txt](issue91-test-output-excerpts.txt)。重跑使用 Node 預設 spec reporter，並無各輪原始 TAP；另以 `--test-reporter=tap` 單次輸出保存為 [issue91-focused.tap.txt](issue91-focused.tap.txt)。
3. **完整相關檔**：`node scripts/isolated-entry.mjs test node --test apps/web/test/overview-refresh.test.mjs`：**31 pass／0 fail／0 skip**（已啟用 browser integration）。
4. `npm run typecheck`：contracts、manager、launcher、web 全數 exit 0。
5. **full suite**：`node scripts/isolated-entry.mjs test cmd.exe /d /s /c 'npm test'`：exit 0；release **15 pass／0 fail／0 skip**；manager **214 pass／0 fail／6 skip**；launcher **62 pass／0 fail／0 skip**；web **46 pass／0 fail／0 skip**，含 browser integration 的 31 case。manager 的 6 skip 屬另行 opt-in 的 real OpenCode 等情境，未宣稱那些測試已執行。

Windows 下第一次以 `node scripts/isolated-entry.mjs test npm test` 嘗試 full suite，在 `spawn npm.cmd` 前即因 `Error: spawn EINVAL` 失敗，沒有執行任何 suite；因此改由 `cmd.exe` 在相同隔離環境中啟動 npm，成功跑完 full suite。這是啟動器差異，不是測試失敗。
