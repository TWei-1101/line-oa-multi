# LINE OA Dynamic Multi-Account + Webhook: HAOS 安裝與測試（開發版）

> 此壓縮檔**不是**可直接由 HAOS 商店匯入的 Add-on，且未通過完整上游編譯、HAOS 及真實 LINE 端到端驗證。**請在 HAOS 測試實例上先操作**，不要直接覆蓋已正常運作的 LINE OA HACS。請勿把 `/data/secrets`、LINE Cookie 或 Channel Secret 發到 GitHub。原作者使用非公開 OA Chat API，可能隨時失效。

## A. Mac mini 準備

需要 Node.js 24、Python 3、Git。把本 ZIP 解壓到 `~/Downloads` 後開啟 Terminal：

```bash
cd ~/Downloads
node --version
python3 --version
# 若檔案解壓後位於別處，請修改下列路徑
ls line-oa-dynamic/tools/build.py

git clone https://github.com/xangin/line-oa-ha-addon.git
cd line-oa-ha-addon
git checkout afb9fe582013a50324a8aa9f7e04cfd5d2338000
cd ..
git clone https://github.com/xangin/line-oa-hacs.git
cd line-oa-hacs
git checkout 977980f149e8fc0d4a9f5ccaed3a1455b8c1b904
cd ..
python3 line-oa-dynamic/tools/build.py \
  --addon-source ./line-oa-ha-addon \
  --hacs-source ./line-oa-hacs \
  --output ./line-oa-generated
```

若出現 `anchor expected once`，表示上游來源與改造工具不相容，**不要繼續部署**。

## B. 先測試完整原始碼

```bash
cd ~/Downloads/line-oa-generated/line-oa-ha-addon-dynamic/line_oa/app
npm ci --ignore-scripts --no-audit --no-fund
npm test
cd ~/Downloads/line-oa-generated/line-oa-hacs-dynamic
python3 -m compileall -q custom_components/line_oa
```

- **只在兩項檢查皆成功、且你願意在測試 HAOS 承擔未實測風險的前提下**，才進行以下步驟。
- `npm test` 通過也只是程式單元測試，**不代表 LINE 登入、Supervisor Ingress、Webhook 真實環境測試完成**。
- 若 Node 不是 24，先切到 Node 24。請勿用 `npm install --force` 掩蓋相依問題。

## C. 安裝本地 Add-on 到 HAOS 測試環境

1. 在 HAOS 執行完整備份。安裝 Samba Share app（或使用具備存取 `/addons` 的 SSH 開發方式）。
2. 用 Mac Finder → `前往` → `連接伺服器`，開啟 `smb://<HA-IP>`。開啟 Samba 提供的 `local_apps` / `addons` 分享（名稱以目前版本及設定為準）。
3. 將 `~/Downloads/line-oa-generated/line-oa-ha-addon-dynamic/line_oa/` **整個資料夾內容**複製到 HAOS 的本地 Apps 路徑 `/addons/line_oa_multi/`。必須包含 `config.yaml`、`Dockerfile`、`app/` 等檔案。不要只複製 `app/`。
4. 在 HAOS **設定 → 應用程式（Apps）→ 安裝應用程式**，重新整理商店。於「Local Apps」找到 `LINE OA Multi`。
5. 按「安裝」。本改造版的 `config.yaml` 不含 `image:`，因此 Supervisor 會嘗試在 HAOS 本機建置 Docker image；它需要連線下載 Node 24 base image 與 npm 依賴，並占用部分 CPU/RAM。**失敗就查看建置日誌，不要繼續 HACS 安裝。**
6. 安裝並啟動後，在 Add-on 頁面按「開啟網頁 UI」。點「新增帳號」→ 輸入任意帳號別名 → 點「管理／登入」進行 QR 掃碼。先只測一個測試 OA。

改造工具會將 Add-on `slug` 設為 `line_oa_multi`，避免與上游 `line_oa` slug 衝突；但是 **HACS 整合的 domain 仍是 `line_oa`**，所以同一 HA 實例無法把原版 HACS 和改造版 HACS 並存作為兩個獨立整合。對已使用原版者，請先在可回復的 HAOS 測試環境驗證，不要直接覆蓋 `/config/custom_components/line_oa`。

## D. 在測試 HAOS 安裝修改後 HACS

1. 若已安裝原版 `line_oa` HACS，**先備份** `/config/custom_components/line_oa` 和 HAOS，建議先在另一台測試 HAOS 繼續，不要直接覆蓋。
2. 將 `~/Downloads/line-oa-generated/line-oa-hacs-dynamic/custom_components/line_oa/` 整個資料夾複製到測試 HAOS `/config/custom_components/line_oa/`。
3. 重啟 Home Assistant Core。到「設定 → 裝置與服務」新增／配對 `LINE OA`，完成 Supervisor Discovery / 一次性配對。
4. 開發者工具 → 動作，先以一個已確認別名的接收者測試：

```yaml
action: line_oa.send_text
data:
  account: test
  who: home
  message: "LINE OA 多帳號測試"
```

`account` 是 Add-on Web UI 建立的帳號別名，不是 OA 顯示名稱。

## E. 設定 Webhook（僅在收發基本測試成功後）

1. 在對應官方帳號 LINE Developers Messaging API Channel 取得 **Channel Secret**（不是 Channel Access Token）。
2. 在 Add-on 多帳號 Web UI 的帳號「Webhook 設定」填入 Secret 並啟用。
3. 到 HA `LINE OA Session Status` 感測器屬性讀取 `webhook_path`，例如 `/api/webhook/<opaque-id>`。
4. 使用你已有的 HTTPS/Cloudflared 設定公開 **該 HA Webhook 路徑**，不要公開 Add-on 的 8099/8787 內部 API 或管理頁面。
5. 在 LINE Developers 設定官方 Webhook URL 為 `https://你的域名/api/webhook/<opaque-id>`，啟用 Webhook 後使用 Verify。當有多個 OA 時此入口可共用，由 Channel Secret 與 destination 區分；但**不可將既有 OpenClaw LINE Webhook 靜默覆蓋**。
6. HA 開發者工具 → 事件 → 訂閱 `line_oa_message`，讓測試 OA 傳送文字，檢查 `account`、`user_id`、`text` 等資訊。

此版本**只將通過驗證的訊息轉為 HA 事件，不會自動回覆，也尚未實作 OpenClaw Adapter**。不要把不受信任的 `line_oa_message` 直接接到 HA 執行敏感動作；請加入 user/group 白名單。

## F. 常見問題

- Add-on 商店找不到：確認複製的位置在 `/addons/line_oa_multi/`，包含 `config.yaml`，刷新商店，必要時重啟 Supervisor。
- Add-on 編譯失敗：看 Supervisor build log；常見是 GitHub、Node base image、npm 下載連線問題，或修改後 TypeScript 不相容。
- 無法登入：先查看 Add-on log、LINE OA 後台登入狀態；請勿將 Cookie、API Key、Channel Secret 貼出。
- HACS 看不到：確認 `custom_components/line_oa/manifest.json` 存在，重啟 Home Assistant Core，再進「裝置與服務」新增。
- Webhook Verify 失敗：先確認 HTTPS、來源路徑、HACS 已載入；若 401/403，檢查 Channel Secret/destination 是否符合；勿為了通過 Verify 而關閉簽章驗證。

## 紀錄來源

- 上游 Add-on commit: `afb9fe582013a50324a8aa9f7e04cfd5d2338000`
- 上游 HACS commit: `977980f149e8fc0d4a9f5ccaed3a1455b8c1b904`
- 文件： https://developers.home-assistant.io/docs/apps/configuration/ 、 https://www.home-assistant.io/common-tasks/os/
