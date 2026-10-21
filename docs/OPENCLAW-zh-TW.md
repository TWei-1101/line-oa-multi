# HA 收訊 → Mac OpenClaw → LINE OA Multi 回覆

這個功能延續現有 Add-on，不必重新登入所有帳號，也不必另寫 HA automation。
文字與圖片經 HA 的 Webhook 進來，OpenClaw 產生完整回答，再透過 OA Manager 的
登入 Session 發送。Channel Access Token 只用來下載收到的圖片，不呼叫官方 Push／Reply 發送 API。

目前支援文字、JPEG／PNG 圖片；語音、影片、文件與 LINE 圖文卡片尚未實作。
程式／容器測試與你的 Mac、HAOS 實際驗證分開記錄；後者仍待驗證。

## 1. 更新 HA Add-on

更新 **LINE OA Multi** 到 `0.3.0-dev.1`，啟動後開啟 Web UI。
既有 HACS 整合繼續使用，不必重新配對，也不必重裝 HACS。
頁面會新增 **OpenClaw 橋接**，各帳號也會有 **OpenClaw 設定** 按鈕。
功能預設不啟用，原有 HA 發送功能仍可使用。

## 2. 在 Mac 準備 OpenClaw

先確認 `node --version` 為 Node 24 或以上，然後開啟 OpenClaw 的 Responses API：

```sh
openclaw config set gateway.http.endpoints.responses.enabled true
openclaw gateway restart
```

收到的圖片需要使用支援圖片理解的模型。建議選擇專供此用途的 Agent，僅允許必要工具；
來源綁定限制誰能發起對話，但不會替 OpenClaw 工具建立權限隔離。

## 3. 下載並啟動 Mac 圖片轉接程式

在 Mac 終端機的預設 zsh 執行：

```sh
mkdir -p "$HOME/line-oa-bridge"
cd "$HOME/line-oa-bridge"
curl --fail --location --output openclaw-mac.ts \
  https://raw.githubusercontent.com/TWei-1101/line-oa-multi/main/line_oa/app/scripts/openclaw-mac.ts
```

接著設定連線。把下面的 `192.168.1.50` 改成 **Mac 的區網 IP**：

```sh
read -s 'OPENCLAW_GATEWAY_TOKEN?貼上本機 OpenClaw Gateway Token（不顯示輸入）: '; echo
export OPENCLAW_GATEWAY_TOKEN
export LINE_OA_BRIDGE_TOKEN="$(openssl rand -hex 32)"
export LINE_OA_BRIDGE_BIND=192.168.1.50
export LINE_OA_MEDIA_ROOT="$HOME/.openclaw/workspace"
printf '%s' "$LINE_OA_BRIDGE_TOKEN" | pbcopy
node openclaw-mac.ts
```

- Gateway Token 從你 Mac 上的 OpenClaw 認證設定取得，不要貼到對話中。
- 上述指令會把**另外產生的橋接密鑰**複製到 Mac 剪貼簿，下一步貼進 Add-on 即可。
- 看見 `LINE OA Mac adapter ready.` 代表轉接程式已開始監聽。
- 預設 OpenClaw 在 `127.0.0.1:18789`。若你的埠不同，另設
  `OPENCLAW_GATEWAY_URL=http://127.0.0.1:你的埠`。
- 不必在路由器對外開放 Mac 的連接埠。此範例適用可信任區網；跨網路改用 VPN 或 HTTPS。

目前是前景執行，關閉終端機或 Mac 休眠會暫停服務。HA 會保留工作，但重試次數用完後
需要在介面手動重試。[背景自動啟動的 launchd 範例](OPENCLAW.md#optional-automatic-startup)
可讓轉接程式在 Mac 登入後自動執行；OpenClaw 本身也需要保持執行。

## 4. 在 Add-on 設定 Mac 連線

選擇 **OpenClaw 橋接 → 連線設定**：

| 欄位 | 填入內容 |
|---|---|
| Mac 端 API 網址 | `http://Mac區網IP:18790/v1/responses` |
| 連線密鑰 | 貼上剛複製的橋接密鑰 |
| Agent ID | 你的專用 Agent ID；預設為 `main` |
| 等待完整回答秒數 | 預設 300，較長工作可調整 |

不要把網址填成 `localhost`，那會指向 Add-on 本身。
連線密鑰儲存後不會回傳顯示；再次開啟設定留空表示沿用。

## 5. 設定 aiassistant 收訊與收件人

1. 保持 `family` 的 Webhook／OpenClaw 未啟用。
2. 啟用 `aiassistant` 的 Webhook，設定它自己的 Channel Secret。
3. LINE Developers 的 Webhook URL 改為 **HA 對外 HTTPS 網址＋
   `sensor.line_oa_session_status` 屬性的 `webhook_path`**，不要再指向 Mac。
   開啟 Use webhook、Webhook redelivery，按 Verify 確認成功。
4. 從你的 LINE 傳一則訊息，讓 HA 記住來源 ID。
5. 在 Add-on 的 **aiassistant → 管理／登入** 中，為對應收件人建立聯絡人別名。
6. 回到 **aiassistant → OpenClaw 設定 → 新增來源綁定**，選擇最近收到的來源 ID，
   並選擇剛才建立的收件人別名。私人對話用 `U…`；群組用 `C…`。
   群組綁定代表允許該群組成員共用這段 AI 對話。
7. 填入 **aiassistant 自己的 Channel Access Token**，用來下載收到的圖片。
8. 勾選 **啟用自動回覆**，儲存後再傳第二則訊息測試。

綁定完成前的第一則測試訊息不會補送給 AI。請確認「來源 ID → 收件人別名」是同一個
對話，避免把回答送給另一人。不要再用另一段 automation 把同一個 `line_oa_message`
轉送給 OpenClaw，否則會產生兩次 AI 工作。

## 6. 確認文字／圖片與失敗恢復

- 先測短文字，再測超過 5,000 字元的回答，確認分段順序及最後一段都收到。
- 傳圖片給 AI，再請它產生圖片，確認兩個方向都可用。輸出圖片需放在
  `LINE_OA_MEDIA_ROOT` 之下，預設是 `~/.openclaw/workspace`。
  Mac 轉接程式會要求 AI 回傳包含文字及圖片路徑的完整結果，並將路徑轉為圖片。
- 單張圖片上限 10 MiB；一個回答有總大小／段數限制。超出或不支援的內容會保留為失敗，
  不會把只有部分內容的回答標成全部成功。
- 到 **更新工作狀態** 查看結果。「已提交 LINE」表示 OA 後台接受，並非收件者送達證明。
- 若出現「發送結果不確定」，先查看 LINE，再選擇重試、略過，或「已確認本段送出」。
  系統不會在結果不確定時自動重送，避免重複回答。
- 同一對話的失敗工作會擋住後續訊息；其他對話可繼續。重新啟動會保留待送資料與分段進度。

這些機制能降低漏送與重複，但不能保證零漏送。OA Manager 非公開介面若改動，仍可能需要
更新；Mac／HA 實機收發、重啟恢復、備份還原與長時間運行都列為待驗證。

[完整協定、容量限制與恢復說明](OPENCLAW.md) · [驗證紀錄](../VALIDATION.md)
