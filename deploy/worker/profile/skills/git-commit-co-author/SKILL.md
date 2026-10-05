---
name: git-commit-co-author
description: 準備 Git commit 訊息或執行 git commit 時，核對 remote 與授權，在 GitHub softleader repository 維護實際模型的 Co-authored-by trailer。
---

# Commit attribution

1. 確認使用者已明確授權 commit；遵循目標 repository 的訊息慣例及相關 checks，只 stage 本次預期檔案。
2. 在 receiving repository 執行 `git remote -v`。只有 remote 的 host 恰為 `github.com`、owner 恰為 `softleader`（不分大小寫；接受 HTTPS、SSH、SCP-style）才套用下列 managed attribution；其他 repository 依其適用指示。相同 repo 且 remotes 未變可沿用已核對結果。
3. 保留 human co-authors 與無關 trailers；以本輪執行環境證據辨識 optional host AI attribution，移除已辨識的 optional AI／session footer，不刪訊息中的引用範例。managed AI email 是 `noreply@softleader.com.tw`，其他 email 本身不代表 AI。
4. final trailer block 與正文空一行，且恰有一筆 `Co-authored-by: <實際模型名稱> <noreply@softleader.com.tw>`。保留 runtime 模型 version／variant，略去 context-window／reasoning-effort 註記。模型身分未知或較高優先指示衝突時先回報，不捏造、不在 commit 後用 amend 補救。
5. attribution 不授權 commit／amend／rewrite，也不修改 Git config。hook 失敗先修正再建立新 commit，不擅自 skip hooks。回報 commit hash 及驗證結果。
