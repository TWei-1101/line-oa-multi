# Validation record — 2026-10-19

## Verified locally

- Complete upstream Add-on sources at afb9fe582013a50324a8aa9f7e04cfd5d2338000 integrated using the supplied patch script; complete HACS runtime sources and upstream tests at 977980f149e8fc0d4a9f5ccaed3a1455b8c1b904 integrated.
- Node 24 / TypeScript strict build and upstream plus real multi-gateway tests: 80 passed. Includes actual HTTP Ingress denial, CSRF, child UI routing, shared pairing identity, independent account directories, registry restart/delete, raw signature verification, destination rejection, concurrent deduplication and inbox restart.
- Home Assistant 2026.9.0: 244 passed (Python 3.14.8, pytest-homeassistant-custom-component 0.13.363).
- Home Assistant 2026.10.1: 244 passed (Python 3.14.8, pytest-homeassistant-custom-component 0.13.372).
- Ruff code checks/format pass; mypy strict passes for 15 integration modules.
- Backup/version metadata checks pass. Full publication scanner includes historical upstream docs and is not a release gate for those historical references.

## Corrections to the supplied prototype

- Real upstream build replaces fixture-only confidence. Original prototype retained, but its stubs are not runtime dependencies.
- HACS discovery accepts the new line_oa_multi slug, so it cannot accidentally pair this fork to an upstream single-account instance.
- Child UI pairing reads/resets use the control Gateway's actual pairing identity.
- HA Webhook bridge consumes a complete bounded stream, including chunked HTTP requests; a single read could previously truncate the signed body.
- HA event polling is serialized and starts on the five-second interval; it does not create an orphaned startup poll during config reload.
- Account deletion refuses in-flight child requests; settings changes refuse concurrent registry mutations.
- Runtime/Docker/package version metadata aligned. Experimental stage; upstream publication workflows archived and not executed.

## Not verified / blocked

- GitHub branch upload: GitHub Contents API returned HTTP 403 “Resource not accessible by integration”. Git push had no usable credentials. Repository metadata permissions are not proof that the installed GitHub App has write permission.
- Remote GitHub Actions: not run, because no code could be uploaded.
- Docker images for amd64/aarch64: not built locally (Docker unavailable). CI defines native builds and smoke checks; an unexecuted workflow is not evidence of success.
- HAOS installation, Supervisor discovery/Ingress on a real appliance, QR login against live LINE, multiple real OA sessions, text/image delivery, LINE Developers webhook verification and resource use remain unverified.

## Known limits

- Shared Gateway API credential and HA identity; LINE credentials/contact stores are per account. This is account isolation inside one trusted service, not separate security tenants/processes.
- Up to 20 account IDs. Each account uses an upstream SessionManager/LINE client and its own cookies, contacts, sender and QR flow.
- Inbox and deduplication retain the last 2000 events; older redeliveries may be accepted again. Polls deliver up to 100 every five seconds. Overflow can create gaps, which HA logs.
- HA bus delivery and cursor updates cannot provide exactly-once delivery across a crash. Downstream automations should deduplicate account plus webhook_event_id.
- Incoming events are sanitized and do not contain replyToken. No automated reply or official Messaging API sender has been added.
- Aggregate sensors mean at least one account connected; they are not per-account entity sensors. Inspect account cards for individual state.
- Deleting an account intentionally destroys its local credentials, contacts, webhook secret and retained events. This is not migration from an existing single-account Add-on; take a full backup first.
- The HACS domain remains line_oa. Do not run the upstream integration and this fork as two copies of the same domain in one HA instance.
