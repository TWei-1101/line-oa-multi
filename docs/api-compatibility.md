# API 相容性：依兩個原專案實際程式核對

## 原有 HACS 使用的 API

| Method / path | Body／回應 | 本 App 行為 |
| --- | --- | --- |
| GET /api/v1/health | status=ok、version | 保留，新增 api_version=1；不含秘密或 instance |
| GET /api/v1/status | instance_id、version、gateway_status、line_logged_in、session_status、account_name、last_error、updated_at | 保留，新增 api_version=1，需 Bearer |
| GET /api/v1/aliases | aliases:[{alias,name,type}] | 保留，不回傳 chat ID，需 Bearer |
| POST /api/v1/messages/text | JSON who、message、可選 request_id | 保留，需 Bearer |
| POST /api/v1/messages/image | multipart who、image、可選 request_id | 保留，需 Bearer；JPEG／PNG ≤10 MiB |

v1 發送結果維持 submitted／confirmed／failed／unknown。submitted 與 unknown 為 202，不能把 HTTP 2xx 一律當成已確認送達。失效 Session=409；未知別名=404；缺少／無效 Key=401。request_id 可重用以查詢相同快取結果，不同內容同 ID 回409；不重送未知結果。

原 LXC 預設程式埠8790、實際專案曾設定特定 LAN 位址；這些部署值不搬入 App。App 專用內部 API 埠8787，不對 HAOS host 映射。

**與需求範例的差異**：既有 image API 拒絕附帶文字，HACS 的 image/screenshot service schema 也拒絕 `message`。為維持相容，未更動此契約。要文字時另送 `send_text`。三個 Action 名稱與 who 單一別名皆維持。

## 原 Web UI 使用的 API

Ingress listener 沿用 `/api/auth/session`、`/api/auth/logout`、`/api/status`、QR start/status/image/select/cancel、session validate、contacts 查詢／refresh、aliases GET/PUT/DELETE、messages/send、raw images 與 logs。這些管理路由不存在於內部 API listener。

取消 LXC 的前端 Key 顯示／產生／撤銷端點，改用 `/api/pairing/status` 與受保護的 `/api/pairing/reset`。取消獨立密碼登入，採 HA Ingress。這些是 App 介面必要調整，未回寫原 LXC。

## 新增 API

`POST /api/v1/pairing/exchange` 僅存在8787，使用短效秘密而非正式 Key。HACS 實作見 [配對契約](secure-pairing.md)。所有其他 v1 端點除 health 外皆須正式 Key；unknown v1 路徑也先驗證 Key。

## 0.1.6 登入原因（向後相容）

`GET /api/v1/status` 增加可選 `login_required_reason`：確認失效為 `expired`，首次尚未登入為 `not_logged_in`，本次服務執行中主動登出為 `logged_out`。正常、驗證中、網路或一般錯誤時省略欄位。舊版 client 可忽略它，API version 保持 1。

HTTP 401 才判為登入失效，403 不直接判為過期。確認失效後需重新登入。
