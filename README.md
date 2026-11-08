# Lina — early-access landing (A/B)

Static site for validating the Lina idea (a subscription AI concierge). Two full
landing versions on one domain, plus a tiny signup API.

Live: **https://lina.mrfilldev.workers.dev**

| Route        | What                                                    |
|--------------|--------------------------------------------------------|
| `/`          | 50/50 splitter — client-side redirect, sticky per visitor |
| `/midnight/` | **Midnight** — dark, premium-tech, neural background   |
| `/daylight/` | **Daylight** — light, calm, human, anti-overwhelm      |
| `/build/`    | internal UTM link + QR generator (noindex)             |
| `/send/`     | personal tool to post to the channel as the bot (noindex, token-gated) |
| `POST /api/interest` | stores an early-access email (rate-limited per IP) |
| `GET /api/export` | JSON dump of all signups — `Authorization: Bearer <EXPORT_TOKEN>` |
| `GET /api/report?dry=1` | preview the daily report — same auth header      |
| `POST /api/report` | send the daily report to Telegram now — same auth   |
| `GET /api/send` | target channel info — same auth                        |
| `POST /api/send` | JSON `{text, mode, preview, silent}` or multipart `{photo, text, mode, silent}` → post as the bot |
| cron `0 9 * * *` | posts a daily stats summary to Telegram (12:00 MSK) |

The landing variants carry `<meta robots noindex>` while the A/B runs — traffic
comes from direct links, not search.

Every new signup also pings the Telegram channel instantly (`🟢 Новая заявка`);
pings self-throttle above 15/hour (the daily digest still counts everyone). Set
`INSTANT_ALERTS = "off"` in `wrangler.toml` to keep only the digest.

Both landings collect email (`/api/interest`). Analytics is still not wired —
see [Next steps](#next-steps).

---

## Structure

```
public/                  <- static assets, served straight from the edge
  index.html             <- 50/50 splitter
  midnight/index.html    <- Midnight landing (self-contained: inline CSS/JS)
  daylight/index.html    <- Daylight landing (self-contained)
  404.html               <- branded 404
  build/index.html       <- UTM link + QR generator (+ vendored qrcode.js)
  fonts.css, fonts/*.woff2  <- self-hosted Lora + Manrope + JetBrains Mono (Cyrillic)
  favicon.svg, favicon-32.png, favicon-180.png
  og-midnight.jpg, og-daylight.png   <- 1200x630 social cards
  _headers               <- security + cache headers
  robots.txt
src/index.js             <- Worker: /api/* endpoints; everything else -> ASSETS
assets-src/*.svg         <- editable sources for the OG images (see below)
wrangler.toml
```

No build step. Landing pages ship real text in the HTML; JS only swaps RU/EN and
handles the signup form.

---

## Local preview

```bash
npx wrangler dev        # http://localhost:8787 — Worker + assets + local KV
```

Signup writes go to a **local** KV in `.wrangler/` and never touch production.
To exercise the admin endpoints locally, put `EXPORT_TOKEN=whatever` in `.dev.vars`
(gitignored) and restart, then
`curl -H "Authorization: Bearer whatever" localhost:8787/api/export`.

---

## Deploy

One Worker serves the static assets (via the `ASSETS` binding) and the `/api/*`
routes. KV namespace `LEADS` holds signups.

```bash
npx wrangler login    # once
npx wrangler deploy    # every deploy
```

### Custom domain

Dashboard → the `lina` Worker → **Settings → Domains & Routes** → **Add**. TLS is
automatic. The domain's DNS must be on this Cloudflare account.

### Git auto-deploy (optional)

Push to GitHub, then Worker → **Settings → Build** → connect the repo
(build command empty, deploy command `npx wrangler deploy`).

---

## Reading signups

**Live tail** (each signup logs a line):

```bash
npx wrangler tail --format pretty
```

**Full export** — set the token once, then call the endpoint with it as a
**Bearer header** (not a query string — that would leak into logs and history):

```bash
npx wrangler secret put EXPORT_TOKEN     # paste a long random string
```

```bash
curl -H "Authorization: Bearer YOUR_TOKEN" https://lina.mrfilldev.workers.dev/api/export | jq
```

Returns `{ count, by_variant, leads: [...] }`, newest first. Each lead has
`email, variant, lang, utm, referer, country, ts`. Rotate the token by running
`wrangler secret put EXPORT_TOKEN` again.

**Raw KV** (dashboard → Workers & Pages → KV → `LEADS`, or CLI):

```bash
npx wrangler kv key list --binding LEADS --remote
```

Each lead's summary lives in the KV key's **metadata**, so the report/export/counts
read it from `list()` alone — no per-key GET, so nothing breaks past the Workers
subrequest cap once the list grows.

Dedup: a repeat email returns `{ok:true, dedup:true}` and is not stored twice.
A hidden honeypot field silently drops bots, and `/api/interest` is rate-limited
per IP (8/hour, 20/day) — best-effort (KV is eventually consistent), enough to
stop casual abuse. For hard protection add a Turnstile widget (needs a dashboard
step) — see Next steps.

---

## Daily Telegram report

A cron trigger (`0 9 * * *` UTC = 12:00 MSK) posts a summary to a Telegram
channel: new signups in the last 24h, running totals, the midnight/daylight
split, and top `utm_source`s.

Setup:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN   # from @BotFather
npx wrangler secret put TELEGRAM_CHAT_ID     # e.g. @your_channel or -1001234567890
```

The bot must be an **admin** of the channel. Until both secrets are set the cron
runs and no-ops (logs `report skipped`).

```bash
# preview without sending
curl -H "Authorization: Bearer YOUR_TOKEN" "https://lina.mrfilldev.workers.dev/api/report?dry=1" | jq -r .text
# send it right now
curl -X POST -H "Authorization: Bearer YOUR_TOKEN" https://lina.mrfilldev.workers.dev/api/report
```

- Change the time: edit `crons` in `wrangler.toml` (UTC) and redeploy.
- **Instant ping per signup**: on by default; `INSTANT_ALERTS = "off"` (a `[vars]`
  entry in `wrangler.toml`) keeps only the daily digest. Pings self-throttle above
  15/hour (one "тихий режим" notice, then silence till the hour rolls over).
- The 24h window is tracked by a `meta:last_report` key, clamped to 1h–8d so a
  missed run or a double-fire stays sane.

---

## Posting to the channel manually — `/send/`

`https://lina.mrfilldev.workers.dev/send/` — a personal page to write arbitrary
messages into the channel as the bot. `noindex`, and the send only works with the
`EXPORT_TOKEN` (paste it once, the page keeps it in `localStorage`).

- Format: **Текст** (plain, default — nothing to escape), **HTML**, or **MarkdownV2**.
- **Photo**: pick a file, drag it onto the box, or paste a screenshot from the
  clipboard. The message text becomes the caption (limit 1024). Up to 10 MB, images only.
- Options: link preview off by default; "без звука" for a silent post.
- 4096-char text limit (1024 for captions); a 30-per-10-min server cap in case the token leaks.
- Anyone with the token can post as the bot — treat the token like a password,
  rotate it with `wrangler secret put EXPORT_TOKEN` if it's ever exposed.

From the CLI instead of the page:

```bash
# text
curl -X POST -H "Authorization: Bearer YOUR_TOKEN" -H "content-type: application/json" \
  -d '{"text":"привет из канала","mode":"plain"}' \
  https://lina.mrfilldev.workers.dev/api/send

# photo + caption
curl -X POST -H "Authorization: Bearer YOUR_TOKEN" \
  -F photo=@pic.jpg -F "text=подпись" -F mode=plain \
  https://lina.mrfilldev.workers.dev/api/send
```

---

## How the 50/50 split works

`public/index.html` runs on `/` (client-side JS):

1. `?v=midnight` / `?v=daylight` in the URL wins, and is remembered.
2. Else reuse the visitor's earlier assignment (`localStorage` key `lina_variant`).
3. Else coin flip → assign → remember.
4. `location.replace('/<variant>/')`, preserving `utm_*` / `ref`.

One link — `https://lina.mrfilldev.workers.dev/` — splits evenly; a returning
visitor keeps the same version. Force one with `?v=daylight` or link
`/daylight/` directly. Reset while testing: clear site data / use a private window.

Caveats: the split is per-browser and needs JS. Link-preview crawlers hit `/`,
don't run JS, and aren't counted. Directly-shared `/daylight/` links accumulate
traffic that never went through the coin flip.

---

## Distributing links

Tag per channel:

```
https://lina.mrfilldev.workers.dev/?utm_source=telegram&utm_medium=post&utm_campaign=launch
https://lina.mrfilldev.workers.dev/?utm_source=twitter&utm_medium=bio
https://lina.mrfilldev.workers.dev/daylight/?utm_source=reddit&utm_content=productivity
```

`utm_source/medium/campaign/content/term` and `ref` are read on load, attached to
every analytics event, and saved with the signup.

---

## Analytics events (into `window.dataLayer`)

| Event            | When                              | Extra fields                         |
|------------------|-----------------------------------|--------------------------------------|
| `ab_assign`      | splitter picks a variant          | `variant`, `forced`                  |
| `page_view`      | landing loads (new visitor)       | `variant`, `utm_*`                   |
| `return_view`    | landing loads, visitor already joined | `variant`, `utm_*`               |
| `signup_submit`  | form submitted (valid email)      | `variant`, `placement`, `utm_*`      |
| `signup_success` | API accepted a new signup         | `variant`, `placement`               |
| `signup_dedup`   | API saw the email already         | `variant`, `placement`               |
| `signup_error` / `signup_rate_limited` | request failed / 429    | `variant`, `placement`               |
| `lang_switch`    | RU/EN toggle used                 | `variant`, `lang`                    |

Split `page_view` from `return_view` so a returning subscriber sent to the *other*
variant doesn't count against that variant's conversion rate.

Nothing consumes `dataLayer` yet. Uncomment the `console.debug` line in each page
to watch events live.

---

## Fonts

Self-hosted under `public/fonts/` (no Google Fonts request, no visitor IP sent to
Google): **Lora** + **Manrope** + **JetBrains Mono**, `latin` + `cyrillic` subsets
only. Midnight = Lora display / Manrope body; Daylight mirrors it. `fonts.css`
declares the `@font-face` rules. Regenerate with `/tmp/getfonts.mjs` logic if the
family list changes.

Newsreader / Bricolage / Hanken (the originals) barely ship Cyrillic, so Russian
headings were silently falling back to system fonts — that's why they were swapped.

## Editing the OG images

`assets-src/og-midnight.svg` / `og-daylight.svg` are the sources. After editing:

```bash
rsvg-convert -w 1200 -h 630 assets-src/og-midnight.svg -o /tmp/m.png
sips -s format jpeg -s formatOptions 80 /tmp/m.png --out public/og-midnight.jpg
rsvg-convert -w 1200 -h 630 assets-src/og-daylight.svg -o public/og-daylight.png
```

(`brew install librsvg` for `rsvg-convert`; `sips` ships with macOS.) Same
`rsvg-convert` step for `public/favicon.svg` → `favicon-32.png` / `favicon-180.png`.

---

## Next steps

### Analytics

Worker → **Metrics / Observability** already shows requests by path (`/midnight`
vs `/daylight` volume) with zero setup.

For events, add a snippet in the `<!-- ANALYTICS -->` slot in the `<head>` of both
landings:

- **Cloudflare Web Analytics** — paste the beacon `<script>` with your token.
- **Plausible** — `<script defer data-domain="lina.mrfilldev.workers.dev" src="https://plausible.io/js/script.js"></script>`;
  the pages already call `window.plausible(event, {props})`, so `signup_success`
  etc. become custom events automatically.

### Still worth doing

- **Turnstile** for real abuse protection — create a widget in the Cloudflare
  dashboard (Turnstile → Add site), drop the `<script>` + `<div class="cf-turnstile">`
  in the form, verify the token server-side in `handleInterest`. The per-IP limit
  is only a soft guard.
- Server-side language (detect `Accept-Language` in the Worker, swap text + `<html lang>`)
  to kill the brief RU→EN flip for English visitors. Meta/OG already swap client-side.
- A price signal — this is a paid subscription; "would you pay" is the real question.
- A product visual (a fake chat exchange) to raise conviction for cold traffic.
