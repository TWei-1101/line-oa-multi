# 0.3.0-dev.5

- 合併原作者 `v0.1.10`：文字／圖片共用有界 FIFO，排隊逾時、斷線取消及停止服務皆以「尚未送出」處理。
- 取消舊版每分鐘 5 則本地限制；保留 LINE 上游限制、內容去重及 `UNKNOWN` 不自動重送。
- 每個 OA 帳號維持獨立佇列；OpenClaw 發送保留收件人快照檢查，排隊期間別名或登入變更不會誤送。
- 進行中的 request ID 不會因 TTL 或快取容量被淘汰，避免併發重複提交。

# 0.3.0-dev.4

- **Family Admission 5 種通訊模式自由切換**：
  - `self-mention-group-text`：僅群組 @Bot 文字（預設模式）。
  - `keyword-prefix`：文字開頭喚醒詞（喵／助理喵／小貓等開頭，不需 @Bot）。
  - `followup-window`：追問窗口模式（@Bot 觸發後 3 分鐘內同發話者免 Tag 連續追問）。
  - `keyword-or-followup`：喚醒詞 ＋ 追問窗口複合模式（最推薦 ⭐）。
  - `smart-intent`：智慧意圖過濾（以疑問句、查詢關鍵字結合喚醒詞與追問窗口）。
- **群組按發話者隔離追問窗口（Per-sender Followup Window Isolation）**：
  - 在同一 LINE 群組中，多位家庭成員連續發問時，追問 context 視窗依據發話者（User ID）獨立追蹤與隔離，徹底避免訊息覆蓋或上下文串線。
- **啟動觀察診斷與故障健全機制（Safe Startup Diagnostics & DB Safety）**：
  - 加裝防護代理與階段安全標籤，啟動異常時精準記錄 phase/code，並確保 SQLite 與網路監聽資源安全關閉，避免資源洩漏。
- **Web UI 前端管理選單完善**：
  - 更新 Web 介面（`web/multi.js`），在 Family Admission 設定中提供完整 5 種模式的視覺化下拉選單與即時說明。

# 0.3.0-dev.1

- 新增可選的 HA Webhook → Mac OpenClaw → OA Multi 文字／圖片橋接；每個帳號獨立啟用、來源綁定與 Token。
- SQLite 保存工作、完整回答與分段進度；結果不確定時保留待人工確認，避免盲目重送。
- Add-on Web UI 提供連線、來源／聯絡人綁定及失敗工作管理，無須另寫 HA automation。
- 隨附 Mac 圖片轉接程式與啟動說明；Mac／HAOS 實機端到端仍待驗證。

# 0.1.9

- 修正啟動後的狀態同步。

# 0.1.8

- 改善連線穩定性。

# 0.1.7

- 改善穩定性。

# 0.1.6

- 區分網路、CSRF／權限與登入失效。
- 狀態 API 增加可選 login_required_reason，區分首次未登入、主動登出與失效，供 HACS 正確提醒。
- HA 通知與修復提示由 LINE OA HACS 整合 0.3.2 提供，詳見其 repo。

# 0.1.5

- 新增 aarch64（ARM64）支援，Raspberry Pi 可搭配 64 位元 HAOS 使用。
- amd64／aarch64 分別原生建置、執行完整 Mock 測試與 smoke，再發布單一多架構版本。
- 驗證映像架構、HA label、Node runtime 架構一致；錯誤標籤拒絕建置。
- 新增依本機 Docker engine 架構建置的工具與驗證說明。

# 0.1.4

- 移除 Add-on 商店的「實驗性」標籤。
- 「相關文件 → 啟動與登入」同步 README 第 4 節的完整登入、重新整理、別名與通知步驟。

# 0.1.3

- 首次公開安裝版，提供 GitHub 儲存庫與公開 GHCR amd64 映像。
- README 補齊 LINE 官方帳號申請、聊天開通、別名與通知步驟，附官方圖文教學。
- 映像內包含 MIT 授權檔與 OCI 授權資訊，保留已發布映像版本。

# 0.1.2

- 排除暫存、快取與日誌，保留登入、別名、身份與配對資料。
- 改用公開 GHCR 預建映像，備份不再內含整份 runtime／Docker 映像；還原時下載對應版本。
- 新增公開安裝與 LINE 官方帳號申請／聊天設定教學。既有備份維持原樣。

# 0.1.1

- 總覽合併帳號管理，簡化登入區；新增「登出 LINE」，保留別名與 HA 配對。
- 聯絡人新增重新整理、設定別名、測試與 HA who 使用步驟。
- 分辨網頁 CSRF 與 LINE 上游錯誤，失敗紀錄保留完整回應欄位、狀態與診斷，憑證自動遮蔽。
- 應用程式日誌使用 HA 當地時區與純文字欄位，網頁紀錄支援展開詳情。

# 0.1.0

- 以 Gateway 0.5.0 封裝第一版 HA App。
- Ingress、內部 API、Supervisor Discovery、一次性配對及重新配對。
- 保留既有 LINE 通訊與 API v1。
