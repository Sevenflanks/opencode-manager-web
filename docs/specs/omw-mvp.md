# OMW MVP 規格

> 狀態：已發布至 GitHub Issue #1；`ready-for-agent` 已套用。

GitHub Issue #1 是 OMW MVP 的唯一權威規格位置。本機不重複保存 full body，僅保留此指標，避免維護兩份不同狀態。

- URL：<https://github.com/Sevenflanks/opencode-manager-web/issues/1>
- 快速取得 body 與 comments：`gh issue view 1 --repo Sevenflanks/opencode-manager-web --comments`
- 需要結構化讀取 body、comments、labels 時：`gh issue view 1 --repo Sevenflanks/opencode-manager-web --json body,comments,labels`

`ready-for-agent` 僅涵蓋 Issue #1 已收斂的非敏感自主範圍；認證、Tailnet、TLS、secret、bind、Firewall、production dependency 與其他安全 gate 仍須依 Issue #1 的明確決策與授權處理。
