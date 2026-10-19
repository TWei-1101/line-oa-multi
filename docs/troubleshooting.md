# 故障排除

| 現象 | 處理 |
| --- | --- |
| App Store 找不到 | 目錄應為 local Apps 下的 line_oa/config.yaml，重新整理 Store；完整 Docker context 要包含 app/src、web、package-lock、tsconfig |
| 建置失敗 | 檢查 Supervisor build logs、Docker registry／npm DNS與磁碟；不要把私有資料拷進 build context |
| Ingress 403 | 必須從 HA Open Web UI 進入；8099拒絕直接來源與偽造 X-Remote-User。確認 Supervisor代理位址與X-Ingress-Path符合官方規範 |
| 只有首頁能開 | 檢查相對資源URL與Cookie的Ingress Path；重新整理頁面。沒有把api路由掛到HA root |
| 配對 status=retrying | Supervisor暫不可用，30秒重試；檢查App有line_oa discovery宣告，無需manager/admin role |
| HA沒有探索卡 | 先確認HACS已實作hassio flow、已重啟載入。現有HACS0.1.0或單一entry限制可能忽略探索；本次不自動改它 |
| pairing 401／429 | Token錯誤／過期／用過，或每分鐘五次限制。重新讀取Supervisor資料；必要時Ingress重新授權；不重用舊Token |
| 交換後無法取回Key | 若HTTP回應遺失，不能重放Token。由Ingress重新配對撤銷原Key，再由HACS新交換 |
| status/aliases 401 | 尚未配對或Key已撤銷。health成功不代表已驗證 |
| LINE auth_required／expired | 在Ingress重新QR登入，不執行API重新配對 |
| 登入PIN／帳號選擇不出現 | 檢查畫面錯誤代碼與LINE流程變更；新登入期間原Session仍保留，失敗不清除原檔 |
| 切換帳號後別名不符 | 重新查詢新帳號聯絡人，人工重新核對允許別名 |
| UNKNOWN | 可能已送達，停止自動重試，人工核對 |
| App因檔案損壞不啟動 | 還原私有config／credential備份，避免刪檔造成身份重建；不要公開JSON內容 |

## 停止與暫存

SIGTERM/SIGINT停止接收新HTTP，取消QR流程，等待連線最多20秒後關閉並清理tmp，保留Session／別名／Key。Supervisor timeout設定30秒。強制斷電的暫存會在下次啟動清除。

## 安全回報

分享版本、固定錯誤代碼、是否經Ingress、是否已配對即可。不要附完整Headers、Discovery config、Session檔、Key、QR圖片、PIN或備份。SupervisorToken不應在任何支援對話中出現。


## 0.1.1 錯誤與日誌

- `WEB_UI_CSRF_TOKEN_MISSING`：網頁操作缺少驗證碼；`WEB_UI_CSRF_TOKEN_MISMATCH`：頁面驗證碼與目前管理 Session 不符。重新整理 Add-on 頁面再操作；拒絕時操作尚未執行。
- `LINE_HTTP_403_CSRF_OR_PERMISSION_DENIED`：LINE 上游 HTTP 403，可能是 CSRF 或權限問題；查看完整回應判斷。
- `LOGIN_BUSINESS_CSRF_MISSING`：LINE Business 登入頁面找不到預期 CSRF 欄位；紀錄會包含該頁面的回應，方便確認上游變更。
- 「紀錄 → 系統回應／除錯詳情」顯示完整回應欄位（LINE API 最大 1 MiB、QR 登入回應最大 2 MiB），不再截成 180 字。Cookie、Token、PIN、密碼與 API Key 會遮蔽。記憶體保留最多 100 筆且總量約 4 MiB，較舊紀錄依容量淘汰。
- Supervisor 應用程式日誌使用容器收到的 HA `TZ`；例如 `Asia/Taipei`。每筆顯示當地日期、UTC 偏移與時區名稱，後接操作、結果與縮排欄位；網頁使用相同時區。API 的原始時間戳仍使用 ISO UTC，保留既有程式相容性。
- 「總覽 → 登出 LINE」會取消進行中的 QR 登入，原子清除 Add-on 保存的 Session 與聯絡人快取。別名與 HA API 配對保留；發送進行中會拒絕登出，待結果確認後再操作。登出不會撤銷其他服務保存的 LINE Session。
