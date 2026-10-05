---
description: 整理開發交付證據；只執行使用者在本輪明確列出的 commit／push／Issue／PR 操作。
---

載入 git-github-workflow 與 development-test，核對 $ARGUMENTS、實際 diff、必要 checks 與使用者本輪交付授權。預設只整理檔案、決策、驗證及 blocker；使用者明確指定 commit／push／建立或更新 Issue／PR 才依該範圍執行。準備 commit 必須先載入 git-commit-co-author。回報實際 hash／URL；不把這個 command 單獨視為 merge、credentials、deploy 或未指定發布操作的授權。
