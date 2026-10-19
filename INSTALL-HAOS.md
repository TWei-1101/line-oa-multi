# HAOS development testing — not released for installation yet

This handoff is a development source snapshot, not a verified HAOS build. Do not treat the historical `prototype/INSTALL-HAOS.md` or upstream installation docs as instructions for this integrated fork.

The user requested HAOS installation instructions only after build success. Those instructions are therefore deferred until both native container jobs pass on the exact uploaded commit.

## Required gates

1. Restore GitHub App repository write access for TWei-1101/line-oa-multi. Its Contents API currently rejects writes with HTTP 403. Workflow writes may also require additional GitHub App permission. Never paste an access token into chat.
2. Push the prepared `dev/multi-account-webhook` branch; do not overwrite any upstream repository. Keep the project experimental.
3. Run `.github/workflows/ci.yml` on that commit and inspect both amd64 and aarch64 jobs: npm tests, Docker build, runtime health, private ports, architecture labels, graceful stop, restart and stable identity.
4. Inspect both HACS jobs (HA 2026.9.0 and 2026.10.1): Ruff, pytest, compilation; mypy runs with HA 2026.10.1.
5. Record the successful Actions URL and commit SHA in VALIDATION.md. A source compile/test success alone is not a container build success.
6. Only then provide branch-specific HAOS repository/HACS installation instructions. Confirm the repository's actual default branch and HACS branch availability first; do not assume HACS will install the development branch.

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
