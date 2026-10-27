# 原始碼檢查與同步紀錄

基礎來源：`line-oa-lxc` Gateway **0.5.0**。修改前已閱讀Gateway全部src、WebUI與測試，並核對`line-oa-hacs`的api/config_flow/coordinator/services/entity與測試。

## 實際現況

- Gateway全為Node built-ins，只有TypeScript／Node typings開發相依，沒有原生Node addon、SQLite、Chromium或常駐瀏覽器。
- SessionManager從`secrets/line-session.json`載入必要LINE Cookie，成功登入才原子替換；原QR流程為server-side Business ID頁面、QR/PIN長輪詢及OA選擇，瀏覽器不直接處理LINE Cookie。
- ContactService 保存別名與按官方帳號區分的聯絡人清單（最多 10,000 筆）；搜尋頁面快取仍在 RAM。
- 原AuthManager支援admin password／browser CSRF與API SHA-256驗證。App保留後者，改由Ingress作管理授權及專用配對流程。
- HACS使用health、status、aliases、text JSON與image multipart五個API。圖片不接受message；沒有增加notify實體。

## 沿用核心與 0.1.1 差異

0.1.1 時 `src/images.ts`、`multipart.ts` 與原 LXC 逐位元相同。0.1.7 的安全修正擴充 `images.ts`，將容量檢查與寫入序列化並清理失敗寫入，`multipart.ts` 仍與原檔相同。0.1.1 在 `line-client.ts` 增加失敗回應診斷與登入狀態變更檢查；`qr-login.ts` 增加失敗詳情與取消檢查；`session.ts` 增加本機登出、原子清除與競態防護；`sender.ts` 只新增忙碌狀態查詢。LINE登入端點、帳號選擇、文字textV2、圖片uploadFile/bulkSendFiles、Session格式與UNKNOWN不重送皆沿用。登出只清除本Add-on的Session，不呼叫LINE全域登出。

## App必要差異

- `server.ts`：雙listener、可注入Mock、Ingress驗證、配對路由、啟停清理。
- 新增`pairing.ts`、`discovery.ts`、`ingress.ts`。
- `auto-login-history.ts`：保存最近 200 筆恢復嘗試的時間、來源與結果，不保存回應本文或憑證。
- `session-monitor.ts`：依最後一次實際發送重新計算閒置期限，加入固定範圍的隨機延遲；0 停用啟動與背景檢查，設定經 Ingress／CSRF 驗證後持久保存。
- `config.ts`：DATA_DIR=/data、固定容器listener、永久身份損壞fail closed。
- `auth.ts`：憑證損壞fail closed、可指定cookie scope、CSRF byte-length檢查。
- `storage.ts`：讀取既有檔強制0600、寫入後fsync目錄。
- `contacts.ts`：別名與聯絡人清單原子保存，清單綁定官方帳號；登出與切換帳號防止舊的查詢回應恢復快取，舊格式別名仍可遷移；0.1.7 修正改用 Map，避免特殊鍵透過原型繼承繞過撤銷。
- `images.ts`：0.1.7 修正序列化容量檢查與寫入，容量不明時拒絕，寫入失敗清除部分檔案。
- `qr-login.ts`：0.1.7 修正將上游回應改為串流限量讀取，避免先讀入整份過大回應。
- `api-v1.ts`：在health/status新增api_version=1，既有欄位保留。
- `web`：相對路徑、移除Key顯示、配對狀態與重配、允許重新登入／切換帳號。
- 上游測試有一處Buffer/string型別錯誤及過期的Session狀態期待值，僅在複本修正。

沒有修改原LXC程式、資料、服務或LINE通訊協定。只複製src/web/tests/scripts與套件metadata；沒有複製data/runtime/dist/.env。

## 日後同步

`docs/upstream-sha256.json`記錄原檔案checksum。執行`python3 scripts/verify-source.py <原Gateway路徑>`可驗證原專案未被修改，以及 multipart 模組仍一致；圖片模組已為上述安全修正擴充，其餘擴充模組需人工比對上述差異及執行回歸測試。同步上游修補時人工比對差異、重新跑Mock測試，不整個覆蓋App server/config/auth。更新checksum前應記錄基礎版本與安全影響。

HACS 為獨立專案，本儲存庫不包含或部署其整合程式。

0.1.6 的狀態 API 增加登入原因。
