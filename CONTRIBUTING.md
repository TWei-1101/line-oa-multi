# 貢獻指南

先以 Issue 說明問題或變更目的，再提出 Pull Request。以小範圍修正為主，保留 API v1 相容性與既有 instance ID、別名、登入及配對資料。

## 驗證

需要 Node.js 24、npm、Python 3 與已啟動的 Docker engine（Linux、Docker Desktop 或 Colima）：

```sh
npm --prefix line_oa/app ci --ignore-scripts --no-audit --no-fund
npm --prefix line_oa/app test
python3 scripts/check-backup-policy.py
python3 scripts/check-publication.py
python3 scripts/build-local-image.py
python3 scripts/container-smoke.py
```

測試必須使用合成資料／Mock LINE。勿提交 `/data`、`.env`、登入資料、備份、私鑰或本機部署資訊。不要在 CI 自動登入 LINE 或對真實收件者發訊。

變更發送流程時，必須保留「結果不明不自動重送」、別名白名單、頻率限制及去重。涉及備份規則時，確認 Session、別名、身份與 API 配對資料仍會備份。

## 發布

維護者更新 App config、package metadata、server 版本、Dockerfile 預設版本及測試期待值，補上 `line_oa/CHANGELOG.md`。可用 `scripts/check-backup-policy.py` 檢查版本同步。

手動執行 **Publish prebuilt Add-on image**，確認 amd64／aarch64 原生測試與 smoke 通過、合併 manifest 含兩種架構、GHCR 精確版本可匿名下載，才建立對應的 Git tag／Release。不要覆寫已發布的版本標籤，或刪除仍可能由備份引用的映像。

正式 `config.yaml` 的 `image` 指向公開 GHCR；若要做本機 source-build 開發，暫時移除該欄位，使用獨立測試 App／資料。此模式的 Supervisor 備份會再次包含整份映像。

本機建置工具會依 Docker engine 架構設定 HA label；Docker 的 `arm64` 對應 HA 的 `aarch64`。交叉建置時必須明確提供 `--platform` 與 `BUILD_ARCH`，錯配會拒絕建置。詳見 [多架構說明](docs/architectures.md)。
