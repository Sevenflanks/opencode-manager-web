## Linux variant（本 Worker 使用）

下文 PowerShell workaround 與其逐項檢查僅供 Windows 使用；Linux 不要求 PowerShell，也不執行該範例。

1. 先查目標 `gh` subcommand 的 help，確認支援 `--body-file`。不支援時使用該 command 正式接受的輸入格式。
2. 在本 session 擁有的 temp 目錄用 `mktemp` 建立檔案；先 `umask 077`。以檔案寫入工具寫入原樣 UTF-8 Markdown，避免 shell expansion；已有 literal file 時可直接使用。
3. 使用 `gh <subcommand> --body-file "$body_file"`。以 `trap 'rm -f -- "$body_file"' EXIT` 或等價 owner cleanup 收尾。不以任意 Markdown 拼接 shell 程式碼。
4. 核對送出的 Markdown 內容、repo 與目標 comment/PR。`--edit-last` 只改自己的最後一則；任意 comment ID 先核對 identity，再使用正式 REST endpoint 與檔案輸入。

未有授權登入時回報 unavailable，不從 host 取得 token。上述 Linux variant 保留 body-file 的原始目的與 command 邊界，不代表所有 `gh` command 都支援該旗標。
