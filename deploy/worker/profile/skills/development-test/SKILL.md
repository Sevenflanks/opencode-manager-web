---
name: development-test
description: 開發功能、修正 bug 或執行測試時，確認需求與 repository checks，完成最小實作並以真實證據驗證。
---

# 開發與驗證

1. 確認目標 repository／worktree、AGENTS.md、使用者要求與現有變更；從 package scripts、CI 或專案文件取得實際驗證命令。
2. 以可觀察結果及既有契約為邊界實作；新 regression test 驗證行為或 failure mode，避免只重述實作。
3. 執行最小相關驗證及專案必要 checks，命令有有限等待。通過後只因新變更、失敗或未解疑點擴大／重跑；完整 suite 集中於需要的交付節點。
4. 回報變更檔案、實際命令、exit／結果及未解問題；未執行的驗證不得寫成通過，不弱化 failing test。

## 真實模型測試

只有本輪明確授權 provider／credentials 的測試才呼叫真實模型；預設明確選 `openai/gpt-6-luna-fast`。測試本身確需更高能力才升級，記錄理由與實際模型；指定模型不可用即回報相容性 blocker，不默默替換。本規則不設定日常工作模型。
