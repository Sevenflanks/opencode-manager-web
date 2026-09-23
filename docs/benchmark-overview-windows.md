# #52 Windows overview 探測量測

## 重跑方式與邊界

Windows、Node.js 24、PowerShell 7，先執行 `npm ci`、`npm run build -w @omw/manager`，並確認已安裝的 `@sevenflanks/omw` 是 0.2.1。當時已安裝版與本分支的 `Inspect` 邏輯相同（差別在其他 helper action）；以下以該安裝版作基線。先依[開發說明](development.md#quick-start)建立此 worktree 的隔離資料，再從工作樹根目錄明確指定該隔離目錄執行：

```powershell
$baseline = Join-Path (npm root -g) '@sevenflanks/omw/dist/scripts/process-control.ps1'
$env:OMW_DATA_DIR = (Resolve-Path '.omw/development').Path
node scripts/benchmark-overview-inspect.mjs $baseline apps/manager/scripts/process-control.ps1
```

`OMW_DATA_DIR` 必須指向隔離的開發資料目錄；未設定或空值時程式會早期拒絕，不會退回讀取日常 `%LOCALAPPDATA%\OMW`。程式只讀取該目錄 SQLite 的可見 Instance metadata，複製到 in-memory repository，再透過實際 `ManagerService.overview()` 呼叫 Windows `pwsh` / `Inspect`；不呼叫既有 Instance HTTP，不寫入原資料庫，也不 Stop Instance。summary 與 remote URL verification 使用明示的無網路 fixture；因此這是 **OS Inspect 對 overview 的貢獻**，不是 live browser / HTTP 全流程 benchmark。stdout 僅列總筆數、耗時與狀態計數，不列 Instance 路徑、名稱、PID 或 endpoint。每輪依序跑兩種 helper，奇數輪先基線、偶數輪先候選，以降低固定順序偏差。cold 指當次量測程序中的第一輪，並非重開機後的冷系統。

## 結果（同一批資料）

量測當下 18 筆可見、2 筆需 Inspect；這兩筆在量測時均已失聯，每一輪都回傳 18 筆、2 筆 unreachable、0 筆 stopAllowed。summary 未被呼叫，18 次 remote verification fixture 每次最多 0 ms。下表的 Inspect 為兩個 pwsh 呼叫各自的 elapsed ms；因為並行，不可直接相加作為 wall time。

| 輪次 | 狀態／先跑 | 基線 overview wall ms | 候選 overview wall ms | 基線 Inspect ms | 候選 Inspect ms |
| --- | --- | ---: | ---: | --- | --- |
| 1 | cold／基線 | 1715 | 720 | 1625、1589 | 618、600 |
| 2 | warm／候選 | 1431 | 510 | 1378、1431 | 463、510 |
| 3 | warm／基線 | 1315 | 529 | 1260、1314 | 498、529 |
| 4 | warm／候選 | 1513 | 543 | 1472、1512 | 513、543 |
| 5 | warm／基線 | 1466 | 560 | 1425、1466 | 532、539 |
| 6 | warm／候選 | 1389 | 520 | 1339、1388 | 479、520 |

5 輪暖啟動的 overview wall 範圍為基線 1315–1513 ms、候選 510–560 ms。實作只更換 port-owner OS 查詢：由 `Get-NetTCPConnection` 改為 `netstat.exe -ano` 並解析 TCP table；`-p tcp` 在此 Windows 只查 IPv4，雙堆疊 `::` 另產生 IPv4 列，**純 IPv6 `::` 不會**，故需不指定 `-p` 才能一併取得 TCPv6。保留完整 PID、creation ticks、executable、端點重疊與 Stop 前的再次驗證；native command 失敗、空表或無法解析皆 fail closed。有效的 owned listener、純 IPv6Any 的不同 PID port owner、同 port 的純 IPv6 loopback 不重疊、identity 不符及查詢失敗透過隔離測試驗證。這次沒有運作中的 Instance，所以不能把上表推論成含真實 summary/remote network latency 的 browser wall 改善。

非英文 Windows 的 netstat state 名稱尚未在其他 locale 驗證；若 state 不在明列清單、格式無法解析，helper 拒絕結果而不回報 free / 授予 Stop。需在目標 locale 上測試可用性，不應假設英文解析能在所有語系成功。
