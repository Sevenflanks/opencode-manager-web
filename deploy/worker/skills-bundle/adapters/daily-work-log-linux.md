## Linux Worker collector（本平台入口）

Linux 使用 `python3 <skill-directory>/scripts/collect-worker-git-evidence.py`，原 PowerShell scripts 保留來源但不在本平台執行；下文 PowerShell invocation 及 host DB/log fallback 僅為原平台參考。

必須提供 `--workspace <Worker-owned-root> --since <ISO8601-with-timezone> --until <ISO8601-with-timezone>`。時間區間為含起點、不含終點。未指定日期時由 agent 先依使用者時區算出當日起迄，再明確傳入，不能猜 host 時區。

- 預設使用 Worker 自身 `opencode session list --format json --max-count 500` 的 native metadata，僅收時間有重疊且 directory 位於 workspace 內的 repo；不讀 prompt、token logs、SQLite、host history 或跨 session memory。此介面已核對 OpenCode v1.18.34 commit `aec0b9a6d8898f68f923aaf08b7306d931fd9d76` 的 `packages/opencode/src/cli/cmd/session.ts`：JSON 包含 directory/created/updated，空清單可以是空 stdout。
- 可重複 `--repo <path>` 明確覆寫 native discovery。權限不足或 metadata 不可用時請使用者提供 repo；不改以 host scan 補齊。
- 可重複 `--author <exact-email-or-name>`；未指定時取各 repo 有效 Git user.email，缺少才取 user.name。identity 缺失回 PARTIAL 並要求 --author，絕不默用全作者。
- 收集跨 branches commits、依 author date 過濾及 hash 去重、排除 stash；native metadata 只能證明 session 時間重疊，不代表每筆對話都發生在區間內。保留有 session metadata 但零 commits 的 repo，不捏造工作內容。
- `--github` 啟用唯讀 gh 補充，用 exact commit association 找 PR，再取 closing issue numbers。沿用 Worker runtime 合法 gh 授權（包括既有 GH_TOKEN）；不讀 host token。沒有授權時保留 Git 證據並輸出 PARTIAL，不假造 PR。
- JSON 的 meta.marker / meta.partial 與 warnings 是必要報告證據。成功只代表 requested scope；未要求 --github 時不宣稱已補 GitHub。native sessions 500、repos 100、commits 10000、GitHub commits/PRs 各 40 上限，達上限明示 partial，每次 subprocess timeout 20 秒，不重試。
- 預設只輸出 repo ordinal、hash、date、PR/issue numbers 與 session count；`--details` 才含 private local subject/path。不得把 titles、cwd 或內部 URL 自動送公開服務。摘要仍需人工依已授權證據分組、揭露 partial。

這是原主要用途的 Linux bounded port，並非 Git-only fallback；不移植 host 掃描、完整 prompt 日誌、可疑的全作者 fallback，亦不宣稱與 PowerShell 每個 heuristics 相同。
