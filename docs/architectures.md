# 架構與 Raspberry Pi 支援

從 **0.1.5** 起，LINE OA Add-on 提供以下預建映像：

| Home Assistant 架構 | Docker 平台 | Node.js 架構 | 適用環境 |
| --- | --- | --- | --- |
| amd64 | linux/amd64 | x64 | 64 位元 Intel／AMD HAOS |
| aarch64 | linux/arm64 | arm64 | 64 位元 ARM HAOS，包括使用 64 位元 HAOS 的 Raspberry Pi |

兩種平台共用 `ghcr.io/xangin/line-oa-ha-addon:0.1.5` 版本標籤。Docker 依主機平台選擇映像；不需要在 Add-on 設定中切換架構。`armhf`／`armv7` 等 32 位元 ARM 不在支援範圍。Raspberry Pi 硬體本身支援 64 位元仍不夠，安裝的作業系統也必須是 64 位元。

Raspberry Pi 的 HAOS 安裝與機型需求請參閱 [Home Assistant 官方教學](https://www.home-assistant.io/installation/raspberrypi/)。本 Add-on 必須搭配 [LINE OA HACS 整合](https://github.com/xangin/line-oa-hacs)，整合操作請參閱該 repo。

## 實際驗證範圍

2026-10-17，在 Apple Silicon Mac 上使用 Colima／Apple Virtualization Framework 啟動原生 aarch64 Linux VM，未使用 QEMU 模擬 amd64：

- Docker engine 與 Linux kernel 回報 aarch64。
- Node.js 24 的 ARM64 建置執行 TypeScript strict 編譯與完整 30 項 Mock 測試，全數通過。
- runtime 映像為 linux/arm64，HA label 為 aarch64，Node.js `process.arch` 為 arm64，版本 metadata 一致。
- 空白資料 volume 的容器通過 health、未發布主機埠、SIGTERM 正常退出、重啟身份保留，以及沒有 npm／compiler／測試檔的檢查。

CI 另外在 `ubuntu-latest`（amd64）與 `ubuntu-24.04-arm`（ARM64）原生 runner 分別執行測試、建置與容器 smoke。兩者成功後才組合公開多架構 manifest。0.1.5 的 [雙架構 CI](https://github.com/xangin/line-oa-ha-addon/actions/runs/39021750027) 與 [映像發布](https://github.com/xangin/line-oa-ha-addon/actions/runs/39021764199) 均成功。

正式映像發布後，又在同一台 Mac 使用無 GHCR 登入憑證的 Docker client 下載 `:0.1.5`，未指定 `--platform`。Docker 自動選到 linux/arm64／HA label aarch64，下載後的公開映像也通過同一組容器 smoke。

| 公開映像 | SHA-256 digest |
| --- | --- |
| 0.1.5 多架構 manifest | `7bde41128df71f541c896c7baeb035377984eedc518d58ddda18769c7619c93e` |
| linux/arm64/v8 | `ce4b46f11f0e680a5b3ae4a9a6924c2466fd7b95f6e433a545a1eec5329b954f` |
| linux/amd64 | `f244996ecd9f0e090c56aa2f94e198d56ae87bc981cf464df7e8790b1ccd13e7` |

映像程式碼 revision 為 `0e41f9925579f11ce6a677eb2499eaadf25c209b`；後續驗證紀錄只修改文件，沒有重建或覆寫映像。

**尚未在實體 Raspberry Pi 的 HAOS 上安裝驗證。** 本機容器測試不涵蓋 Raspberry Pi 硬體、HAOS Supervisor／Ingress 整合、實際 LINE 登入或真實收件者傳送；既有 HAOS／amd64 驗證範圍見 [測試紀錄](verification.md)。

## 本機重現

需要 Node.js 24、Python 3 與 Docker engine。Apple Silicon 可使用 Docker Desktop 或 [Colima](https://colima.run/docs/installation/) 的原生 aarch64 Linux VM。先啟動 Docker engine，再於本 repo 執行：

```sh
python3 scripts/build-local-image.py
python3 scripts/container-smoke.py
```

建置工具讀取 Docker engine 架構，對應 Docker 平台與 HA 的 `BUILD_ARCH`；Dockerfile 會拒絕平台與 label 不符的建置。smoke 使用空白 volume 與合成資料，結束後清除測試容器／volume，不需要 LINE 或 Supervisor 憑證。

若已設置多個 Docker engine，請先選定 Docker context，或用 `DOCKER_HOST` 指定測試 engine；建置工具以 engine 的架構為準。

直接建置 ARM64：

```sh
docker build --provenance=false --platform linux/arm64 --build-arg BUILD_ARCH=aarch64 --build-arg BUILD_VERSION=0.1.5 -t line-oa:test line_oa
python3 scripts/container-smoke.py --arch aarch64
```

在非 ARM64 engine 上執行上述容器需要另外配置模擬環境；正式發布採原生 runner。多平台 manifest 的原理請參閱 [Docker 官方文件](https://docs.docker.com/build/building/multi-platform/)。
