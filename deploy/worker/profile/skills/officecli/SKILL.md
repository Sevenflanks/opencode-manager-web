---
name: officecli
description: Word／Excel／PowerPoint 或 .docx、.xlsx、.pptx 工作時，使用已安裝的 OfficeCLI 與 help 選擇格式操作。
---

# OfficeCLI 路由

先用 `OFFICECLI_SKIP_UPDATE=1 officecli --version` 與 `officecli --help` 確認 image 提供的 v1.0.153。不要裸呼叫 `officecli`（會觸發 install），也不在 Worker 啟動或操作時下載 latest。

- .docx → 載入 `officecli-docx`。
- .xlsx → 載入 `officecli-xlsx`。
- .pptx → 載入 `officecli-pptx`。

以本機 CLI help 決定精確參數與支援能力，必要時參考 [官方文件](https://github.com/iOfficeAI/OfficeCLI/tree/v1.0.153)；不要猜 property／selector。只操作本輪授權的文件，保留原件。resident／watch 只管理自己啟動的 process，設定有限 timeout；完成或逾時時 save／close 並停止自己的 process，需持續執行則在 handoff 記錄 owner 與停止方式。

Worker image 的驗收只包括 CLI 可執行與 skills 可載入；文件生成、render、截圖或 PDF 品質另依實際任務需求，不自動成為 image gate。
