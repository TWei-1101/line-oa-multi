# Supervisor Discovery

## 配置與發布

`config.yaml` 使用 `discovery: [line_oa]`。依目前官方規範，Discovery 與 `/addons/self/info` 是基礎端點，因此 **不需要 `hassio_api: true` 或 manager/admin role**。

兩個 HTTP listener Ready 後，`src/discovery.ts` 呼叫 `GET /addons/self/info` 取得 `hostname`，再以 `SUPERVISOR_TOKEN` 的 Bearer Header 呼叫：

```text
POST http://supervisor/discovery
{"service":"line_oa","config":{
  "host":"<Supervisor hostname>","port":8787,
  "instance_id":"<stable UUID>","api_version":1,
  "pairing_required":true,
  "bootstrap_token":"<ephemeral 256-bit secret>",
  "bootstrap_expires_at":"<ISO timestamp>"
}}
```

範例只列欄位，沒有實際秘密。此 config 不提供給 Web UI、health、mDNS 或日誌。已配對時保留公開身份與 `pairing_required:false`，移除 Bootstrap 欄位。

## 更新與重啟

Publisher 每 30 秒重試相同資料；Token 10 分鐘過期後更新。Supervisor 以 **App + service** 去重；相同 config 不重送，改變 config 更新原 UUID。因此不反覆新增不同 Discovery message。

Supervisor 把 Discovery 保存到磁碟；Core 啟動會讀取已啟動 App 的資料。App 重啟只換 RAM 中的未配對 Token，永久 instance ID／Key 保留。Supervisor 暫時離線時只重試，不改 Session。解除安裝會移除所屬 Discovery。停止時不主動刪除，Supervisor 列表依 App 啟動狀態篩選。

若推送時 Core 尚未 Ready，相同 config 的後續 POST 不保證重新推送；Core 正常啟動時會重讀保存的資料。遇到極端啟動時序而沒有通知，先確認 HACS 已安裝並重啟 Core；必要時重啟尚未配對的 App 以產生新 Token 觸發更新，不需刪除 Session。

HACS 後裝通常需要重新啟動 Core 載入整合。確認表單可能停留超過 Token 有效期，所以 HACS 應在**使用者送出時**用 Core 的 Supervisor client 重讀 `/discovery/<uuid>`，取得最新 Token，不能只沿用最初通知的值。

同一 instance ID 的重複探索應更新現有 Add-on entry 的連線資訊，不建立第二筆。外部 LXC entry 不得被自動覆寫。這屬於 HACS 的責任，本 App 不會直接修改 Config Entry。

## 權限證據

- [官方 Discovery 指南](https://contributors.home-assistant.io/apps/guides/services-discovery/)
- [官方 API 存取與最小權限](https://contributors.home-assistant.io/apps/guides/security/)
- [Supervisor API Discovery handler](https://github.com/home-assistant/supervisor/blob/main/supervisor/api/discovery.py)：list/get 由 `require_home_assistant` 限制；App 只能發布其宣告的 domain，刪除限自己的 message。
- [Supervisor 去重與保存邏輯](https://github.com/home-assistant/supervisor/blob/main/supervisor/discovery/__init__.py)
- [Core 重讀與推送處理](https://github.com/home-assistant/core/blob/dev/homeassistant/components/hassio/discovery.py)
- [Supervisor hostname 規則](https://github.com/home-assistant/supervisor/blob/main/supervisor/apps/model.py)：來源仍由 self/info 實際取得，不在 App 寫死 Repository prefix。

2026-10-17 核對。未來 Supervisor 權限模型若改變，需重新審查秘密傳遞通道。
