# Changelog

## [0.4.2](https://github.com/Sevenflanks/opencode-manager-web/compare/v0.4.1...v0.4.2) (2026-09-25)


### Bug Fixes

* **web:** 改善目錄瀏覽、設定焦點與手機操作可用性 ([5fecc12](https://github.com/Sevenflanks/opencode-manager-web/commit/5fecc1207f6f218d47cd8773b8b8f7a3da3d7c18))
* **web:** 讓設定成功訊息在對話框內可被讀取 ([27ba0bf](https://github.com/Sevenflanks/opencode-manager-web/commit/27ba0bf0224d3916ba0ea2dcf48abafac4bc575e))

## [0.4.1](https://github.com/Sevenflanks/opencode-manager-web/compare/v0.4.0...v0.4.1) (2026-09-24)


### Bug Fixes

* **web:** 將版本號移至標題右側 ([#71](https://github.com/Sevenflanks/opencode-manager-web/issues/71)) ([d3b0737](https://github.com/Sevenflanks/opencode-manager-web/commit/d3b0737727b91e7c178753231545530a04f47b19))
* **web:** 穩定主 Session 待辦載入與更新時的高度 ([#74](https://github.com/Sevenflanks/opencode-manager-web/issues/74)) ([d9fc983](https://github.com/Sevenflanks/opencode-manager-web/commit/d9fc9831b083362c2b33ec9766f9972dbe6abfae))

## [0.4.0](https://github.com/Sevenflanks/opencode-manager-web/compare/v0.3.0...v0.4.0) (2026-09-24)


### Features

* 優化主 Session 轉導等待畫面 ([7eaba0b](https://github.com/Sevenflanks/opencode-manager-web/commit/7eaba0bb88a3ccb77829f1febf31cfc892202875))
* 優化主 Session 轉導等待畫面為安靜入口 ([a15b340](https://github.com/Sevenflanks/opencode-manager-web/commit/a15b3403abcc8d9c4e3be84841b059085a6044d7))
* 顯示目前關注主 Session 的待辦清單與進度 ([c62855d](https://github.com/Sevenflanks/opencode-manager-web/commit/c62855df67d1bd51669323a6f2e64848ca975aff))
* 顯示目前關注主 Session 的待辦清單與進度 ([3e7a6ee](https://github.com/Sevenflanks/opencode-manager-web/commit/3e7a6ee290b6c4406c74718d53b5ccb6fd69db1d))


### Bug Fixes

* 保留 Local TUI 驗證逾時的對外診斷 ([ab34540](https://github.com/Sevenflanks/opencode-manager-web/commit/ab3454050611231da329de27c5c8011dfd1daf3e))
* 修正 Local TUI 首次啟動驗證競態 ([7c94391](https://github.com/Sevenflanks/opencode-manager-web/commit/7c94391b9e066a5b4f72430e22116b63f3c7feed))
* 修正确認對話框事件綁定避免首屏渲染中斷 ([83540d5](https://github.com/Sevenflanks/opencode-manager-web/commit/83540d5097e45c1e4ad12e8a8a4d5dfd313dcdeb))
* 僅在進入主 Session 時顯示安靜入口 ([3d8102f](https://github.com/Sevenflanks/opencode-manager-web/commit/3d8102f4efcfc44825b94e4f699a2b85ac8f3834))
* 切換手機詳情時只查新目標的待辦 ([3159600](https://github.com/Sevenflanks/opencode-manager-web/commit/3159600501d3d8ac84c91b2ec7750a744b1d21ed))
* 在 Manager Stop 前保留共用身分拒絕政策 ([650f5b2](https://github.com/Sevenflanks/opencode-manager-web/commit/650f5b2b1213b4ffa3a4787dcb84ac9d2cd024e5))
* 將 OMW 版本移至標題右下方 chip ([a9e20d5](https://github.com/Sevenflanks/opencode-manager-web/commit/a9e20d5b7531a119e39a2c386ed1bc7816bed8b3))
* 將 OMW 版本移至標題右下方 chip ([a171d2a](https://github.com/Sevenflanks/opencode-manager-web/commit/a171d2a93d9c8e2dbde8d6e2b11219100e462027))
* 有界重試 Local TUI 首次 listener 驗證 ([919b109](https://github.com/Sevenflanks/opencode-manager-web/commit/919b1099bde2ade1a01f1d69e16938702fbefd12)), closes [#65](https://github.com/Sevenflanks/opencode-manager-web/issues/65)
* 補上 Manager 啟停與異常退出診斷 ([e6b7023](https://github.com/Sevenflanks/opencode-manager-web/commit/e6b7023baefe5bae4108d6677cca43ddca8be91e))
* 補上 Manager 啟停與異常退出診斷 ([8a790b5](https://github.com/Sevenflanks/opencode-manager-web/commit/8a790b506f1bec3a28910b417136dd3024b5a3ad))
* 避免取消初次驗證後的探測例外留下 starting ([5bdafc4](https://github.com/Sevenflanks/opencode-manager-web/commit/5bdafc40aff6d00c344fcaa7f0cb5f01f0281ecd))


### Code Refactoring

* 保留 OpenCode 能力並建立 Agent adapter 與刷新協調 ([38e09b2](https://github.com/Sevenflanks/opencode-manager-web/commit/38e09b2811e7299a77b0d19f87410d60f1218059))
* 抽離 overview 刷新協調並保留資料新鮮度防護 ([dced9fe](https://github.com/Sevenflanks/opencode-manager-web/commit/dced9feb995a5d6f04c8488c6c60cece7c73f3d6))
* 集中 OpenCode adapter 並隔離 Instance overview 責任 ([15f3130](https://github.com/Sevenflanks/opencode-manager-web/commit/15f3130ea719e34f6bc86d16a6cde2f7424fa698))

## [0.3.0](https://github.com/Sevenflanks/opencode-manager-web/compare/v0.2.1...v0.3.0) (2026-09-23)


### Features

* Instances 改為 Session 優先清單與狀態標籤 ([26d1614](https://github.com/Sevenflanks/opencode-manager-web/commit/26d1614b5cbe2693dc52e999a8b7f6c0c8aafb23))
* 以 Session 優先清單呈現 Instance 與狀態 ([931e637](https://github.com/Sevenflanks/opencode-manager-web/commit/931e637a13294f1cd8ec5a11adf64d3a84c40fd8)), closes [#49](https://github.com/Sevenflanks/opencode-manager-web/issues/49)
* 啟動時接替舊版 Manager 並顯示運行版本 ([ef50d4d](https://github.com/Sevenflanks/opencode-manager-web/commit/ef50d4dfbee0b31261712b9b737e806d7a427547)), closes [#46](https://github.com/Sevenflanks/opencode-manager-web/issues/46)
* 啟動時自動接替舊版 OMW 並顯示運行版本 ([cf1fc9d](https://github.com/Sevenflanks/opencode-manager-web/commit/cf1fc9dc52f13d3151604049135428f38f021276))


### Bug Fixes

* 以前景新快照及操作後驗證解除 stale ([7e8ef2f](https://github.com/Sevenflanks/opencode-manager-web/commit/7e8ef2fe3eb30d8070b16f1c86bfc97ee6fa18ad))
* 保留刷新安全狀態並隔離效能量測資料 ([7cd6eb6](https://github.com/Sevenflanks/opencode-manager-web/commit/7cd6eb6e76edc95ae5aa3db17073a2842e7236da))
* 改善 overview 刷新回饋與慢回應協調 ([4b64ab5](https://github.com/Sevenflanks/opencode-manager-web/commit/4b64ab53878de35cac444782afbddfe0431df287)), closes [#51](https://github.com/Sevenflanks/opencode-manager-web/issues/51)


### Performance Improvements

* 縮短 Windows overview port-owner 探測等待 ([94cc72e](https://github.com/Sevenflanks/opencode-manager-web/commit/94cc72e9ae6bd6b42cc2e42af5ad9bb83ce990dd)), closes [#52](https://github.com/Sevenflanks/opencode-manager-web/issues/52)

## [0.2.1](https://github.com/Sevenflanks/opencode-manager-web/compare/v0.2.0...v0.2.1) (2026-09-22)


### Bug Fixes

* 修復獨立安裝套件缺少 contracts runtime ([ef9dc8a](https://github.com/Sevenflanks/opencode-manager-web/commit/ef9dc8adc98c022308b5ad0c6f48fdb05a19bf0b))
* 將 contracts runtime 納入獨立安裝套件 ([07b5d5d](https://github.com/Sevenflanks/opencode-manager-web/commit/07b5d5d8394366d0b1e7265ef8ec51b2557ef03f))

## [0.2.0](https://github.com/Sevenflanks/opencode-manager-web/compare/v0.1.2...v0.2.0) (2026-09-22)


### Features

* **launcher:** 新增 OMW CLI 版本查詢旗標 ([2a76c2d](https://github.com/Sevenflanks/opencode-manager-web/commit/2a76c2de8f67d23a0f041826d847ec41770e0784))
* **launcher:** 新增 OMW CLI 版本查詢旗標 ([b4f97a8](https://github.com/Sevenflanks/opencode-manager-web/commit/b4f97a8399d57dce751d0ebc13955d1220147b5a))
* **manager:** 依主 Session 範圍呈現需處理狀態 ([57d32b0](https://github.com/Sevenflanks/opencode-manager-web/commit/57d32b0294c847a718aed088207f8cc47e499ab0))
* **manager:** 依主 Session 範圍呈現需處理狀態 ([1744e08](https://github.com/Sevenflanks/opencode-manager-web/commit/1744e08e509a1c4731b8ab8c24e1a85ef581037c)), closes [#34](https://github.com/Sevenflanks/opencode-manager-web/issues/34)
* **manager:** 跟隨 Local TUI 新對話更新主要 Session ([d3962ba](https://github.com/Sevenflanks/opencode-manager-web/commit/d3962bad8685764a726085d6c3287290ae076854))
* **manager:** 跟隨 TUI 新對話更新主要 Session ([59b97f0](https://github.com/Sevenflanks/opencode-manager-web/commit/59b97f042ebef897ac9a194e3b888299908f5df8))
* **web:** 整併 Session 歷史切換並加入分頁 ([b6da3db](https://github.com/Sevenflanks/opencode-manager-web/commit/b6da3db073a7a3be25cac5b7fffc8d8a2b4931e3))
* **web:** 整併 Session 歷史切換並加入分頁 ([ed366a3](https://github.com/Sevenflanks/opencode-manager-web/commit/ed366a3291cc1838160cb88f7464c2087fb66fc5))


### Bug Fixes

* **manager:** 修正遠端映射快取過期造成的明細誤報 ([d30d745](https://github.com/Sevenflanks/opencode-manager-web/commit/d30d745b569938861ea7c1fc9ae8ae90a6b91fe5))
* **manager:** 在 overview 探測後刷新遠端映射驗證 ([4aa4b55](https://github.com/Sevenflanks/opencode-manager-web/commit/4aa4b55592b4f3c63b3c6bb7e1b3bd66edb5fe5d))

## [0.1.2](https://github.com/Sevenflanks/opencode-manager-web/compare/v0.1.1...v0.1.2) (2026-09-22)


### Features

* **launcher:** 在啟動訊息顯示 OMW CLI 版本 ([2df3641](https://github.com/Sevenflanks/opencode-manager-web/commit/2df36416ca2ca6641044eba92e6e7763572bc76f))
* **remote:** 支援從本機介面啟用並保存遠端存取設定 ([114c58c](https://github.com/Sevenflanks/opencode-manager-web/commit/114c58c61f99dc6b1917dbe148b92af6b2b4c0b5))
* **remote:** 支援從本機介面啟用遠端存取並顯示啟動版本 ([68a2434](https://github.com/Sevenflanks/opencode-manager-web/commit/68a2434ce1fafb9628ded37b1b8e0f079aad44c5))

## [0.1.1](https://github.com/Sevenflanks/opencode-manager-web/compare/v0.1.0...v0.1.1) (2026-09-21)


### Bug Fixes

* **ci:** 正規化 Windows runner 暫存路徑 ([ac00623](https://github.com/Sevenflanks/opencode-manager-web/commit/ac00623b63aac1f7bf7f518b0a9d4e5ee7c9223c))
* **ci:** 正規化 Windows runner 暫存路徑 ([901295d](https://github.com/Sevenflanks/opencode-manager-web/commit/901295d6dc0f4f10bed8ab13e7dc93e73a77eab3)), closes [#24](https://github.com/Sevenflanks/opencode-manager-web/issues/24)
* **launcher:** 修正全域安裝後 omw 無輸出即結束的問題 ([ae9f856](https://github.com/Sevenflanks/opencode-manager-web/commit/ae9f8566e6651e5cd2b42051ac5005a888d9012f))
* **launcher:** 修正全域安裝後 omw 無輸出即結束的問題 ([38a207d](https://github.com/Sevenflanks/opencode-manager-web/commit/38a207d53628c290c3132bb163e88fc3ed6e0a70))
