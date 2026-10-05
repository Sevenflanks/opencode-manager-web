---
name: linux-process-lifecycle
description: Linux 命令可能卡住、留下 child 或需跨 tool 存活時，建立本輪 process ownership、有限等待與 scoped cleanup。
---

# Linux 程序 ownership

1. 啟動前記錄 run id、用途、cwd、owner、等待上限與 Stop 方法。外部 runtime 已擁有完整生命週期時沿用其 owner contract。
2. 短命可能卡住的工作優先使用前景 `timeout --signal=TERM --kill-after=5s 60s <command>`（依實際工作調整上限）；保留 exit code，124 是 timeout，不是成功。啟動程式自行 detach 時，單靠 timeout 不構成完整 ownership。
3. 需要 server／長命 child 時用已配置、能回報 exit 並在 owner 結束時清理的 supervisor／container；只建立本輪唯一名稱與私有資料。跨 tool 存活必須保留可查詢的 owner handle，不能用 `nohup`、`disown` 或裸 `&` 丟失管理。
4. 自建 owner 必須建立獨立 session／process group，記錄 PID、PGID、啟動身分；Stop 前核對仍屬本輪，向該 group TERM，有限等待後才 KILL，reap 並確認停止。拒絕不確定、已重用或包含自身／其他工作的 group。
5. 不使用全機 `pkill`／`killall` 或名稱模糊清理；缺少 owner／Stop 契約就回報 blocker，不啟動無法收尾的程序。

完成時列出程序是否已退出、owner handle、cleanup 結果與保留原因；只刪本輪 scratch，不刪含 auth 的資料。
