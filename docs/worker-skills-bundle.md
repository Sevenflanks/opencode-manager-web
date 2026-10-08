# Worker skills bundle

## 契約

#108 bundle 為 **60 指定 + web-design-guidelines + 必要 transitive pr-review-remake = 62 skills**。原 image Office 4 由 image owner 保留，整合 runtime 預期 66。原始 selected tree 488 files；compiled 保留完整目錄並增加一個 Linux collector，共 489 files。references/scripts/templates/tests/evals 都保留，但 prepare 不執行 upstream 程式。

來源是已選 installed catalog 對應的 pinned upstream revision，**不能宣稱 same-as-local**。主 session 的 SKILL.md 正規化比對回報為 56 相同、6 有差異：ask-matt 的 upstream debug flow／retro、implement 的 explicit skill call、to-tickets 的 native blocking links 模板、handoff 的 TMPDIR 範例、pr-review-remake 的 report format inline instructions、i-have-adhd 的 example edit 取代 jsonwebtoken install。本元件未讀 host 技能；這是主 session 提供的比對摘要，references／scripts 未逐檔比對，仍為 unknown。固定 revision 是本 bundle 的可重建依據，不新增版本確認 gate。排除 agent-process-lifecycle/self-challenge，不自動加入其他技能或 commands。

## 固定來源

| Source | Commit | 數量 | License |
| --- | --- | ---: | --- |
| mattpocock/skills | `6fd947921b935b7e1e69293a200400f0fdd5c15f` | 27 | MIT |
| softleader/agent-skills | `1793486530d94dc65156581aed4b96f09ac22299` | 22 | 使用者授權 private internal Worker / Harbor |
| Sevenflanks/skills | `edf3f78afdf204bd23b048cf9c537f24c2f10d1e` | 10 | MIT |
| ayghri/i-have-adhd | `723af7d9afaf43eb871dbcce6129e2bf80de90d5` | 1 | MIT |
| microsoft/playwright-cli | `b85c7a736bb473bf55b584e54a09ffa698d6d871` | 1 | Apache-2.0 |
| vercel-labs/agent-skills | `063bee94c3f4df8453406c830b0a7df0f2860278` | 1 | unknown；使用者授權 private build，保留 NOTICE，不宣稱 MIT |

Vercel selected tree 無 root LICENSE/NOTICE 或 skill license 宣告；尚未發現明文禁止內部使用。此事如實記錄，不額外阻擋已授權的 private build，不公開 source。

真實 tree：Matt grilling/teach 在 skills/productivity；Softleader github-issue-conventions 在 plugins/operations/skills；pr-review-remake 在 plugins/wip/skills。後者的 7 個原檔全納入，保留 remake default，不改成 pr-review。

## Metadata 與安全

- `deploy/worker/skills-bundle/sources.json` 固定 allowlisted repo、完整 commit SHA、selected folders。
- `source-lock.json` 記錄完整 per-file SHA-256、folder hashes、root license hashes。
- repo 的 `compiled-lock.json` 固定 expected manifest SHA-256，並綁定 repo catalog、source lock、patch map 的 JSON digest。expected manifest 由已驗 raw hashes 的原始檔與精確 Linux patches 推導，涵蓋每個 compiled file／folder hash。audit 不信任 artifact 自帶的 hash lock；同時改 script 與 manifest 的自洽偽造也必須拒絕。
- folder hash：排序後串接 `path + NUL + fileSha256 + LF` 再 SHA-256，不是 Git tree object ID。
- `linux-patches.json` 只有原檔 preimage hashes、精確位置與 adapter hashes，不含 private upstream preimage 全文。
- 自有 text adapter canonical LF；upstream source/license bytes 不做換行轉換。
- 解包拒絕 traversal、symlink/hardlink/device、重複、Windows aliases/streams；每檔上限 16 MiB、selected 總量 128 MiB、download 256 MiB。
- hash mismatch、missing reference、conflicting name、nested SKILL.md 均 fail closed；inline/fenced examples 不當成需要打包的 resource。
- prepare 固定官方 github.com API、full-SHA tarball，只經已登入 gh credential store，移除 inherited token overrides，不直接讀 host token；不回顯 payload 或 subprocess stderr。
- Linux artifact root 0700 / files 0600；Windows 下載前移除 inherited ACL，僅授目前 identity。artifact 必須在 checkout 外且不存在。

## Rebuild / integration

需要 Node.js、Python 3、gh。Linux 用 python3，Windows 用 python。

```text
node scripts/worker/skills-bundle.mjs --help
node scripts/worker/skills-bundle.mjs prepare --output <NEW-PRIVATE-DIRECTORY>
node scripts/worker/skills-bundle.mjs prepare --output <NEW-PRIVATE-DIRECTORY> --sources <EXISTING-PRIVATE-ARTIFACT>/sources
node scripts/worker/skills-bundle-audit.mjs <NEW-PRIVATE-DIRECTORY>/worker-skills --compiled
```

只有 maintainer 明確升版／改 adapter 時用 `lock --output <ANOTHER-NEW-PRIVATE-DIRECTORY>` 更新 source lock、patch map 與 compiled lock，review 後再 prepare。若原始檔及既有 patch map 未變，可明確執行 `node scripts/worker/skills-bundle.mjs lock-compiled --sources <EXISTING-PRIVATE-ARTIFACT>/sources`：逐檔驗證 raw SHA、license hashes、patch preimage／adapter hashes，再推導 compiled lock；不從收到的 artifact manifest 產生 expected hash，也不重新下載來源。prepare／audit 遇 mismatch 不改 lock，須停止並調查，不得用 regeneration 掩蓋非預期差異。只有 prepare 成功且 audit 通過的 context 才能交給 image build。

Docker named context 固定 `worker-skills`，路徑為 `<artifact>/worker-skills`：

```text
docker buildx build --build-context worker-skills=<artifact>/worker-skills ...
```

內容為 `skills/`、`manifest.json`（來源與 compiled provenance/hashes）、`linux-patches.json`、`licenses/`。只 COPY 此 context，不 COPY parent 的 source tarballs / sources。缺 bundle 不可 wrapper fallback。Dockerfile/bootstrap/profile 由各 owner 整合，本元件不改它們。

## Linux daily-work-log

Linux 使用 `python3 <skill-directory>/scripts/collect-worker-git-evidence.py`，不執行保留的 PowerShell 原檔。

```text
python3 <skill-directory>/scripts/collect-worker-git-evidence.py --workspace <Worker-owned-root> --since <ISO8601> --until <ISO8601> [--repo <path>] [--author <email-or-name>] [--github]
```

- 時間含起點、不含終點；無日期時由 agent 依使用者時區算出當日起迄後明確傳入。
- native discovery：`opencode session list --format json --max-count 500`，只解析 Worker 自身 directory/created/updated。空 stdout 為空清單；不讀完整 prompt、token logs、SQLite、CLI history 或 host 檔案掃描。
- 介面已以 OpenCode v1.18.34 commit `aec0b9a6d8898f68f923aaf08b7306d931fd9d76` 的 `packages/opencode/src/cli/cmd/session.ts` 核對。native root sessions 的時間重疊只是 metadata evidence，不假稱區間內完整對話。
- directory 與 Git root 必須位於明確 workspace realpath 內。`--repo` 可重複，覆寫 discovery；缺 native 權限時要求 repo，不 host scan。
- `--author` 可重複 exact name/email；缺省讀每個 repo 有效 user.email，其次 user.name。無 identity 回 PARTIAL 並要求 --author，絕不默收全作者。
- 跨所有 branches 收 commits，依 author date 過濾、hash 去重、排除 stash；不以 Git committer-date filter 漏掉不同 commit date 的資料。
- `--github` 使用 runtime 現有合法 gh 授權（可含 GH_TOKEN），按 exact commit 查 associated PR，再讀 closing issue numbers。不沿用 prepare 的 credential-store-only 規則限制 runtime；缺授權保留 Git evidence 並回 PARTIAL。
- 預設只回 repo ordinal、hash/date、PR/issue numbers、session count。`--details` 才輸出 private local subject/path；沒有任何 publication 操作，不自動公開 cwd/title/內部 URL。
- meta.marker 為 PARTIAL 或 COMPLETE_WITHIN_REQUESTED_SCOPE；meta.partial、warnings 必須進入人類摘要。未要求 GitHub 不宣稱已補 GitHub；沒實際查 API 時 ghAvailable 保持 unknown。
- 每 subprocess timeout 20 秒、不 retry、不 background。上限 sessions 500、repos 100、commits 10000、GitHub commits/PRs 各 40，達上限回 partial。上限是資料／呼叫總量邊界，不是无限追舊 session。

這是 bounded Linux port，非舊版 Git-only degraded helper。保留原 PowerShell 的 repo/session/time/identity/跨 branch/PR 關聯主要用途；不移植 host 掃描、DB/log fallback、缺 identity 全作者 fallback，亦不聲稱 bot/release heuristics 或 PowerShell compaction 完全等價。

## Remaining capability 分類

- **已解必要 dependency：** pr-review-remake 已納入；其 app-design、kapok-app-design、jasmine-app-design 出現在 project coding-standard 範例／依專案存在才讀取的文件，非預设必要新增技能。
- **已適配 Windows entry：** daily-work-log 的 `.ps1` invocation 保留為來源參考，Linux 入口改 Python；gh-body-file 的 PowerShell snippets 僅供 Windows，Linux variant 用 literal UTF-8 temp file 與 gh --body-file。
- **平台範例仍保留：** push-post-pr shell-execution reference、release-workflow 及 Kubernetes troubleshooting 的 Windows 分支，不能視作 Linux 必須呼叫 pwsh。generate-ut-report 的 html-report-contract 只在 Windows 條件下要求 regex 單引號，不構成 Linux blocker。共用 runtime adapter 明示只有核實的 Linux 等價操作可執行，否則 unavailable；不做 wide-pattern 刪文。
- **正常 unavailable：** Jenkins/Kibana/Kubernetes/Mantis/ERP/GitHub 的外部授權與服務能力；不複製登入設定。
- **按需 capability lookup：** Office/PDF/圖表/renderers、專案特定 coding standards，不為此全裝 heavy dependencies。未執行實際服務與所有技能端到端操作，不宣稱全部 offline。
- web-design-guidelines 原本在 review 時讀遠端最新規則；pin 的是技能流程，遠端規則是 runtime input，缺網路須明示。
- excluded skills 不會 re-add；Linux process 使用 timeout/owner/exit/cleanup 基本契約，不創同名 wrapper，不使用 Manager heartbeat/OMO_INTERNAL/session memory hard dependency。

## Tests

```text
node --test scripts/worker/skills-bundle.test.mjs scripts/worker/skills-bundle-collector.test.mjs scripts/worker/skills-bundle-audit.test.mjs
python -B deploy/worker/skills-bundle/tests/collector_test.py
node scripts/worker/skills-bundle-audit.mjs <artifact>/worker-skills --compiled
```

公開 tests 共 27 個 Node cases（包含 collector wrapper 的 14 個 Python cases），用 synthetic data、fake CLI responses、隔離 temp Git object database。日期/author/去重/PR-chain/缺授權/native timeout/partial/privacy 皆有驗證；不搬真 repo 資料。audit regression 先確認正常 fixture 通過，再驗證 repo metadata 改動、同改 script／compiledFiles／folder hash／manifest 及 artifact 偽造 lock 都無法通過。此攻擊 fixture 在修正前得到 `Missing expected rejection`，修正後通過。audit 回傳完整 context hashes/counts，不输出 upstream 內容。所有子程序有 timeout，沒有服務或模型呼叫。
