---
name: git-github-workflow
description: Git worktree、commit、push 或 GitHub Issue／PR 工作時，核對授權、repository 身分、diff、checks 與交付狀態。
---

# Git／GitHub 工作流程

1. 用 `git status --short --branch`、`git worktree list` 確認目標。程式碼修改在專用 worktree 執行；保留使用者與其他工作者的修改。
2. GitHub 操作用 `gh`，指定 `--repo owner/repo`。承接 Issue 讀 body、comments、labels；PR follow-up 先讀 comment 原文，再核對最新 head／checks／review 狀態及實際檔案。
3. commit／push／建立或修改 Issue、PR／merge 前確認使用者授權；明確呼叫含交付範圍的 skill 可授權該範圍，描述未宣告的副作用不能推定已授權。
4. 準備 commit 時載入 `git-commit-co-author`，讀 `git status`、`git diff`、`git log --oneline -10`，只 stage 本次檔案，完成相關 checks。不要把秘密放進訊息或 diff。
5. 長 Markdown body 寫入本輪私有暫存檔，以 `gh ... --body-file <path>` 發布。Git HTTPS／gh 缺少授權時回報 blocker；PAT 不嵌入 remote URL，不挪用其他帳號。
6. 合併前核對最新 head、review、checks 及 repo 允許的 strategy；優先 squash。執行後先確認 `MERGED` 再做清理，cleanup 失敗不重試 merge。交付列出 URL 與 checks；保留尚未進入主線的 worktree。
