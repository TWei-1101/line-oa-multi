# Mac Codex 工作交接 — 2026-10-21

## 使用者目前要完成的工作

接手既有 LINE OA Multi，從 Mac 排查並完成實機流程：

LINE → HA HACS Webhook → Add-on 的持久工作佇列 → Mac OpenClaw → OA Multi 後台 Session 發送回答。

延續現有專案，不從零重寫。所有開發只限使用者的儲存庫
`https://github.com/TWei-1101/line-oa-multi`，不要修改原作者儲存庫。

目前 Windows 端無法直接連到 Mac 執行命令。本檔是可供 Mac Codex 讀取的交接資料，
不代表完整對話或執行環境已自動移轉。先確認使用者在 Mac 的工作目錄與授權，再做需要的設定。

## 程式與已完成驗證

- 分支：`main`。交接前 HEAD：`82c87a267d66f822342e99b984423126c68a6c19`。
- Add-on 版本：`0.3.0-dev.1`。既有 HACS 整合不需要重新安裝／重新配對。
- 執行程式版本：`df25afc60635dbb1c94de72d577e40ee5ebbf976`；後續提交只有文件。
- 完整 CI 已通過：https://github.com/TWei-1101/line-oa-multi/actions/runs/39570348641
- amd64／aarch64 各 94 個 Node 測試，Docker 建置、健康、私有連接埠、啟停及重啟身分測試通過。
- 兩組 HACS 各 244 個測試及 Ruff／編譯通過，較新矩陣 mypy 也通過。
- Windows 本機的部分既有測試因 POSIX 檔案權限／目錄 fsync 不適用而失敗，不能當成 Linux 發行失敗。
- Mac／HAOS／LINE 實際圖文來回、休眠恢復、備份還原、長時間運行仍待驗證。

## 實機已知狀態（使用者回報）

- HA Add-on 已安裝，畫面有三個已登入帳號：`family`、`aiassistant`、`notify`。
- `aiassistant` Webhook 已啟用；另外兩個的 Webhook 未設定。
- `aiassistant` 已有來源綁定，回答的 OA 聯絡人別名為 `me`。
- 已出現兩筆工作：

```text
aiassistant → me · 等待處理 · 0/0 段
aiassistant → me · 等待處理 · 0/0 段 · LINE_CONTENT_UNAVAILABLE
```

- 使用者已手動按「更新工作狀態」，所以不能只用「畫面沒自動更新」解釋問題。
- 尚未確認這兩筆輸入是文字還是圖片。
- 尚未確認 Mac 轉接程式是否啟動、監聽位址、Mac 區網 IP、OpenClaw 版本／Agent ID／認證設定。
- 先前儲存設定曾遇到 `OPENCLAW_CONFIGURATION_REQUIRED`，代表當時缺全域 URL、Token 或來源綁定；
  最新畫面已可進佇列，但「已設定連線」只表示 URL 有值，不代表網路探測通過。

## 下一步診斷

先讀 `docs/OPENCLAW-zh-TW.md`、`docs/OPENCLAW.md`、`VALIDATION.md`。
保留現有帳號、QR Session、聯絡人別名及工作佇列，不要用刪除重裝當作第一步。

1. 在 Mac 做唯讀檢查：`openclaw --version`、`node --version`、
   `lsof -nP -iTCP:18790 -sTCP:LISTEN`、`lsof -nP -iTCP:18789 -sTCP:LISTEN`。
2. 確認 `line_oa/app/scripts/openclaw-mac.ts` 是否已下載／執行。
   `LINE_OA_BRIDGE_BIND` 預設為 `127.0.0.1`，HA 連不到；需監聽 Mac 的可信任區網 IP。
   Add-on URL 應為 `http://MAC_LAN_IP:18790/v1/responses`，不能填 `localhost`。
3. 確認 OpenClaw Responses endpoint 已啟用，Gateway 實際連接埠、Agent ID 與認證一致。
   只有使用者既有授權足夠且變更確有需要時，才啟動／調整本機服務；注意既有其他 OpenClaw 工作。
4. 區分 Mac 沒監聽、只監聽 loopback、HA 到 Mac 路由／防火牆、OpenClaw 上游未啟動、
   認證錯誤及圖片內容下載錯誤。不要直接斷言是圖片下載問題。
5. 舊版錯誤標籤有已知缺陷：`src/openclaw.ts` 的 `process()` catch 會把安全的
   OpenClaw connect failure 轉回 pending，再共用 `LINE_CONTENT_UNAVAILABLE` 標籤。
   因此如果輸入是文字，此標籤也可能代表 ECONNREFUSED／DNS／路由／連線建立逾時。
   如需修正，將 OpenClaw 連線失敗與 LINE 圖片下載失敗分開命名並補測試，不可把所有不確定結果盲目重試。
6. 結果不確定的 AI 執行／發送會保留待檢查，避免重複工具副作用或重複發送。
   查看 LINE 實際對話後才重試；尚未確認使用者要測試的收件人／訊息前，不自行發送實際 LINE 訊息。
7. 修復後依序驗證文字、長文字分段、收到圖片的辨識、AI 產圖回傳、Mac 暫停恢復與 Add-on 重啟。
   記錄實際觀測；沒有做過的項目繼續標為待驗證。

## 重要檔案

- `line_oa/app/src/openclaw.ts`：SQLite 設定與工作、來源綁定、LINE 圖片下載、Responses 呼叫、OA 發送／重試。
- `line_oa/app/scripts/openclaw-mac.ts`：Mac HTTP 轉接程式、獨立橋接密鑰、圖片路徑轉 inline image。
- `line_oa/app/src/webhook.ts`：簽章驗證與入列，在回傳成功前持久保存。
- `line_oa/app/src/multi-server.ts`：各帳號 Gateway、設定與工作檢查路由、背景 worker 啟停。
- `line_oa/app/web/multi.js`：設定視窗與工作列表，目前工作狀態需手動更新。
- `line_oa/app/tests/openclaw.test.ts`：橋接／Mac adapter 測試。
- `custom_components/line_oa/webhook_bridge.py`：HA 接收原始 LINE Webhook，轉給配對的 Add-on。

## 連線與資料注意事項

- Token 與 Channel Secret 只在使用者本機設定，不把值輸出到對話、日誌或 Git。
- 過去對話曾包含 LINE Token；如仍在使用已曝光的 Token，需由使用者確認是否已換發。本檔不複製任何密鑰。
- Incoming LINE Channel Access Token 僅用於下載圖片，不用來發官方 Push／Reply 訊息。
- OpenClaw `/v1/responses` 是高權限 operator endpoint；使用專用 Agent 與必要工具權限。
- 回答用 JSON manifest 保留全文及圖片順序；Mac adapter 把允許根目錄內的 JPEG／PNG 轉成圖片資料。
- Mac 圖片根目錄預設為 `~/.openclaw/workspace`，不允許讀取根目錄外的路徑或 symlink。
- 不聲稱能永久避開 LINE 所有額度／限制，也不聲稱完全零漏送或 exactly-once。
- 原作者 MIT 授權與來源保留，功能修正推到使用者儲存庫並跑完整 CI。
