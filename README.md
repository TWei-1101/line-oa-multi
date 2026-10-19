# LINE OA Multi — experimental development

This repository integrates the complete MIT-licensed xangin LINE OA Add-on and HACS sources with the supplied dynamic-account/Webhook prototype. It is not a rewrite. This development build has not been validated with live LINE accounts or HAOS.

- Add-on upstream: `xangin/line-oa-ha-addon` at `afb9fe582013a50324a8aa9f7e04cfd5d2338000`.
- HACS upstream: `xangin/line-oa-hacs` at `977980f149e8fc0d4a9f5ccaed3a1455b8c1b904`.
- Original prototype retained under `prototype/`; its fixture tests are not deployment verification.
- Upstream LICENSE is retained. Historical upstream docs and workflows are references; the development guide below takes precedence.

One Add-on manages up to 20 accounts. Each has its own LINE session, cookie jar, contacts, sender and data directory. Gateway API authentication and HA pairing are shared. Explicit `account` is required on HA send actions; account IDs use lowercase letters, digits, underscores and hyphens, starting with a letter (1–32 chars).

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

Signature verification uses original bytes and the account's secret, then checks `destination` against the logged-in OA bot ID. Requests are durably queued before 200. The bounded inbox retains the last 2000 events; deduplication covers that retained window, including restarts. HA polls every five seconds and fires `line_oa_message` with `account`, event ID and sanitized fields. Delivery to the HA bus and cursor persistence are not an atomic transaction; a crash can replay an event. Automations should deduplicate by account and webhook event ID if needed. No automatic reply is implemented.

Use a test HA instance and test recipients. The sender uses LINE's unofficial management interface; a successful HTTP submission is not proof of device delivery. Live QR login, multiple real OA accounts, message delivery and LINE Developers verification remain acceptance tests.

See [INSTALL-HAOS.md](INSTALL-HAOS.md) for development installation, rollback and acceptance checks; [VALIDATION.md](VALIDATION.md) records actual validation status.
