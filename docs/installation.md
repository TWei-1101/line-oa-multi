# 安裝與更新

## 一般使用者

需要有 Supervisor／App Store 的 Home Assistant（建議 HAOS），架構為 amd64 或 aarch64。Raspberry Pi 需安裝 64 位元 HAOS；32 位元 ARM 不支援。版本 0.1.5 起提供兩種架構。

1. 先依 [README](../README.md) 申請 LINE 官方帳號、啟用聊天、建立收件者對話。
2. 商店 → 儲存庫加入 `https://github.com/xangin/line-oa-ha-addon`。
3. 選 **LINE OA** → 安裝 → 啟動 → 開啟 Web UI。
4. 完成 QR／PIN 登入，選擇官方帳號，測試連線。
5. 聯絡人 → 重新整理 → 設為別名 → 發送測試。

正式版從 `ghcr.io/xangin/line-oa-ha-addon:<版本>` 下載映像，不在 HA 主機下載 npm 開發相依或編譯。Web UI 經 HA Ingress；不要開放 8099／8787 到 LAN，不需關閉保護模式。

## 必須搭配的 HACS 整合

**本 Add-on 必須搭配 [LINE OA HACS 整合](https://github.com/xangin/line-oa-hacs)使用。** HACS 安裝、配對與通知使用方式請直接看 [HACS repo 的完整說明](https://github.com/xangin/line-oa-hacs#readme)。

## 更新、還原與移除

從商店更新，保留 App 私有 `/data`。還原時須能下載備份對應的 GHCR 版本；不要刪除仍被備份引用的映像。LINE Session 仍可能因官方失效而需要重新登入。

解除安裝通常會清除私有資料，先建立備份；不要以解除安裝代替更新。若 HA Core 的配對憑證與 App 備份時間不同，可在 App 重新配對。詳見 [備份與還原](backups.md)。

## 本機開發安裝

只供開發者：把 `line_oa/` 放到 HA 的 local Apps 目錄（通常 `/addons/line_oa` 或映射的 `/local_apps/line_oa`），重新整理商店。保留 `image` 時仍下載正式映像；要測試自己的程式碼，請在獨立測試副本移除 `image` 再建置。

不要複製 `node_modules`、`dist`、`data`、`runtime`、`.env`、備份或登入資料。使用 source-build 時，Supervisor 會把本機映像打包進備份，體積與正式預建版不同。自訂儲存庫會有不同 slug／hostname；程式會從 Supervisor self/info 取得，沒有寫死 Repository prefix。
