# Worker live browser 驗證

在 repository root 執行：

```powershell
node scripts/worker/verify-compose.mjs --context desktop-linux --browser --browser-executable "C:/Program Files/Google/Chrome/Application/chrome.exe"
```

Runner 使用本輪 synthetic Basic auth、隔離 browser profile 與全新 Compose volumes，工作期限 20 分鐘，watchdog 22 分鐘；失敗也執行 scoped cleanup。只檢視 provider 方法，不進行 OAuth 或真實 LLM。

## 實測 mobile 原生入口

1. OMW 瀏覽 `/workspace/verification-project`，Start，再建立並開啟 New Session。
2. 等原生 Session／Changes、輸入區、Send 與 model selector 顯示。`#root` 有 child 不足以證明 app 就緒。
3. 點左上 **Home**，等 **Search sessions** 出現。
4. 點可見的 **Settings** → **Providers**。
5. 找 **OpenAI** 那一列的 **Connect**。這只是顯示 login methods。
6. 確認 **ChatGPT Pro/Plus Headless** 方法可見，停在這裡；runner **不點** Browser、Headless 或 API key，不啟動授權。

原生 Home／Settings／Providers 入口以實際 mobile DOM 為準。OpenCode backend `/global/health` 固定為 `1.18.34`；官方 Web assets 的 Settings 版本標籤另存於 `browser.nativeUiVersion`，不能把 backend pin 當成 Web bundle 版本證據。相關官方 source：[`settings-v2/providers.tsx`](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/app/src/components/settings-v2/providers.tsx)。

## 證據與失敗診斷

- `evidence.json` 的 `browser` 記錄實際步驟、版本、JS/CSS 與 SSE/WS 計數、OAuth blocked 次數及 browser cleanup。
- `omw-ready.png` 等 overlay 移除、有限 transition 結束後拍攝；原生截圖要求上述 observable DOM 就緒，截圖停用動畫以免 perpetual indicator 阻擋拍攝。
- `native-session.png`、`native-openai-methods.png` 與對應 `.dom.json` 證明 composer 及方法清單可見；空白 root 不能算成功。
- native 診斷只保存有限的 error 分類／console 分類、endpoint pathname（省略 query）、HTTP status／request failure code，以及 synthetic 頁面的有限 DOM text／control labels。失敗另存 `native-failure.png`／`.dom.json`。
- 不保存 headers、auth response/body、event payload、cookies、storage 或 trace；native provider/auth/integration 的非 GET request 全部阻擋，外部 origin 全部阻擋。
- Start evidence 保留 HTTP status、error code 與 duration；失敗不被後續 outcome／cleanup 掩蓋。

自動成功只涵蓋方法清單顯示與無 LLM 流程。真實 device auth、model reply、工具寫檔、in-flight manager restart 及 provider auth recreation 仍須另外驗收。
