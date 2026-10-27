# LINE OA 操作說明

## 使用前準備

依 [LINE 官方申請頁](https://tw.linebiz.com/account/) 建立帳號，登入 [Official Account Manager](https://manager.line.biz/) 後，在「設定 → 回應設定」啟用「聊天」。讓收件者先加入好友並傳訊，確認官方後台可聊天，再使用本 App。圖文步驟見 [LINE 官方聊天教學](https://tw.linebiz.com/manual/line-official-account/oa-manager-chatting/)。

完整新手教學：[專案 README](https://github.com/TWei-1101/line-oa-multi#readme)。支援 amd64 與 aarch64（Raspberry Pi 需使用 64 位元 HAOS）；**必須搭配同一 Repository 提供的 LINE OA Multi HACS 整合。**

## 啟動與登入

啟動 App 後按「開啟 Web UI」，依下列步驟登入並設定通知對象。

1. 「總覽」→「登入／切換官方帳號」。
2. 用手機 LINE 掃描行動條碼，依畫面確認登入。若顯示 PIN，請依手機畫面核對；若顯示帳號選擇，選取正確的官方帳號。
3. 等待完成，再按「手動測試連線」，確認狀態為 **CONNECTED**。
4. 「聯絡人」→ **先按「重新整理」**，從 LINE 載入對象；需要時輸入名稱搜尋。
5. 找到對象後按「設為別名」，輸入例如 `home`。別名限 1–32 字元的小寫英文字母、數字、底線或連字號。
6. 確認出現在「允許的收件者別名」。**沒有別名的對象不能發送通知。** 名稱相同時請核對 Web Chat ID。
7. 到「發送測試」選取別名，先對已確認的收件者發送少量測試訊息。

`who` 使用 `home` 這類別名，不填 LINE ID、電話號碼或 Messaging API User ID。

「登出 LINE」清除此 Add-on 保存的登入資料與聯絡人快取，保留別名與 HA 配對；之後需重新登入。切換官方帳號後，請重新核對收件者與別名。

已載入的聯絡人會保存到 Add-on 私有資料目錄；重啟後開啟「聯絡人」即可查看，不必再次向 LINE 查詢。首次安裝或從未保存聯絡人的舊版升級後，仍需按一次「重新整理」。聯絡人依官方帳號區分，切換帳號不會套用上一個帳號的快取；登出會清除快取。最多保留 10,000 筆已查詢對象。

### 檢查間隔與紀錄

- 「設定 → 登入狀態檢查」以**分鐘**設定，儲存後立即生效並重新計時，不需重啟。可設 0～10080 分鐘；舊版設定升級時預設為 **45 分鐘**。
- 設為 **0**：停用啟動與定時檢查，發送遇到登入失效時才嘗試自動恢復；「手動測試連線」仍可使用，但不會因此自動登入。重啟後，已載入的 Session 會先顯示待驗證，直到發送成功或手動測試確認狀態。讀取狀態本身不會觸發登入。
- 大於 0：啟動時確認連線，之後只在發送閒置達設定時間時檢查；再次發送會重新計時，發送中的工作會優先處理。
- 「紀錄 → 自動登入紀錄」列出實際恢復的開始／結束時間、來源、結果與錯誤代碼，可與 LINE 登入通知對照。時間依 HA 時區顯示，最近 **200 筆**於重啟後仍保留。正常檢查未觸發登入時不新增；更新前的歷史無法回補。
- 自動恢復若仍要求手機確認，請在「總覽」重新登入。結果不明的訊息不會自動重送；詳細錯誤仍可從「一般紀錄」查看。


[查看 README 完整教學](https://github.com/TWei-1101/line-oa-multi#install-from-github)

## 必要的 HACS 整合

**本 Add-on 必須搭配 [同一 Repository 的 LINE OA Multi HACS 整合](https://github.com/TWei-1101/line-oa-multi#install-from-github)使用。**

HACS 安裝、配對、重新驗證、Actions 與自動化操作，請參閱 **[本 Repository 的安裝說明](https://github.com/TWei-1101/line-oa-multi#install-from-github)**。

## 資料與更新

Session、別名、聯絡人清單、自動登入紀錄、身份與憑證雜湊位於 App 私有 `/data`，更新映像會保留。使用 Home Assistant 備份本 App，復原時保留整份 `/data`。預建映像於還原時重新下載，不含在 App 備份中；圖片暫存、可重建的快取目錄與一般日誌不備份；有筆數上限的聯絡人清單與自動登入紀錄保留。還原需要網路與對應版本映像。請保護包含 Session 的備份，不要放入 Git／Issue／聊天。

## 故障排除

- Ingress 403：只允許 Supervisor 代理，請從 HA「開啟 Web UI」進入，不能直接用 IP:8099。
- HACS 配對、API 認證或 Actions 問題：請參閱 [本 Repository](https://github.com/TWei-1101/line-oa-multi#install-from-github)。
- Discovery retrying：Supervisor 暫時不可用，App 會重試，不會清除 LINE Session。
- 登入 auth_required／expired：在 Web UI 重新登入 LINE，不需要重配 API。
- UNKNOWN：結果不明，不要自動重送。

完整技術契約、安全模型與實測紀錄請參閱此 Repository 根目錄 `docs/`。
