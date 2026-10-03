# Railway Watch

A small web app that runs on your Mac (works on Linux too), polls the two Indian Railways sites you use by hand, and wakes you up the moment something changes:

* **Chart preparation** – the same check as <https://www.irctc.co.in/online-charts/> (train, journey date, boarding station).
* **Seat availability** – the same query as <https://www.indianrail.gov.in/enquiry/SEAT/SeatAvailability.html> (train, date, source, destination, class, quota), including its arithmetic captcha.

Alerts go to **Telegram**, **Messages (iMessage/SMS from your Mac)**, optional **Twilio SMS** or a **webhook**, a **loud looping alarm on the Mac**, and a **siren in every open browser tab** (your phone too, if it has the page open). The UI is a mobile-friendly web page served from your Mac, so you can add watches and silence alarms from your phone on the same Wi-Fi.

No build step, no database, no accounts: Node.js 20+ only.

## Quick start (5 minutes)

```bash
git clone <this repo> && cd railway-public-app
npm install
node scripts/probe.js 18101 2026-10-04 TATA CNB 2A GN   # proves both sites answer from your network
npm start                                                # http://localhost:3000
```

Open <http://localhost:3000>. The terminal also prints a `http://192.168.x.x:3000` address for your phone.

1. Type the train number, pick the date, pick boarding/destination from the route list (fetched from IRCTC), pick class and quota.
2. Press **Check once now** to see what both sites currently say.
3. Press **Start watching**. Default is every 60 s; minimum 30 s.
4. Fill in **Settings** once: Telegram, Messages, alarm sound. Use the **Test** buttons.
5. Tap **🔔 Arm browser alarm** on every device where you want the page itself to ring (browsers only play audio after a tap).

### The captcha (one-time teaching)

indianrail.gov.in shows a tiny arithmetic image (`12+7=?`). It is drawn with a fixed pixel font and no noise, so the app segments the symbols and matches them exactly. **It starts with no known symbols.** The first time it meets a symbol it has not seen, the image lands in the **Captcha trainer** panel; type what the image says (for example `12+7=?` or `3x4=?`) and press **Teach**. Each symbol is learned once and stored in `data/captcha-learned.json`. After roughly 10–15 images covering all digits and the operators, it solves every captcha on its own. Until then the seat check reports "could not solve the captcha" and retries on the next poll; the chart check is unaffected.

## How it works

The browser pages are thin front-ends over public JSON endpoints, which the app calls directly from your machine (nothing is proxied through a server of ours):

| What | Endpoint |
|---|---|
| Train list | `GET https://www.irctc.co.in/eticketing/trainList` |
| Route / boarding stations | `GET https://www.irctc.co.in/eticketing/protected/mapps1/trnscheduleenquiry/<trainNo>` with headers `greq: <epoch ms>`, `bmirak: webbm` |
| Chart status | `POST https://www.irctc.co.in/online-charts/api/trainComposition` body `{"trainNo","jDate":"yyyy-mm-dd","boardingStation"}` → `chartOneDate` / `chartTwoDate` non-null means prepared; `error` carries "chart not prepared" style messages |
| Vacant berths after charting | `POST https://www.irctc.co.in/online-charts/api/vacantBerth` |
| Session cookie | `GET https://www.indianrail.gov.in/enquiry/CaptchaConfig` |
| Captcha image | `GET https://www.indianrail.gov.in/enquiry/captchaDraw.png?<ts>` |
| Seat availability | `GET https://www.indianrail.gov.in/enquiry/CommonCaptcha?inputCaptcha=<answer>&inputPage=SEAT&trainNo=…&dt=dd-mm-yyyy&sourceStation=…&destinationStation=…&classc=2A&quota=GN&language=en` → `avlDayList[]` |

The captcha answer stays valid for the session until the server replies `Session out or Bot attack`, at which point a new captcha is fetched automatically. The station/train parameters are sent exactly as the site's own form sends them (`"TATANAGAR JN. - TATA"`, `"18101 - TATA JAT EXP"`, looked up from the site's own autocomplete lists); switch to bare codes in Settings if the site ever changes.

The IRCTC endpoints were verified by other people from a phone/laptop in September 2026; `curl` is rejected by Akamai but Node's `fetch` is accepted. IRCTC also **blocks datacenter and most VPN addresses** (HTTP 403). Run the app from home Wi-Fi or a phone hotspot. When the app sees a 403/429 it pauses that watch for 15 minutes and tells you.

The sandbox this app was written in could not reach either site, so the request shapes come from the verified community clients linked below and from the sites' JavaScript behaviour; `scripts/probe.js` is the first thing to run on your Mac. If the chart check reports `prepared=false` with an unexpected `error`, or the seat check reports an `errorMessage`, paste the probe output into an issue.

* <https://github.com/pratyakshmaroo/irctc-chart-explorer> (docs/research/irctc-flow.md: verified IRCTC chart endpoints)
* <https://github.com/nikhilkumarsingh/pyinrail> and the `ntes-client` package (indianrail.gov.in captcha session flow)

## Scheduling and politeness

* Each watch has its own interval (default 60 s, minimum 30 s) with 0–3 s of jitter.
* At most 3 watches run at once, and calls to the same host are serialised with a 500 ms gap, so 10 watches at 1 minute cost each site about 10 requests per minute. Throughput is bounded by one call per (gap + site latency) per host, roughly 40–60 checks per minute with the real sites; 50 watches at 1 minute is about the ceiling, beyond that polls drift and the stress test reports it.
* Errors double the interval (up to 16×); the watch resumes its normal interval on the next success.
* A chart alert fires once per watch. A seat alert fires when the status **enters** the rule (AVAILABLE, RAC-or-better, WL ≤ N, any change, or a regex) and again only if the status changes; set *Re-notify while matching* to keep nagging every N minutes.
* Watches stop by themselves 36 h after the journey date, or when the chart is prepared and booking has closed.

## Keeping the Mac awake (important)

A sleeping Mac cannot poll or ring. The app does the first part for you and you do the second:

1. **Automatic:** on macOS the server runs `caffeinate -ims -w <its own pid>` (Settings → *Keep this Mac awake*). That blocks idle/system sleep while the app runs, even on battery. Choose *Block system and display sleep* if you also want the screen to stay on.
2. **Lid closed = sleep, no matter what.** `caffeinate` cannot override closing the lid unless the Mac is plugged in **and** connected to an external display. Leave the lid open (the screen can be dimmed or locked; sound still plays) or use clamshell mode with power and a monitor.
3. **System Settings → Battery / Energy** (Ventura or later): turn on *Prevent automatic sleeping on power adapter when the display is off* and plug the Mac in. On the *Lock Screen* pane set *Turn display off* as you like; it does not affect polling.
4. **Alarm while locked/muted:** the alarm sets the system output volume before ringing (Settings → *Force system volume*). It plays even on the lock screen. Headphones plugged in will capture the sound.
5. **Terminal must stay open** (or run it as a background service):

   ```bash
   # keep it running after you close Terminal
   nohup npm start > railway-watch.log 2>&1 &
   ```

   For a permanent service use a `launchd` agent; a template is below.
6. **If you really want the Mac to never sleep** (even with the lid closed, no monitor): `sudo pmset -a disablesleep 1` (undo with `0`). This is an unsupported knob and drains the battery if unplugged; prefer options 1–3.
7. Power Nap / scheduled wake (`pmset repeat wake …`) is not needed when the Mac is kept awake, and it does not wake the Mac reliably from lid-closed sleep for ordinary apps, so it is not used.

Telegram is independent of your Mac's sleep state only in the sense that once sent it reaches your phone; the sending still needs the Mac awake. If you also want a check that runs when the Mac is off, the same code runs unchanged on any always-on Linux box or Raspberry Pi at home (same Wi-Fi, so IRCTC sees a residential IP).

### launchd template (optional)

Save as `~/Library/LaunchAgents/in.railway.watch.plist`, edit the two paths, then `launchctl load ~/Library/LaunchAgents/in.railway.watch.plist`.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>in.railway.watch</string>
  <key>ProgramArguments</key><array><string>/usr/local/bin/node</string><string>/Users/you/railway-public-app/server/index.js</string></array>
  <key>WorkingDirectory</key><string>/Users/you/railway-public-app</string>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/railway-watch.log</string><key>StandardErrorPath</key><string>/tmp/railway-watch.log</string>
</dict></plist>
```

## Notification channels

**Telegram** – talk to `@BotFather`, `/newbot`, copy the token into Settings. Open a chat with your new bot and send it `/start`, then press **Find chat id** in Settings, then **Save** and **Test Telegram**. For a group, add the bot to the group and send a message there first.

**Messages (iMessage / SMS)** – macOS only. Enter the recipient exactly as it appears in Messages (`+919876543210` or an Apple ID email). The first send makes macOS ask whether Terminal (or node) may control Messages; click Allow (System Settings → Privacy & Security → Automation if you missed it). *SMS* works only if your iPhone has *Text Message Forwarding* enabled for this Mac; otherwise keep *iMessage* (you can message your own number).

**Twilio** – optional real SMS from anywhere: export `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` before `npm start` and enter the recipient.

**Webhook** – POSTs `{title, body, level, watchId, meta}` as JSON to any URL (Slack/Discord webhooks, Home Assistant, a Shortcut, …).

**Alarm on this Mac** – loops a system sound (`/System/Library/Sounds/*.aiff`; `Sosumi` and `Funk` are loud) for the configured time or until you press **Stop alarm** on any device, after speaking the alert with `say`. On Linux it uses `paplay`; on any OS you can set a custom command.

**Browser siren** – every open tab gets a web notification, vibration (phones) and a two-tone siren for 90 s, provided you tapped **Arm browser alarm** once on that device.

## Using it from your phone

The page is responsive. On the same Wi-Fi open the `http://192.168.x.x:3000` address printed at startup (or shown under *Diagnostics*). To reach it from outside your home, run [Tailscale](https://tailscale.com) on the Mac and the phone and open the Mac's Tailscale IP; do not expose port 3000 to the internet, there is no login.

## Testing

```bash
npm test          # unit + integration tests against an in-process mock of both sites
npm run stress    # 50 watches polling every 5 s for 60 s against the mock (≈10× the load of 50 watches/minute)
WATCHES=10 INTERVAL=60 DURATION=180 npm run stress   # your real cadence
npm run mock      # standalone mock; then IRCTC_BASE=http://127.0.0.1:4000 INDIANRAIL_BASE=http://127.0.0.1:4000 npm start
```

The mock reproduces both sites' JSON shapes, the cookie session, captcha images (drawn with its own test font), "Session out or Bot attack" expiry, a chart that becomes prepared after N seconds, availability that walks through WL → RAC → AVAILABLE, plus injectable latency and 503s. The stress run prints achieved vs ideal poll counts, latency percentiles, event-loop lag, upstream call counts, captcha sessions and RSS growth.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `PORT` / `HOST` | `3000` / `0.0.0.0` | listen address |
| `DATA_DIR` | `./data` | state, caches, learned captcha symbols, unknown captcha images |
| `IRCTC_BASE`, `INDIANRAIL_BASE` | real sites | point at the mock |
| `IRCTC_BROWSER_HEADERS=1` | off | add browser User-Agent/Referer headers to IRCTC calls (try if you get 403s with the defaults) |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | – | Twilio SMS |

Everything else is in the Settings panel and stored in `data/state.json`.

## Limitations and honesty notes

* Both sites can change their HTML/JSON at any time; the app logs raw replies under *Diagnostics* and the probe script prints them.
* The captcha solver only knows symbols you have taught it. If the site ever adds noise or a new font, teaching stops working and you would need an OCR fallback (tesseract) — not included.
* Polling every minute from one home IP for one or two trains is well within what the sites serve to a normal user clicking refresh; do not run hundreds of watches.
* There is no authentication on the web UI. Keep it on your LAN or behind Tailscale.
