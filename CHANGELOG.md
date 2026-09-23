# Changelog

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
