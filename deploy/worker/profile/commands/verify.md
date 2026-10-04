---
description: 依當前修改執行最小相關 checks，回報真實結果與未驗證範圍。
---

載入 development-test，針對 $ARGUMENTS 核對實際 worktree／dirty files 與適用 checks。執行有有限等待的最小相關驗證及專案必要 checks；不改動 failing test 以通過。回報實際命令、結果、是否需要新增驗證及 blocker。此 command 不授權使用 provider credentials 或外部寫入。
