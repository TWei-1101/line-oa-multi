# 安全配對與 HACS 介接契約

## 信任根與流程

信任 HA 管理者安裝的 App、Supervisor 與 HA Core。Supervisor 驗證 App 發布權限，Discovery get/list 只開放給 Core。持有一次性秘密是交換的認證，來源 IP、client 名稱或 instance ID 不能代替它。[安全限制](security.md) 說明 bridge HTTP 與受信任主機的剩餘風險。

1. 未配對 App 產生 `randomBytes(32)` Bootstrap Token，只放 RAM，10 分鐘有效。
2. 只透過 Supervisor Discovery 交給 Core。
3. HACS 收到 `HassioServiceInfo`，驗證 API major、instance UUID、port 與 Supervisor 的 hostname／slug，顯示**無 Key 欄位**的確認表單。不要自動建立 entry。
4. 使用者送出時，透過 Core 的 Supervisor client 重讀目前 Discovery；確認資料仍屬於同一個 App 與 instance。
5. HACS 呼叫 8787 上的交換端點一次。成功後保存專用 API Key 到 Config Entry，不保存 LINE Cookie 或 Supervisor Token。

## 交換

```text
POST /api/v1/pairing/exchange
Content-Type: application/json
{
  "instance_id":"<stable UUID>",
  "bootstrap_token":"<current secret>",
  "client":"homeassistant-line_oa",
  "request_id":"<new UUID>"
}
```

成功為 HTTP **201**：`{"instance_id":"...","api_key":"loagw_...","api_version":1}`。

格式錯誤 400；Token 錯誤／過期／已用／instance 錯誤 401；瀏覽器 Origin/Cookie/Sec-Fetch 請求 403；超過每分鐘五次全域嘗試 429。端點只存在內部 API listener，Ingress listener 沒有此端點。Body 上限 64 KiB，其他錯誤不回顯原 Body。

第一個 await 前同步取得 exchange lock，成功持久化 API 雜湊後消耗 Token。並發不能產生兩組 Key。相同 Token 即使 request_id 相同也不可再次交換。request_id 只作格式與操作關聯，不提供可重放 session。

這個單步、短效交換窗口取代額外的 pairing session endpoint，減少中間狀態；有效期、互斥與一次性限制均由 PairingManager 管理。若回應遺失，不自動重送交換，請在 Ingress 重新授權；舊 Key 會被撤銷。正式訊息 POST 同樣不自動重送。

## 保存與撤銷

Gateway `/data/secrets/api-key.json` 只保存 SHA-256 雜湊及建立時間。Key 為 256-bit 隨機值。HACS Config Entry 保存原 Key，所有受保護 API 使用 `Authorization: Bearer <key>`，不跟隨重導向。

Ingress `POST /api/pairing/reset` 需要 Supervisor 來源、有效 Web Session、CSRF 與同源檢查。它撤銷現有 Key、清除近期 HACS 連線時間，發布新的 Token。這同時提供撤銷、重新配對與輪替；沒有同時接受新舊 Key 的寬限期。

瀏覽器只能取得 `/api/pairing/status` 的 paired、pairing_available、hacs_connected、last_authenticated_at 與 discovery_status。`hacs_connected` 代表最近兩分鐘有成功驗證的內部 API 請求，不代表 LINE 已登入，也無法斷定請求者就是 HACS 程式。

損壞的 config／憑證檔會停止啟動，不默默開放重新配對或產生新身份。還原備份後可恢復，或由管理者明確重新初始化。

## HACS 相容責任

HACS 需保留 `send_text`、`send_image`、`send_screen_shot` 與四個狀態實體，手動 LXC Flow 仍使用原 URL／Key。Config Entry 建議保存 instance_id、url、api_key、connection_mode=addon、addon_slug、discovery_uuid、api_version。已配對重啟不交換；LINE Session 失效不觸發 API reauth。

本儲存庫提供 Add-on 與介接契約，不提供 HACS 整合的發行套件；請由整合維護者提供相容性說明。
