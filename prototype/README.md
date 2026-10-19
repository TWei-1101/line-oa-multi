# LINE OA Dynamic Multi-Account for HAOS — developer build

**狀態：來源碼改造 / 未通過真實 HAOS + LINE 登入測試，不可直接視為正式版。**

**安裝步驟：請優先閱讀同壓縮檔的 [`INSTALL-HAOS.md`](INSTALL-HAOS.md)。** 此版已將 Add-on slug 改成 `line_oa_multi`，但 HACS domain 仍是 `line_oa`，與原版不可並存。

基於兩份 MIT GitHub 專案：

- https://github.com/xangin/line-oa-ha-addon （檢查時版本 0.1.9）
- https://github.com/xangin/line-oa-hacs

這個資料夾內 **不含上游完整程式碼**，而是可對上游原始碼執行的可重現改造工具及新增的多帳號 Gateway 原始碼。它不會更改原作者倉庫。

## 已實作的設計

- 一個 HA Supervisor Add-on / 一個 Node.js 程序
- 在 Add-on Web UI 動態新增、刪除任意合法帳號別名（最多 20 個，非寫死 main/invest/crypto）
- 每個帳號保存獨立的 `/data/multi/accounts/<id>/secrets/line-session.json`、`aliases.json`、快取及 Session 狀態
- 每個帳號的「管理／登入」進入原作者 QR、PIN、選擇 OA、聯絡人、別名與測試發送介面
- 共用 HA Supervisor Discovery / 安全配對和 HA Bearer API Key
- HACS `line_oa.send_text`、`send_image`、`send_screen_shot` 多一個必填 `account` 欄位
- 原作者 LINE 發送器、圖像驗證、非重送策略及 Cookie 隔離仍在每個帳號實例中
- `GET /api/v1/accounts`、`GET /api/v1/aliases?account=invest`、`POST /api/v1/messages/text` 支援動態帳號

**已新增開發版 Webhook 收訊：** HACS 註冊單一公開 HA Webhook URL，將原始 LINE POST 轉送至內部 Gateway；每帳號獨立 Channel Secret / 開關；簽章驗證、destination 綁定、事件去重及持久化收件匣，HACS 每 5 秒同步並發出 `line_oa_message` 事件。**尚未包含：** OpenClaw 自動 Agent 路由、附件下載、各帳號 HA 狀態感測器、Session 自動遷移、正式可下載的多架構 GHCR 映像。

## 產生兩份完整的改造版來源

在有 GitHub 連線的開發機執行：

```bash
git clone https://github.com/xangin/line-oa-ha-addon.git
git clone https://github.com/xangin/line-oa-hacs.git
python3 line-oa-dynamic/tools/build.py \
  --addon-source ./line-oa-ha-addon \
  --hacs-source ./line-oa-hacs \
  --output ./line-oa-generated
```

修改工具使用**精確錨點檢查**。若上游更新後程式碼改變，它會停止並刪除不完整輸出，而非做可能錯誤的替換。請將產生的版本保存到**新的個人 GitHub 倉庫**，不要直接覆蓋原版。

### 檢查 TypeScript / Python

```bash
cd line-oa-generated/line-oa-ha-addon-dynamic/line_oa/app
npm ci --ignore-scripts
npm test
cd ../../../line-oa-hacs-dynamic
python3 -m compileall custom_components/line_oa
```

若 TypeScript 編譯失敗，**不得發行 Add-on 映像**。建議另外針對 Add-on 進行 Supervisor Ingress 實機測試；來源碼轉換完成不等於可正式部署。

### HAOS 安裝注意

- 上游 `config.yaml` 使用 `image: ghcr.io/xangin/line-oa-ha-addon`（單帳號映像）；修改工具會移除它，避免誤載原版。
- 要在 HAOS 商店安裝，需要先把改造版建置成自有的 amd64/aarch64 映像並使用你的 `image:` 值，或在 HAOS 上由 Supervisor 建置來源。
- **先備份 HAOS**，改造版使用自己的新 slug/來源並經充分測試後再遷移。原版 `/data` 中的登入憑證不會自動帶過去。
- Web UI 只接受經 Home Assistant Supervisor Ingress 代理的請求；不要把管理 UI 或內部 API 公開到 Internet。
- 這是第三方非公開 LINE 後台聊天路徑，無法保證不耗額度、長期穩定或遵循 LINE 未來政策。

## HA 動作範例

```yaml
action: line_oa.send_text
data:
  account: invest
  who: home
  message: "投資報告已完成"
```

`account` 為你在 Add-on 新增的帳號**別名**，不是固定的 Agent 清單。

## 發送 API

URL query 支援 API 發送兼容原作者驗證路徑：

```http
POST /api/v1/messages/text?account=invest
Authorization: Bearer <PAIRING_KEY>
Content-Type: application/json

{"account":"invest","who":"home","message":"測試通知","request_id":"<UUID>"}
```

也支援不帶 query 的 JSON 格式：`{"account":"invest","who":"home","message":"測試"}`。未指定或不存在的帳號一律拒絕，絕不回退到任意預設帳號。

圖片走 `POST /api/v1/messages/image?account=invest`，其他 multipart 欄位仍沿用原作者規格。

## 官方 LINE Webhook 接收（新增功能，開發測試版）

### 收訊架構

```text
LINE Developers Messaging API（每個 OA Channel）
    HTTPS POST /api/webhook/<HA_WEBHOOK_ID>（所有 OA 共用同一入口）
      ↓ Home Assistant Core，HACS webhook_bridge.py
    原始 Bytes + X-Line-Signature（不先解析 JSON）
      ↓ 內網 HTTP + HA 專用 Bearer Key
    Add-on :8787 /api/v1/webhook/line（不開放 Internet）
      ↓ 以每個 OA Channel Secret 驗證 HMAC-SHA256
      ↓ 對照 LINE webhook destination == 已登入 OA 的 botId
      ↓ 去重 webhookEventId、持久化 2000 筆有界收件匣
    HACS 每 5 秒讀取 /api/v1/webhook/events?after=<seq>
      ↓ Home Assistant Event Bus: line_oa_message
    HA 自動化 / Node-RED / 未來 OpenClaw Adapter
```

### 在 HA 上設定

1. 安裝**同版本的改造版 Add-on 和 HACS**（原版不支援收訊端點）。
2. 在 HA「設定 → 裝置與服務 → LINE OA」開啟「LINE OA Session Status」實體的屬性 `webhook_path`，會取得類似 `/api/webhook/<隨機ID>` 的路徑。若沒有此屬性，確認自訂 HACS 已載入且重啟 HA。
3. 使用你 HA 現有的 Cloudflared / HTTPS 對外域名，LINE Developers 每個對應 Messaging API Channel 的 **Webhook URL 都可以填同一個** `https://你的HA域名/api/webhook/<隨機ID>`；僅需讓這個公開路徑可訪問，不要把 HA 管理端點或 Add-on 的 8099/8787 直接公開。
4. 在每個 LINE OA Channel 的 Basic settings 取得 **Channel Secret**。登入 Multi Add-on Web UI，點該帳號「Webhook 設定」，輸入專用 Secret 並啟用。請不要把 Secret 貼到聊天室、公開日誌或 GitHub。
5. 使用 LINE Developers 的 Verify URL（會發出空 `events` 的官方測試事件）確認 HTTP 200，再讓測試帳號傳送文字。LINE 官方要求迅速回 200；網路延遲或 HA 停機可能造成重送。
6. 在 HA「開發者工具 → 事件」，監聽 `line_oa_message`，確認收到 `account`、`text`、`webhook_event_id` 與來源欄位。也可以在自動化使用此事件觸發，但必須限制允許的 user_id，不可直接把任何陌生人傳的指令當成 HA 控制命令。

> **重要：** 設定官方 Webhook URL 可能覆蓋該 LINE OA 原先使用的 OpenClaw / 其他服務 URL。同一 Messaging API Channel 一般只有一個主要 Webhook Endpoint。先在測試 OA 驗證，暫時不要改正在工作的 LINE OA。LINE 官方已說明 Chat 與 Webhook 可以並用，但非公開後台發送與這種收訊組合仍需實測。
>
> 現階段**僅接收並產生 HA 事件**，不會自動轉送 OpenClaw 也不會自動答覆；待加入 Agent Adapter 後才會有完整 LINE ↔ OpenClaw 對話。
>
> Gateway 驗證簽章使用每個 OA 的 Secret、原始 body bytes、`timingSafeEqual`，並要求 LINE `destination` 等於登入 OA 的 botId。因此**帳號必須先登入 LINE OA 後台**，否則 Webhook 會因綁定無法確認而拒絕。API Key 及 Channel Secret 存在 HA Add-on 的受保護資料目錄。

### HA 事件自動化範例（只記錄測試訊息）

```yaml
alias: LINE OA Webhook test
triggers:
  - trigger: event
    event_type: line_oa_message
    event_data:
      account: invest
conditions:
  - condition: template
    value_template: "{{ trigger.event.data.user_id == 'U<你的允許使用者ID>' }}"
actions:
  - action: logbook.log
    data:
      name: LINE OA
      message: "收到文字：{{ trigger.event.data.text | default('非文字事件') }}"
```

這只是安全的測試模板，不會觸發 OpenClaw。Webhook 官方收訊本身不消耗 LINE Messaging API Push 額度；回訊仍要額外串接 Reply API 或既有的非官方 OA Chat Sender。

### Webhook 相關內部 API

| 方法 | 路徑 | 說明 |
| --- | --- | --- |
| `PUT` | `/api/accounts/<account>/webhook` | 僅 Ingress UI + CSRF，設定 enabled/Channel Secret |
| `POST` | `/api/v1/webhook/line` | 只限配對的 HACS Bearer Key，傳入未加工的 LINE JSON 和原始簽章 |
| `GET` | `/api/v1/webhook/events?after=<seq>` | 僅限配對 API Key，批次讀取持久化接收事件 |

目前收件匣上限 2000 筆，超出時舊事件被淘汰；Cursor 可追蹤中斷後的事件缺口，但不是無限制、保證一次交付的正式訊息佇列。HA 事件對外下游也應依 `account + webhook_event_id` 去重。

## 限制與安全

- 移除帳號會**永久刪除**它的 Cookie/Session/別名。請先執行 HAOS 備份。
- 只有一個單一 HA HACS 整合和聚合狀態；沒有自動新增各帳號的 HA Entities。
- 同一個 LINE 管理者登入多個 OA 的後台 Session 能否同時長期保持有效，需真實 LINE 測試。
- 原專案和改造版均需遵守 LINE 平台使用規範，非官方 Web Chat API 隨時可能變更。
- 初期建議使用兩個測試 OA，小量測試文字及圖片。遇到 UNKNOWN 不要自動重送。

## 本次驗證範圍

在隔離的原始碼片段 fixture 上，Python 修改工具的 smoke tests 通過；`multi-server.ts` 及 `webhook.ts` 在模擬相依模組下通過 TypeScript 5.8.3 型別檢查；新增 `webhook.ts` 另通過本地 HMAC、destination、去重、持久化測試；`multi.js` 通過 `node --check`。**這不等於**完整原專案 `npm test`、Home Assistant pytest、HAOS 部署或 LINE 真實帳號 E2E 測試已通過。
