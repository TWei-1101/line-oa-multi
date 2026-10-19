# 安全模型與限制

## 資產與信任

資產為 LINE Session、允許收件者別名、API Key、Bootstrap Token、永久身份與 HA/LXC 既有設定。信任 HA 管理者、Core、Supervisor、其檔案與內部網路隔離；一般 LAN 裝置與未授權 App 不在信任邊界內。

| 威脅 | 防護／限制 |
| --- | --- |
| LAN 直接存取 | 無 Host Port mapping、無 host_network；API 仍需 Key |
| 其他一般 App 讀取 Bootstrap | Supervisor Discovery get/list 有 Core-only guard，無 mDNS／health／UI 洩漏 |
| 偽造 Ingress Header | 先驗證實際 socket 來源為 172.30.32.2；Header 不作來源認證 |
| CSRF | Ingress 私有 Web Session、隨機 CSRF Header、來源／Sec-Fetch 檢查，Cookie 按 Ingress path 隔離 |
| Token 猜測／重用 | 256-bit、10 分鐘、每分鐘五次全域限制、timingSafeEqual、同步互斥與一次性消耗 |
| Key 洩漏／舊 Key | Gateway 只存雜湊，前端不取得 Key，重新配對即撤銷舊 Key |
| Session／身份損壞 | 原子 JSON 寫入，檔案權限0600；無效 config／憑證 fail closed |
| 秘密進入日誌 | 只在失敗時記錄上游回應與診斷；遞迴遮蔽敏感欄位、Cookie、Token、Key、PIN、HTML input value、URL query 與已知憑證值。不記錄請求 Body 或請求 Headers；完整回應僅限管理 Ingress 與 App 日誌。 |
| 別名原型繼承 | 別名使用 Map，只查找明確儲存的鍵；`__proto__` 可作普通別名，撤銷後不會回退到物件原型，JSON 與舊格式遷移仍相容 |
| 暫存容量競態 | 同一 Gateway 的容量檢查與圖片寫入序列化，總量不超過設定值（預設 20 MiB）；容量不明時拒絕寫入，寫入失敗清除部分檔案 |
| QR 回應耗用 | 逐塊計算已解碼回應大小，上限 2 MiB；宣告或實際大小超限時取消讀取與請求，不先完整緩衝過大回應 |
| 重複訊息 | 沿用去重、頻率限制、single-flight，UNKNOWN 不自動重送 |

## Ingress 與瀏覽器

8099 的實際來源限定 Supervisor，`X-Ingress-Path` 僅在該信任邊界內採用。API Key 不開放從 UI 建立／顯示。HTML、JS、fetch、圖片路徑使用相對 URL；CSP frame-ancestors self 與 X-Frame-Options SAMEORIGIN 允許 HA iframe。Cookie HttpOnly、SameSite=Strict，TLS Ingress 時加 Secure。Web Session 在 RAM，App 重啟後重新經由 HA Ingress 建立。

`panel_admin:true`，依賴 Supervisor 對 Ingress 的授權；App 不自行把可偽造的 X-Remote-User Header 當管理者密碼。程式沒有 WebSocket、EventSource、外部 OAuth callback 或瀏覽器跨域 Cookie 需求；LINE 中間 Cookie 僅存在 Gateway 的記憶體 Cookie jar。

## 明確的剩餘風險

- 內部 Gateway API 使用 HTTP。具有 host network、NET_RAW／ARP spoofing、Docker socket、主機 root 或其他高權限的惡意 App 可能攔截 bridge 流量。**本版不宣稱能抵抗被入侵的 HA 主機／Supervisor／Core 或有此類能力的惡意 App。** 不能把 Docker bridge 視為對高權限攻擊者的加密通道。請勿把 port 手動映射到 LAN；若要涵蓋主機內 MITM，需另做 TLS／憑證釘選與驗證。
- Discovery 的秘密會暫時保存於 Supervisor 私有儲存中；合法 Core、主機管理者、相關備份與診斷工具屬可信任範圍。避免分享完整 debug diagnostics 或備份。
- 所有 Core 內的整合共享同一信任域，無法由此方案隔離惡意 Core integration。
- 全域嘗試限制可能被其他 App 用來造成短暫配對拒絕服務；不會因此取得 Key。憑證備份未額外加密，由 HA 備份加密與主機權限保護。
- Browser 管理操作經 HA 授權，但若 HA 管理者帳號被盜或有同源 XSS，這個邊界也被破壞。
- 沿用原本 LINE 非公開通訊介面；沒有規避 LINE 的驗證、限制或風控。Session 跨主機搬移可能失效。
- 原子寫入只涵蓋單檔；應使用冷備份保持多檔一致。遭損壞時不會自動修復 Session。
- HACS 自動配對流程必須另行實作並實測。本 App 本身無法保證整套「安全零設定」已完成。

## 最小權限

App 不請求 privileged、host_network、full_access、Docker socket、homeassistant_api、hassio_api 管理權限。使用 Docker 預設 AppArmor，沒有未驗證的自訂 profile。單一 Node 程序目前以容器預設使用者運行，以使用 Supervisor 掛載的私有 /data；無宿主目錄映射。未宣稱額外的非 root 沙箱保證。

[官方 Ingress](https://contributors.home-assistant.io/apps/guides/ingress/) · [官方安全指南](https://contributors.home-assistant.io/apps/guides/security/) · [Supervisor Discovery 權限](https://github.com/home-assistant/supervisor/blob/main/supervisor/api/discovery.py)
