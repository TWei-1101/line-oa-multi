# LINE OA

透過 LINE 官方帳號傳送文字與圖片通知。支援 QR／PIN 登入、收件者別名、Ingress 管理、API v1 探索與配對。

**支援 amd64（x86-64）與 aarch64（ARM64）。** Raspberry Pi 需使用 64 位元 HAOS，不支援 32 位元 ARM。 使用 LINE 管理後台未公開聊天介面，未獲 LINE 背書。安裝前先申請官方帳號、啟用「聊天」，並讓收件者先傳訊給官方帳號。

[完整入門與 LINE 官方教學連結](https://github.com/xangin/line-oa-ha-addon#readme)。安裝後閱讀 **Documentation**，由「開啟 Web UI」登入與設定別名。

**本 Add-on 必須搭配 [LINE OA HACS 整合](https://github.com/xangin/line-oa-hacs)使用。** HACS 安裝、配對、Actions 與自動化細節，請直接參閱 [HACS repo 的說明](https://github.com/xangin/line-oa-hacs#readme)。

沒有對外開放 TCP 埠。備份保留必要設定與登入資料，還原時從公開 GHCR 下載對應版本映像。
