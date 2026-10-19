# 從 LXC 移轉 Session

**預設建議：在 App 的 Ingress 重新完成 QR 登入。** 這不需要讀取、顯示或複製原 LXC Cookie；不需要修改原 LXC 的程式或資料。

## 可選的受控匯入

原 Gateway 使用 JSON：`DATA_DIR/secrets/line-session.json` 格式version1，包含 botId、可選 accountName/clientVersion/csrfToken、必要 `__Host-chat-ses` 及有限 Cookie 清單。HTTP 實際目標始終是 `https://chat.line.biz`，所以 App 的 Ingress URL 不會成為 Cookie Domain。

同格式可由本 App SessionManager 讀取，但 LINE 仍可能把 Session 綁定到環境、IP 或已撤銷狀態；**複製成功不等於可登入，也不保證舊 LXC 與新 App 可同時使用同一 Session**。

若決定搬移：

1. 私下備份原 LXC 資料與 App，不在聊天、Git、Issue 或命令列參數貼 Cookie。
2. 停止 App。從原 Gateway 的實際 DATA_DIR，以 SSH／受控檔案管道把 `secrets/line-session.json` 與必要的 `aliases.json` 放入 App 私有 `/data`；該目錄是 Supervisor 管理的 App 資料，與原始碼 `/addons/line_oa` 完全不同。
3. 只複製這兩個白名單檔案。不要搬 API Key、admin password、tmp、完整 contacts snapshot、舊 config 或 instance ID；新安裝應保持自己的 API 身份。
4. 設 `/data`、`secrets` 為0700、JSON為0600，確認來源檔仍保留，才啟動 App。
5. 在 Ingress 按「手動測試連線」。失效時改用 QR 登入，不反覆重送訊息、不清除 LXC Session。

不提供自動從現有 LXC 擷取秘密的流程。匯入後應重新核對別名與官方帳號關係。HA 整合是否遷移由使用者另行確認，不因 App 安裝自動改連線。
