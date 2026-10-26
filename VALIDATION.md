# Validation record — 2026-10-19

## Upstream Add-on v0.1.10 sync — 2026-10-26

- Ported the complete upstream delta from `afb9fe582013a50324a8aa9f7e04cfd5d2338000`
  (v0.1.9) through `7ccb348e5b43a11171937e528f0d8ce973bf7ff8`
  (v0.1.10), while retaining the fork's multi-account, OpenClaw, recipient-binding,
  session and durable-job behavior.
- Node 24.18.0 strict TypeScript build and the complete native suite pass locally:
  174 passed / 0 failed with `TMPDIR=/private/tmp`. This includes the new bounded
  per-account text/image FIFO, pending request-ID retention, disconnect cancellation,
  safe shutdown, recipient-change protection and OpenClaw retry classification.
- Backup exclusions and version metadata checks pass. The HACS sources were not
  changed by this sync; their Ruff, mypy and pytest matrices are left to the remote
  release gate because those tools are not installed in this local environment.
- No live LINE message was sent and no running Home Assistant/OpenClaw configuration,
  account, session or queue was modified during this source validation.

## OpenClaw bridge — 2026-10-21

- Add-on `0.3.0-dev.1` adds optional per-account OpenClaw Responses bridging,
  incoming image download, ordered text/image output, durable SQLite jobs,
  retained incomplete/uncertain results, and Ingress/CSRF-protected configuration.
- Node 24.19.0 / strict TypeScript build passed locally. All 14 new bridge/Mac
  adapter tests and both multi-gateway tests passed (16 targeted tests), covering
  signed admission, duplicate/restart suppression, own-account image credentials,
  exact long Unicode text reconstruction, image order, preflight retry, uncertain
  sends, queue backpressure, private media-root enforcement and secret redaction;
  also concurrent image caching during slow AI turns, offline reconnect, held-lane
  isolation and redelivery after a bridge commit/inbox-write failure.
- Native Windows full suite: 85 passed / 5 failed. These failures concern existing
  POSIX mode assertions (Windows doesn't represent 0600/0700) and the existing
  API-key revocation directory fsync. Linux CI is the deployment gate; the new
  bridge's local pass does not override failures on the target platform.
- Runtime commit `df25afc60635dbb1c94de72d577e40ee5ebbf976` passed
  [GitHub Actions 39569850782](https://github.com/TWei-1101/line-oa-multi/actions/runs/39569850782):
  native amd64 and aarch64 each passed all 94 Node tests, Docker builds and
  container smoke checks (health, private ports, graceful stop, restart, stable
  identity). Both HACS matrices passed 244 tests plus Ruff/compilation; the newer
  matrix also passed mypy for all 15 integration modules.
- The first bridge CI run failed only because an existing health-contract test
  hard-coded the previous release version. The test now compares runtime health
  to package metadata; the subsequent full runs passed.
- Backup/version checks pass. Settings/read-only status and job-review routes
  are covered by HTTP authentication/CSRF checks. JavaScript syntax checks pass;
  interactive visual browser QA could not run because no in-app browser backend
  was available. The UI remains part of device acceptance.
- Real Mac/HAOS/LINE end-to-end, installed OpenClaw API compatibility, Mac image
  tools/paths, launchd startup, sleep/offline recovery and recipient delivery:
  **pending device validation**. No live LINE message was sent in these tests.

## Verified locally

- Complete upstream Add-on sources at afb9fe582013a50324a8aa9f7e04cfd5d2338000 integrated using the supplied patch script; complete HACS runtime sources and upstream tests at 977980f149e8fc0d4a9f5ccaed3a1455b8c1b904 integrated.
- Node 24 / TypeScript strict build and upstream plus real multi-gateway tests: 80 passed. Includes actual HTTP Ingress denial, CSRF, child UI routing, shared pairing identity, independent account directories, registry restart/delete, raw signature verification, signed first-contact destination binding, later destination rejection, concurrent deduplication and inbox restart.
- Home Assistant 2026.9.0: 244 passed (Python 3.14.8, pytest-homeassistant-custom-component 0.13.363).
- Home Assistant 2026.10.1: 244 passed (Python 3.14.8, pytest-homeassistant-custom-component 0.13.372).
- Ruff code checks/format pass; mypy strict passes for 15 integration modules.
- Backup/version metadata checks pass. Full publication scanner includes historical upstream docs and is not a release gate for those historical references.

## Verified remotely

- Branch `dev/multi-account-webhook` was uploaded to `TWei-1101/line-oa-multi` at `49967c7eeffb9b3a66fda859bcc45cc9d239f972`.
- GitHub Actions run https://github.com/TWei-1101/line-oa-multi/actions/runs/39260235941 completed successfully: native amd64 and aarch64 npm tests, Docker builds and container smoke checks all passed; both HACS matrices passed, including Ruff, pytest, compilation and mypy on the newer matrix.
- The user reported successful QR login and message sending with two live accounts on HAOS. This is user-reported acceptance evidence, not an automated test or an independent device audit.
- The user reported that LINE Developers Webhook verification succeeded on HAOS with Add-on `0.2.0-dev.2` after signed first-contact destination binding replaced the invalid OA Manager/Messaging API ID equivalence assumption.

## Corrections to the supplied prototype

- Real upstream build replaces fixture-only confidence. Original prototype retained, but its stubs are not runtime dependencies.
- HACS discovery accepts the new line_oa_multi slug, so it cannot accidentally pair this fork to an upstream single-account instance.
- Child UI pairing reads/resets use the control Gateway's actual pairing identity.
- HA Webhook bridge consumes a complete bounded stream, including chunked HTTP requests; a single read could previously truncate the signed body.
- HA event polling is serialized and starts on the five-second interval; it does not create an orphaned startup poll during config reload.
- Account deletion refuses in-flight child requests; settings changes refuse concurrent registry mutations.
- Runtime/Docker/package version metadata aligned. Experimental stage; upstream publication workflows archived and not executed.

## Not verified / blocked

- Docker images were not built on the handoff workstation because Docker was unavailable; the equivalent native GitHub Actions builds and smoke checks passed.
- Independent verification of the reported HAOS installation, Supervisor discovery/Ingress, recipient delivery and account isolation has not been performed.
- A live LINE Developers verification attempt exposed that LINE OA Manager's internal bot ID cannot always be equated with the Messaging API `destination`; `0.2.0-dev.2` fixed this and the user subsequently reported successful verification. Actual message-event delivery, invalid-signature/destination behavior on the live endpoint, restart persistence, backup/restore, long-running resource use and destructive account deletion remain unverified on a real appliance.

## Known limits

- Shared Gateway API credential and HA identity; LINE credentials/contact stores are per account. This is account isolation inside one trusted service, not separate security tenants/processes.
- Up to 20 account IDs. Each account uses an upstream SessionManager/LINE client and its own cookies, contacts, sender and QR flow.
- Inbox and deduplication retain the last 2000 events; older redeliveries may be accepted again. Polls deliver up to 100 every five seconds. Overflow can create gaps, which HA logs.
- HA bus delivery and cursor updates cannot provide exactly-once delivery across a crash. Downstream automations should deduplicate account plus webhook_event_id.
- Incoming events are sanitized and do not contain replyToken. Optional OpenClaw automatic replies are disabled until configured; outgoing messages still use the existing OA Manager session, not an official Messaging API sender. See docs/OPENCLAW.md for queue retention, review and supported content limits.
- Aggregate sensors mean at least one account connected; they are not per-account entity sensors. Inspect account cards for individual state.
- Deleting an account intentionally destroys its local credentials, contacts, webhook secret and retained events. This is not migration from an existing single-account Add-on; take a full backup first.
- The HACS domain remains line_oa. Do not run the upstream integration and this fork as two copies of the same domain in one HA instance.
