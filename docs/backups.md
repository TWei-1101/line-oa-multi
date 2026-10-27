# 備份與還原

## 備份包含什麼

在 Home Assistant 系統備份中包含 LINE OA App。保留 App metadata、`config.json`（永久身份）、`aliases.json`、`contacts.json`（最多 10,000 筆已查詢聯絡人）、`auto-login-history.json`（最近 200 筆自動登入紀錄）、`options.json`、`secrets/line-session.json`、`secrets/api-key.json`（配對 Key 雜湊）及其他必要設定。

備份含敏感登入資料，請使用 HA 的備份保護機制並妥善保存復原金鑰。私有資料不會進入 GitHub Repository 或 GHCR 映像。

## 排除什麼

- `tmp/`：發送期間的圖片暫存。
- `cache/`、`.cache/`：可重新建立的快取。
- `logs/`、`*.log`：可捨棄的日誌。

搜尋頁面快取與一般操作紀錄留在 RAM；圖片會在使用後清除。聯絡人清單與自動登入紀錄有筆數上限，另存於上述 JSON 並保留在備份中，以供重啟與還原後使用。正式設定不可存進上述暫存目錄。不能排除整個 `secrets/`。

## 為何使用預建映像

正式設定的 `image` 指向公開 GHCR。Supervisor 備份 App 資料與設定，還原時重新下載該版本的映像，不把整份 Node runtime／Docker 映像重複放進 App 備份。

開發者若移除 `image` 改成 source-build，Supervisor 會另外匯出 `image.tar` 到備份；`backup_exclude` 只篩選資料／設定，不能篩掉這個映像。不要加入 `image.tar` 排除字串便宣稱已解決。來源建置與預建版的備份體積不可直接混為一談。

## 還原流程與條件

1. 透過 Home Assistant 還原包含 LINE OA 的系統／部分備份。
2. 主機需連網並能存取 `ghcr.io`，且備份對應版本的映像仍存在。
3. 還原 App 的整份資料，保留 instance ID、別名、Session 與配對雜湊。
4. 開啟 Web UI 檢查 LINE 狀態；若官方 Session 已過期，重新 QR 登入。
5. 如果 Core 的整合配對資料與 App 備份時間不同，在 App 設定重新配對。
6. 確認通知對象、別名及整合狀態，再發送少量測試訊息。

使用 `backup: cold`，備份時 App 會短暫停止並恢復。更新映像不清除 `/data`；解除安裝可能刪除資料，不要當成更新方式。舊版包含映像的既有備份維持原樣，新增排除規則不會回頭縮小舊備份。

## 0.1.3 實測結果

2026-10-17，HAOS／amd64 的同一份小型設定，使用 Supervisor App-only 冷備份：

| 檢查 | 結果 |
| --- | --- |
| 原 source-build 備份 | 90,757,120 bytes（約 86.55 MiB） |
| 預建映像版備份 | **10,240 bytes（10 KiB）** |
| App 壓縮資料 | 2,629 bytes |
| 整體縮小 | 約 **99.989%** |
| `image.tar` | 不存在 |
| 測試暫存、快取與日誌 | 全部排除；測試後已清理 |
| Session／別名／永久身份／配對檔 | 存在，更新前後必要值保留一致 |
| 還原映像 metadata | 公開 GHCR、版本 `0.1.3` |

已從沒有 Docker 認證的 HA 主機環境下載精確版本，並驗證更新後 LINE 連線、Ingress 與整合認證正常。沒有在使用中的 HA 執行覆寫式 restore。以上是特定小型設定的實測，並非所有使用者的固定大小；新的必要設定或更多別名會增加備份大小。

## 維護者驗證

發布後必須確認精確標籤可匿名下載，再以新 App-only 備份檢查沒有 `image.tar`、暫存已排除且必要設定仍存在。保留所有被備份引用的映像版本，不覆寫已發行標籤。

不要在使用中的 HA 做覆寫式 restore 演練；應使用獨立測試主機。備份內容檢查與「還原至全新 HA」是不同驗證，測試範圍見 [驗證說明](verification.md)。

參考：[HA App 設定](https://contributors.home-assistant.io/apps/reference/configuration/)、[Supervisor 備份與還原](https://github.com/home-assistant/supervisor/blob/main/supervisor/apps/app.py)。
