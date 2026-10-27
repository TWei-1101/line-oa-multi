# LINE OA Multi

This repository integrates the complete MIT-licensed xangin LINE OA Add-on and HACS sources with multi-account and Webhook support. It continues the original project rather than rewriting it. Two live accounts have been verified for QR login and message sending on HAOS; Webhook, backup/restore and long-running production use remain pending real-device validation.

- Add-on upstream: `xangin/line-oa-ha-addon` at `050f4fb32c263be9f4922c08c58f56baaa8e7cf8` (`v0.1.12`).
- HACS upstream: `xangin/line-oa-hacs` at `977980f149e8fc0d4a9f5ccaed3a1455b8c1b904`.
- Original prototype retained under `prototype/`; its fixture tests are not deployment verification.
- Upstream LICENSE is retained. Historical upstream docs and workflows are references; the installation guide below takes precedence.

One Add-on manages up to 20 accounts. Each has its own LINE session, cookie jar, contacts, sender and data directory. Gateway API authentication and HA pairing are shared. Explicit `account` is required on HA send actions; account IDs use lowercase letters, digits, underscores and hyphens, starting with a letter (1–32 chars).

Each account now uses the upstream `v0.1.12` shared text/image FIFO. Up to 32 active or waiting sends and 20 MiB are retained in memory per account; a queued request that waits more than 10 seconds is rejected as known-unsent. The obsolete local five-messages-per-minute limit is migrated to unlimited, while LINE's own limits and duplicate protection remain enforced.

Upstream `v0.1.11`/`v0.1.12` also persist a bounded account-specific contact cache, add a configurable session-check interval and durable auto-login history, and restore send-based idle-deadline resets with bounded jitter. These remain isolated per OA account in this fork.

```yaml
action: line_oa.send_text
data:
  account: alpha
  who: simon
  message: "測試通知"
```

```yaml
action: line_oa.send_image
data:
  account: alpha
  who: simon
  image_path: /media/test.jpg
```

```yaml
action: line_oa.send_screen_shot
data:
  account: alpha
  who: simon
  camera_entity: camera.front_door
```

Webhook settings use each OA's Messaging API Channel Secret. The HA session status sensor exposes `webhook_path`. Configure LINE Developers with your external HTTPS HA URL plus that path. Only this webhook endpoint needs public reachability; keep Gateway API and administrative listeners private.

Signature verification uses original bytes and the account's secret. The first valid signed request securely binds that channel's `destination`; later destination changes are rejected. This avoids incorrectly equating LINE OA Manager's internal account ID with the Messaging API bot user ID. Requests are durably queued before 200. The bounded inbox retains the last 2000 events; deduplication covers that retained window, including restarts. HA polls every five seconds and fires `line_oa_message` with `account`, event ID and sanitized fields (including image message IDs, never reply tokens). Delivery to the HA bus and cursor persistence are not an atomic transaction; a crash can replay an event. Automations should deduplicate by account and webhook event ID if needed.

## OpenClaw on Mac

Optional per-account automatic replies now use a separate durable queue: **LINE → HA Webhook → OpenClaw → OA Multi sender**. Configure the connection in the Add-on Web UI, then bind approved LINE sources to contact aliases. Incoming images use that account's Channel Access Token for download only; outgoing text/images use the existing QR-login OA Manager session, never the official push/reply send APIs. Long replies are split without truncation. Uncertain sends require review instead of blind retry. No HA YAML automation or modification of OpenClaw's LINE plugin is needed.

### Family Admission Modes

In the Add-on Web UI under account OpenClaw settings, **Family Admission** supports 5 flexible interaction modes:

| Mode | Key | Description |
|---|---|---|
| **僅群組 @Bot 文字** | `self-mention-group-text` | Default mode. Only processes messages in group chats that explicitly `@Bot`. |
| **文字開頭喚醒詞** | `keyword-prefix` | Matches custom wake words at start of line (e.g. `喵`, `助理喵`, `小貓`), no `@Bot` required. |
| **追問窗口模式** | `followup-window` | Once triggered by `@Bot`, the sender can ask continuous follow-up questions within 3 minutes without tagging the bot again. |
| **喚醒詞 ＋ 追問窗口** | `keyword-or-followup` | **Recommended ⭐**. Combines wake words and follow-up window for natural conversational experience. |
| **智慧意圖過濾** | `smart-intent` | Intelligently evaluates questions, inquiries, and wake words within the group to route AI-intended questions. |

### Per-Sender Followup Isolation

In group chats with multiple members, follow-up windows are isolated strictly per sender ID (`userId`). When multiple users chat in the same group, their context windows never overwrite or leak across participants.

See [繁體中文安裝步驟](docs/OPENCLAW-zh-TW.md) or [Mac setup and recovery](docs/OPENCLAW.md), including the supplied Mac image adapter and optional automatic startup. This new bridge's actual Mac/HAOS end-to-end behavior remains **pending device validation**.

Use a test HA instance and test recipients. The sender uses LINE's unofficial management interface; a successful HTTP submission is not independent proof of recipient delivery. Restart persistence, backup/restore, long-running stability and LINE Developers Webhook verification remain acceptance tests.

## Install from GitHub

The same repository provides both required parts. They do not replace each other.

1. In the Home Assistant App/Add-on Store repository manager, add `https://github.com/TWei-1101/line-oa-multi`, refresh the store and install **LINE OA Multi**.
2. In HACS, open **Custom repositories**, add `https://github.com/TWei-1101/line-oa-multi` as type **Integration**, then download **LINE OA Multi**.
3. Restart Home Assistant Core. Keep the Add-on running, then accept LINE OA discovery under **Settings > Devices & services**, or add the LINE OA integration manually.

Do not install the upstream `xangin/line-oa-hacs` integration alongside this fork. Both use the `line_oa` domain.

See [INSTALL-HAOS.md](INSTALL-HAOS.md) for installation, rollback and acceptance checks; [VALIDATION.md](VALIDATION.md) records actual validation status.

## Upstream monitoring

The daily `Upstream sync monitor` workflow compares `xangin/line-oa-ha-addon/main` with [docs/upstream-line-oa.json](docs/upstream-line-oa.json). A newer revision opens or refreshes one GitHub issue with the exact compare link and acceptance checklist; updating the pinned revision after a reviewed port closes it automatically. It deliberately never writes upstream changes straight to `main`, because shared sender, server and session files require semantic review against this fork's multi-account and OpenClaw guarantees.
