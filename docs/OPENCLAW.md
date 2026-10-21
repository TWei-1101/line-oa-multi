# HA → OpenClaw on Mac → LINE OA Multi

This bridge extends the existing Add-on. LINE enters through the existing HACS
`webhook_path`; the Add-on saves a job before HA acknowledges it, calls OpenClaw,
and submits its final answer through the existing OA Manager session. It never
calls the official LINE reply/push send APIs. No YAML automation is required.

## Supported content

- Incoming text and JPEG/PNG images (up to 10 MiB each).
- Final text answers, split into at most 200 parts of 5,000 UTF-16 units without
  truncating characters or splitting emoji surrogate pairs.
- JPEG/PNG output images, in response order. The Mac adapter converts local
  `MEDIA:path` and Markdown image references into inline images for HA.
- A separate OpenClaw conversation for each OA account and LINE user/group/room.
  Members of a group share its conversation. Separate text/image webhook events
  are separate turns; an album is not currently collected into one turn.

Video, audio, documents, remote Markdown image URLs, and non-PNG/JPEG output are
not implemented. Unsupported output or an incomplete AI answer is retained as a
failed job instead of reporting the answer as successfully forwarded. Rich text
formatting is sent as text, not reproduced as a LINE rich card.

## 1. Prepare OpenClaw on the Mac

Use Node.js 24 or newer (the Add-on is tested with Node 24). Enable the documented
Responses endpoint, then restart the Gateway:

```sh
openclaw config set gateway.http.endpoints.responses.enabled true
openclaw gateway restart
```

The bridge calls `POST /v1/responses` and waits for its completed JSON response;
the inbound hooks endpoint's acceptance response is not an AI answer.
OpenClaw must use an image-capable model for image understanding.

The Responses endpoint is an operator endpoint. Use only approved LINE sources
and a dedicated agent with tools limited to what those sources may do. The
bridge's conversation separation is not a security sandbox for agent tools.

Keep OpenClaw itself on loopback. Download the Mac adapter from this repository:

```sh
mkdir -p "$HOME/line-oa-bridge"
cd "$HOME/line-oa-bridge"
curl --fail --location --output openclaw-mac.ts \
  https://raw.githubusercontent.com/TWei-1101/line-oa-multi/main/line_oa/app/scripts/openclaw-mac.ts
```

In the Mac's default zsh, enter the Gateway token privately. Obtain it locally
from your OpenClaw Gateway authentication configuration; do not paste it in chat.

```sh
read -s 'OPENCLAW_GATEWAY_TOKEN?OpenClaw Gateway token: '; echo
export OPENCLAW_GATEWAY_TOKEN
export LINE_OA_BRIDGE_TOKEN="$(openssl rand -hex 32)"
export LINE_OA_BRIDGE_BIND=192.168.1.50
export LINE_OA_MEDIA_ROOT="$HOME/.openclaw/workspace"
node openclaw-mac.ts
```

Replace `192.168.1.50` with this Mac's actual private LAN IP. The adapter listens
on port 18790. Copy `LINE_OA_BRIDGE_TOKEN` privately into the Add-on's connection
settings (before starting the foreground process, `printf '%s' "$LINE_OA_BRIDGE_TOKEN" | pbcopy`
copies it without printing it). The adapter has a separate token and keeps the
OpenClaw Gateway token on the Mac. No port forwarding to the Mac is required.
Use this only on a trusted LAN; use a private VPN or HTTPS for untrusted networks.

This command runs in the foreground: closing the terminal or Mac sleep suspends
processing. Pending work stays on HA. For background operation, save these
environment values in a private file and use the launchd example below.

Output images must be written underneath `LINE_OA_MEDIA_ROOT`, for example
`~/.openclaw/workspace/line-output/answer.png`. Configure the dedicated agent to
write there and return `MEDIA:/absolute/path/to/answer.png` on its own line.
Symlinks or `..` references escaping the root are rejected. The adapter doesn't
fetch arbitrary image URLs or expose a file server.

### Optional automatic startup

Store configuration at `~/line-oa-bridge/bridge.env` using a local editor and
restrict it with `chmod 600 ~/line-oa-bridge/bridge.env`:

```dotenv
OPENCLAW_GATEWAY_URL=http://127.0.0.1:18789
OPENCLAW_GATEWAY_TOKEN=YOUR_LOCAL_GATEWAY_TOKEN
LINE_OA_BRIDGE_TOKEN=YOUR_SAVED_RANDOM_BRIDGE_TOKEN
LINE_OA_BRIDGE_BIND=192.168.1.50
LINE_OA_MEDIA_ROOT=/Users/YOUR_MAC_USER/.openclaw/workspace
```

Create `~/Library/LaunchAgents/local.line-oa-openclaw.plist` using this template;
replace the username and Node path with your actual values (`command -v node`).
Do not leave placeholder paths in the plist. Environment secrets stay in the
private env file rather than in launchd arguments.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
 <key>Label</key><string>local.line-oa-openclaw</string>
 <key>ProgramArguments</key><array>
  <string>/opt/homebrew/bin/node</string>
  <string>--env-file=/Users/YOUR_MAC_USER/line-oa-bridge/bridge.env</string>
  <string>/Users/YOUR_MAC_USER/line-oa-bridge/openclaw-mac.ts</string>
 </array>
 <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
 <key>ThrottleInterval</key><integer>10</integer>
</dict></plist>
```

After stopping the foreground adapter, load it once:

```sh
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/local.line-oa-openclaw.plist"
```

This starts after login and restarts a failed adapter; it doesn't wake a sleeping
Mac or start the OpenClaw Gateway. Configure OpenClaw's own startup separately.
To stop the adapter, use `launchctl bootout` with the same domain and plist path.

## 2. Configure HA / Add-on

1. Update the Add-on to `0.3.0-dev.1` after its exact commit's amd64/aarch64
   Actions builds and smoke checks pass. Existing account sessions/aliases are
   reused. Keep the existing HACS integration installed and paired.
2. In the Web UI, choose **OpenClaw 橋接 → 連線設定**. Enter
   `http://MAC_LAN_IP:18790/v1/responses`, the adapter's bridge token, your agent ID
   (`main` by default), and a timeout sufficient for a complete answer.
3. For `aiassistant`, enable the existing **Webhook** with that account's Channel
   Secret. Set LINE Developers' Webhook URL to your public HTTPS HA URL plus
   `sensor.line_oa_session_status`'s `webhook_path`. Enable Use webhook and Webhook
   redelivery. This replaces that channel's direct OpenClaw Webhook URL.
4. Send a test LINE message. Open **aiassistant → OpenClaw 設定**, add its recent
   source ID, select the matching OA contact alias created under **管理／登入**,
   and enable automatic replies. The first discovery message doesn't auto-reply;
   send a second message after saving the binding.
5. Enter **that same account's Channel Access Token** in the account's OpenClaw
   settings to download incoming images. It is never used for official sending.
   Leave `family`'s Webhook and OpenClaw disabled if it only sends HA notifications.
6. Check **更新工作狀態** for queued, submitted, failed or uncertain work.

Do not also forward `line_oa_message` to OpenClaw with an automation: that would
create a second AI turn. Existing HA command automations may still consume the
event if desired, but should not generate another reply for the same command.

Direct connection to OpenClaw's `/v1/responses` at port 18789 is supported for
text and inline image output. The Mac adapter is required for local image files.
Do not expose either administrative API publicly.

## Reliability and recovery

- SQLite transactions with synchronous FULL commit save accepted bridge work
  before webhook success. A bridge commit followed by an inbox-write failure is
  safe to redeliver: account + event ID identifies the same job.
- Per-conversation order is preserved. A failed/uncertain job holds later answers
  in that conversation; other conversations can continue. One job runs at a time.
- Incoming images are cached independently of waiting AI turns while HA is up.
  LINE content availability is still finite: a long HA outage can prevent download.
- Definite pre-send failures/rate limits retry up to 8 times with backoff. Completed
  answer parts and the next unsent part survive restart, without regenerating AI.
- A lost AI result or restart during generation requires review: rerunning could
  repeat agent tool effects. An in-flight send at restart or unknown send result
  is never automatically replayed. Use **重試**, **略過此工作**, or **已確認本段送出**
  after checking LINE; the last option advances only the current uncertain part.
- `submitted` means OA Manager accepted the request, not recipient delivery.
  No exactly-once delivery guarantee is possible with this unofficial sender.
- At most 1,000 outstanding jobs; enqueue refuses a full queue with HTTP 503 so
  LINE can retry. Stored job payloads are bounded to approximately 128 MiB. Failed
  jobs are retained; review/skip them to free capacity. Completion records retain
  up to 4,000 IDs / 30 days, pruned on admission. Completion clears cached message
  text/images. Very old redeliveries beyond retention may be processed again.
- Disabling an account pauses existing jobs; re-enabling resumes them. A route is
  snapshotted at admission. Change bindings only after reviewing outstanding jobs.
  Account deletion is refused while it has outstanding bridge jobs.
- Settings, tokens and queued payloads are private local Add-on data at
  `/data/multi/openclaw.sqlite`; cold HA backups include them and must be protected.
  The bridge stays off until explicitly configured per account.

## Acceptance tests — still required on your Mac/HA

- Text and images in both directions, and a response longer than 5,000 characters.
- Private/group source bindings, correct account and correct recipient.
- Mac offline then online, Add-on restart between answer parts, and manual review
  of a deliberately uncertain send. Confirm actual LINE receipt separately.
- Mac login startup/sleep behavior, backup/restore, and your installed OpenClaw
  version's Responses API and media output shape.

References: [OpenClaw Responses endpoint](https://docs.openclaw.ai/gateway/openresponses-http-api),
[LINE incoming content](https://developers.line.biz/en/reference/messaging-api/#get-content),
[LINE webhook redelivery](https://developers.line.biz/en/docs/messaging-api/receiving-messages/).
