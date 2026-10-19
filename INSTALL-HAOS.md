# HAOS development installation

This is an experimental build. The GitHub Actions matrix has passed on native amd64 and aarch64 runners, and live two-account login/message sending has been reported. Webhook, backup/restore and long-running production use still require validation. Do not treat the historical `prototype/INSTALL-HAOS.md` or upstream installation docs as instructions for this integrated fork.

## Install the Add-on

1. Take a full Home Assistant backup and download a copy off the appliance.
2. Remove or stop the upstream LINE OA Add-on and integration. This fork uses the same `line_oa` integration domain and must not coexist with it.
3. In **Settings > Apps/Add-ons > Store > Repositories**, add `https://github.com/TWei-1101/line-oa-multi`.
4. Refresh the store and install **LINE OA Multi**. Confirm slug `line_oa_multi`, stage `experimental`, version `0.2.0-dev.1`, and architecture amd64 or aarch64.
5. Start the Add-on and open its Web UI. Add each account with a unique lowercase ID and complete QR login separately.

## Install the HACS integration

1. In HACS, open **Custom repositories**.
2. Add `https://github.com/TWei-1101/line-oa-multi` and select type **Integration**.
3. Download **LINE OA Multi (Development)** and restart Home Assistant Core.
4. With the Add-on running, accept the discovered LINE OA service under **Settings > Devices & services**, or add LINE OA manually.
5. Confirm `sensor.line_oa_session_status` exists and reports `ready`.

The Add-on Web UI works without the HACS integration, but HA entities, actions, the public Webhook bridge and `line_oa_message` events require the integration.

## Acceptance plan after those gates

- Take a full HA backup and save existing LINE integration configuration. Use a test HA instance where possible. The integration's domain is line_oa and replaces, rather than coexists with, the upstream HACS integration.
- Verify the Add-on is named LINE OA Multi, slug line_oa_multi, stage experimental, version 0.2.0-dev.1, without an upstream `image:` reference.
- Verify Supervisor discovery pairs to the Multi instance; open Ingress, add alpha/beta, scan each account's QR separately, and confirm the bot identity and contact aliases never cross.
- Send one text and one image to a confirmed test recipient from each account using explicit account IDs; check submission state and actual recipient delivery independently.
- Restart Add-on and HA; confirm registry, sessions, aliases and pairing persist.
- Configure unique Channel Secrets and external HTTPS webhook URLs from the status sensor's webhook_path. LINE destination must match the logged-in OA bot ID. Test correct signature, modified body, wrong secret, wrong destination and redelivery.
- Listen for line_oa_message in Developer Tools; check account attribution and event IDs. Verify restart does not replay a retained event already consumed under normal operation.
- Delete only a disposable test account; verify another account is unaffected. Test backup/restore before using real accounts.

Rollback: stop the Multi Add-on, restore the previous custom_components/line_oa directory and HA backup/configuration, restart HA, and re-enable the original Add-on if needed. Keep the Multi data backup until acceptance is complete. Do not copy credential directories between unrelated accounts.
