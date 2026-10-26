# LINE OA

透過 LINE 官方帳號傳送文字與圖片通知。支援 QR／PIN 登入、收件者別名、Ingress 管理、API v1 探索與配對。

**支援 amd64（x86-64）與 aarch64（ARM64）。** Raspberry Pi 需使用 64 位元 HAOS，不支援 32 位元 ARM。 使用 LINE 管理後台未公開聊天介面，未獲 LINE 背書。安裝前先申請官方帳號、啟用「聊天」，並讓收件者先傳訊給官方帳號。

[完整入門與 LINE 官方教學連結](https://github.com/xangin/line-oa-ha-addon#readme)。安裝後閱讀 **Documentation**，由「開啟 Web UI」登入與設定別名。

**本 Add-on 必須搭配 [LINE OA HACS 整合](https://github.com/xangin/line-oa-hacs)使用。** HACS 安裝、配對、Actions 與自動化細節，請直接參閱 [HACS repo 的說明](https://github.com/xangin/line-oa-hacs#readme)。

### 💡 0.3.0-dev.5 新增亮點
- **上游 v0.1.10 發送佇列**：每個 OA 帳號的文字與圖片共用 FIFO，依入列順序逐筆處理；等待逾時或服務停止時明確回報尚未送出。
- **取消舊版每分鐘 5 則本地限制**：升級時自動遷移，仍保留 LINE 上游限制、重複內容防護與結果不確定時不重送。
- **多帳號與 OpenClaw 相容**：每帳號佇列獨立，OpenClaw 的收件人快照在排隊前後持續驗證，不會因別名改綁而送錯對象。

### 💡 0.3.0-dev.4 新增亮點
- **Family Admission 5 種通訊模式**：支援「僅群組 @Bot 文字」、「文字喚醒詞」、「追問窗口（3 分鐘免 Tag）」、「喚醒詞 ＋ 追問窗口」及「智慧意圖過濾」，可於 Web UI 中自由切換。
- **群組按發話者隔離追問窗口**：群組中多位成員同時發問時，追問 context 依據發話者精確隔離，互不干擾。
- **啟動診斷與防護**：強化容器啟動失敗日誌、安全階段識別與資料庫保護。

沒有對外開放 TCP 埠。備份保留必要設定與登入資料，還原時從公開 GHCR 下載對應版本映像。
