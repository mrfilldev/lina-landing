/**
 * Lina — static site + signup API + Telegram alerts, one Worker.
 *
 *   POST /api/interest         { email, variant, lang, utm }   -> store a lead, ping Telegram
 *   GET  /api/export           Authorization: Bearer <EXPORT_TOKEN>   -> JSON dump of all leads
 *   GET  /api/report?dry=1     Authorization: Bearer <EXPORT_TOKEN>   -> preview the daily report
 *   POST /api/report           Authorization: Bearer <EXPORT_TOKEN>   -> send the report now
 *   GET  /api/send             Authorization: Bearer <EXPORT_TOKEN>   -> target channel info (for /send/)
 *   POST /api/send             Authorization: Bearer <EXPORT_TOKEN>   -> post as the bot
 *                              JSON {text,mode,preview,silent}  OR  multipart {photo,text/caption,mode,silent}
 *   (cron 0 9 * * *)           -> send the daily report to Telegram (12:00 MSK)
 *   everything else            -> static assets from ./public
 *
 * Secrets:  EXPORT_TOKEN, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 * Vars:     INSTANT_ALERTS = "off"  disables the per-signup ping (daily report stays)
 *
 * Leads are stored with the summary in the KV key's *metadata*, so reads for the
 * report / export / counts come from list() alone — no per-key GET, no subrequest cap.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "ref"];
const LAST_REPORT_KEY = "meta:last_report";
const MAX_BODY = 4096;
const RL_HOUR = 8;   // signups per IP per hour
const RL_DAY = 20;   // signups per IP per day
const PING_HOUR_CAP = 15; // instant pings per hour before it goes quiet
const SEND_CAP = 30; // /api/send messages per 10-minute window (safety net if the token leaks)
const TG_TEXT_MAX = 4096;
const TG_CAPTION_MAX = 1024;
const PHOTO_MAX = 10 * 1024 * 1024; // Telegram sendPhoto ceiling
const MODES = { plain: null, html: "HTML", markdown: "MarkdownV2" };

// Static assets are served straight from the edge (not through this Worker), so
// their headers come from public/_headers. These apply to the /api/* responses.
const SEC_HEADERS = {
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "x-frame-options": "SAMEORIGIN",
  "referrer-policy": "strict-origin-when-cross-origin",
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/interest") return await handleInterest(request, env, ctx);
    if (url.pathname === "/api/export") return await handleExport(request, env);
    if (url.pathname === "/api/report") return await handleReport(request, url, env);
    if (url.pathname === "/api/send") return await handleSend(request, env);
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendReport(env, { since: "marker" }));
  },
};

/* ---------------- response helpers ---------------- */

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
      ...SEC_HEADERS,
      ...extra,
    },
  });
}

function bearer(request, env) {
  if (!env.EXPORT_TOKEN) return false;
  const h = request.headers.get("authorization") || "";
  return h.startsWith("Bearer ") && h.slice(7) === env.EXPORT_TOKEN;
}

function sanitizeUtm(raw) {
  const out = {};
  if (raw && typeof raw === "object") {
    for (const k of UTM_KEYS) if (raw[k] != null) out[k] = String(raw[k]).slice(0, 120);
  }
  return out;
}

/* Read every lead from list() metadata — one subrequest per 1000 keys, no GETs. */
async function listLeads(env) {
  const leads = [];
  let cursor;
  do {
    const page = await env.LEADS.list({ prefix: "lead:", cursor, limit: 1000 });
    for (const key of page.keys) if (key.metadata) leads.push(key.metadata);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  leads.sort((a, b) => (a.ts < b.ts ? 1 : -1));
  return leads;
}

/* ---------------- /api/interest ---------------- */

async function handleInterest(request, env, ctx) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "86400",
      },
    });
  }
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  const clen = Number(request.headers.get("content-length") || 0);
  if (clen > MAX_BODY) return json({ ok: false, error: "payload_too_large" }, 413);

  let body;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY) return json({ ok: false, error: "payload_too_large" }, 413);
    body = JSON.parse(text);
  } catch {
    return json({ ok: false, error: "bad_json" }, 400);
  }

  // Honeypot — bots fill hidden fields. Pretend success, store nothing.
  if (body.company) return json({ ok: true });

  const email = String(body.email || "").trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 200) {
    return json({ ok: false, error: "invalid_email" }, 422);
  }

  const ip = request.headers.get("cf-connecting-ip") || "0.0.0.0";
  const limited = await rateLimit(env, ip);
  if (limited) return json({ ok: false, error: "rate_limited" }, 429);

  const emailKey = "email:" + email;
  if (await env.LEADS.get(emailKey)) return json({ ok: true, dedup: true });

  const ts = new Date().toISOString();
  const meta = {
    email,
    variant: String(body.variant || "").slice(0, 20),
    lang: String(body.lang || "").slice(0, 5),
    utm: sanitizeUtm(body.utm),
    country: request.cf?.country || request.headers.get("cf-ipcountry") || "",
    referer: (request.headers.get("referer") || "").slice(0, 160),
    ts,
  };
  const full = { ...meta, ua: (request.headers.get("user-agent") || "").slice(0, 300) };

  await env.LEADS.put(emailKey, ts);
  await env.LEADS.put("lead:" + ts + ":" + crypto.randomUUID().slice(0, 8), JSON.stringify(full), { metadata: meta });

  console.log("lead", JSON.stringify(meta));

  if (ctx && env.INSTANT_ALERTS !== "off") {
    ctx.waitUntil(
      notifyNewLead(env, meta)
        .then((r) => console.log("notify", r && r.ok ? (r.quiet ? "quiet" : "sent") : JSON.stringify(r)))
        .catch((e) => console.log("notify failed", String(e)))
    );
  }

  return json({ ok: true });
}

/* Best-effort per-IP throttle in one KV key. KV is eventually consistent, so a
   burst can slip a few extra through — fine for a waitlist, far better than none. */
async function rateLimit(env, ip) {
  const now = Date.now();
  const key = "rl:" + ip;
  let rec;
  try { rec = JSON.parse((await env.LEADS.get(key)) || "null"); } catch { rec = null; }
  rec = rec || {};
  if (!rec.h || now > rec.h.resetAt) rec.h = { n: 0, resetAt: now + 3600e3 };
  if (!rec.d || now > rec.d.resetAt) rec.d = { n: 0, resetAt: now + 86400e3 };
  rec.h.n++;
  rec.d.n++;
  await env.LEADS.put(key, JSON.stringify(rec), { expirationTtl: 86400 + 120 });
  return rec.h.n > RL_HOUR || rec.d.n > RL_DAY;
}

async function notifyNewLead(env, r) {
  const total = (await listLeads(env)).length;
  const bucket = "meta:pings:" + new Date().toISOString().slice(0, 13);
  let pings = (parseInt(await env.LEADS.get(bucket), 10) || 0) + 1;
  await env.LEADS.put(bucket, String(pings), { expirationTtl: 7200 });

  if (pings > PING_HOUR_CAP) {
    if (pings === PING_HOUR_CAP + 1) {
      await telegramSend(env, "🤫 Тихий режим: заявок много, отдельные пинги на паузе до конца часа. Итог будет в суточной сводке.");
    }
    return { ok: true, quiet: true };
  }

  const source = (r.utm && r.utm.utm_source) || "прямой заход";
  const loc = r.country ? " · " + flag(r.country) + " " + r.country : "";
  const text =
    `🟢 <b>Новая заявка</b> — ${esc(r.variant || "?")}\n` +
    `${esc(r.email)}\n` +
    `${esc(source)}${loc}\n` +
    `Всего в списке: <b>${total}</b>`;
  return telegramSend(env, text);
}

/* ---------------- /api/export ---------------- */

async function handleExport(request, env) {
  if (!bearer(request, env)) return json({ ok: false, error: "unauthorized" }, 401);

  const leads = await listLeads(env);
  const byVariant = {};
  for (const l of leads) byVariant[l.variant || "?"] = (byVariant[l.variant || "?"] || 0) + 1;
  return json({ ok: true, count: leads.length, by_variant: byVariant, leads });
}

/* ---------------- daily report ---------------- */

async function handleReport(request, url, env) {
  if (!bearer(request, env)) return json({ ok: false, error: "unauthorized" }, 401);

  if (request.method === "POST") {
    const result = await sendReport(env, { since: "24h" });
    return json(result, result.ok ? 200 : 502);
  }
  const { text, stats } = await buildReport(env, { since: "24h" });
  return json({ ok: true, dry_run: true, stats, text });
}

async function buildReport(env, opts) {
  const leads = await listLeads(env);
  const now = Date.now();

  let sinceTs = now - 24 * 3600e3;
  if (opts.since === "marker") {
    const marker = await env.LEADS.get(LAST_REPORT_KEY);
    const parsed = marker ? Date.parse(marker) : NaN;
    if (!Number.isNaN(parsed)) {
      sinceTs = Math.min(Math.max(parsed, now - 8 * 86400e3), now - 3600e3);
    }
  }

  const fresh = leads.filter((l) => Date.parse(l.ts) >= sinceTs);
  const tally = (list) => {
    const t = {};
    for (const l of list) t[l.variant || "?"] = (t[l.variant || "?"] || 0) + 1;
    return t;
  };
  const total = tally(leads);
  const recent = tally(fresh);

  const sources = {};
  for (const l of fresh) {
    const s = (l.utm && l.utm.utm_source) || "direct";
    sources[s] = (sources[s] || 0) + 1;
  }
  const topSources = Object.entries(sources)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([s, n]) => `${esc(s)} ${n}`)
    .join(" · ");

  const pct = (n) => (leads.length ? Math.round((n / leads.length) * 100) : 0);
  const variantLine = (t) =>
    ["midnight", "daylight"]
      .map((v) => `${v} ${t[v] || 0}`)
      .concat(Object.keys(t).filter((k) => k !== "midnight" && k !== "daylight").map((k) => `${esc(k)} ${t[k]}`))
      .join(" · ");
  const totalLine = ["midnight", "daylight"].map((v) => `${v} ${total[v] || 0} (${pct(total[v] || 0)}%)`).join(" · ");

  const hours = Math.max(1, Math.round((now - sinceTs) / 3600e3));
  const windowLabel = hours >= 20 && hours <= 28 ? "за сутки" : `за ${hours} ч`;

  const lines = [
    "<b>Lina · сводка</b>",
    `<i>${fmtMoscow(now)}</i>`,
    "",
    `<b>Новых ${windowLabel}: ${fresh.length}</b>`,
  ];
  if (fresh.length) lines.push(variantLine(recent));
  lines.push("", `<b>Всего в списке: ${leads.length}</b>`);
  if (leads.length) lines.push(totalLine);
  if (topSources) lines.push("", `Источники ${windowLabel}:`, topSources);

  return {
    text: lines.join("\n"),
    stats: { total: leads.length, by_variant_total: total, fresh: fresh.length, by_variant_fresh: recent, sources, since: new Date(sinceTs).toISOString() },
  };
}

async function sendReport(env, opts) {
  const { text, stats } = await buildReport(env, opts);
  const res = await telegramSend(env, text);
  if (!res.ok) return { ...res, text };

  await env.LEADS.put(LAST_REPORT_KEY, new Date().toISOString());
  console.log("report sent", JSON.stringify(stats));
  return { ok: true, stats, text };
}

/* opts: { parseMode: "HTML"(default) | "MarkdownV2" | null, linkPreview: false(default), silent: false } */
async function telegramSend(env, text, opts) {
  opts = opts || {};
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.log("telegram skipped: TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set");
    return { ok: false, error: "telegram_not_configured" };
  }
  const payload = {
    chat_id: chatId,
    text,
    disable_web_page_preview: !opts.linkPreview,
    disable_notification: !!opts.silent,
  };
  const pm = opts.parseMode === undefined ? "HTML" : opts.parseMode;
  if (pm) payload.parse_mode = pm;

  const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const tg = await resp.json().catch(() => ({}));
  if (!resp.ok || !tg.ok) {
    console.log("telegram send failed", resp.status, JSON.stringify(tg));
    return { ok: false, error: "telegram_error", status: resp.status, telegram: tg };
  }
  return { ok: true, message_id: tg.result && tg.result.message_id };
}

/* ---------------- /api/send — post as the bot (personal admin tool) ---------------- */

async function handleSend(request, env) {
  if (!bearer(request, env)) return json({ ok: false, error: "unauthorized" }, 401);

  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return json({ ok: false, error: "telegram_not_configured" }, 503);

  if (request.method === "GET") {
    const resp = await fetch(`https://api.telegram.org/bot${token}/getChat?chat_id=${encodeURIComponent(chatId)}`);
    const tg = await resp.json().catch(() => ({}));
    if (!tg.ok) return json({ ok: false, error: "telegram_error", telegram: tg }, 502);
    const c = tg.result || {};
    return json({ ok: true, chat: { id: c.id, title: c.title || c.username || String(c.id), type: c.type, username: c.username || null } });
  }

  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  const ct = request.headers.get("content-type") || "";
  const multipart = ct.startsWith("multipart/form-data");

  let text, mode, silent, preview, photo;
  if (multipart) {
    let form;
    try { form = await request.formData(); } catch { return json({ ok: false, error: "bad_form" }, 400); }
    text = String(form.get("text") || form.get("caption") || "").replace(/\r\n/g, "\n").trimEnd();
    mode = form.get("mode");
    silent = form.get("silent") === "true" || form.get("silent") === "1";
    preview = form.get("preview") === "true" || form.get("preview") === "1";
    photo = form.get("photo");
    if (photo && typeof photo === "string") photo = null; // not a file
  } else {
    let body;
    try { body = await request.json(); } catch { return json({ ok: false, error: "bad_json" }, 400); }
    text = String(body.text || "").replace(/\r\n/g, "\n").trimEnd();
    mode = body.mode;
    silent = !!body.silent;
    preview = !!body.preview;
  }

  const parseMode = Object.prototype.hasOwnProperty.call(MODES, mode) ? MODES[mode] : "HTML";

  if (photo) {
    if (typeof photo.size === "number" && photo.size > PHOTO_MAX) {
      return json({ ok: false, error: "photo_too_large", limit: PHOTO_MAX }, 413);
    }
    if (photo.type && !photo.type.startsWith("image/")) {
      return json({ ok: false, error: "not_an_image" }, 422);
    }
    if (text.length > TG_CAPTION_MAX) {
      return json({ ok: false, error: "caption_too_long", limit: TG_CAPTION_MAX }, 413);
    }
  } else {
    if (!text.trim()) return json({ ok: false, error: "empty" }, 422);
    if (text.length > TG_TEXT_MAX) return json({ ok: false, error: "too_long", limit: TG_TEXT_MAX }, 413);
  }

  // Safety net: cap sends even for a valid token, in case it ever leaks.
  const bucket = "meta:send:" + Math.floor(Date.now() / 600000);
  const n = (parseInt(await env.LEADS.get(bucket), 10) || 0) + 1;
  await env.LEADS.put(bucket, String(n), { expirationTtl: 1200 });
  if (n > SEND_CAP) return json({ ok: false, error: "rate_limited" }, 429);

  const res = photo
    ? await telegramSendPhoto(env, photo, text, { parseMode, silent })
    : await telegramSend(env, text, { parseMode, linkPreview: preview, silent });

  if (res.ok) console.log("send", JSON.stringify({ message_id: res.message_id, kind: photo ? "photo" : "text", mode: mode || "html" }));
  return json(res, res.ok ? 200 : 502);
}

async function telegramSendPhoto(env, file, caption, opts) {
  opts = opts || {};
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return { ok: false, error: "telegram_not_configured" };

  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("photo", file, file.name || "photo.jpg");
  if (caption) form.append("caption", caption);
  if (opts.parseMode) form.append("parse_mode", opts.parseMode);
  if (opts.silent) form.append("disable_notification", "true");

  const resp = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: "POST", body: form });
  const tg = await resp.json().catch(() => ({}));
  if (!resp.ok || !tg.ok) {
    console.log("telegram sendPhoto failed", resp.status, JSON.stringify(tg));
    return { ok: false, error: "telegram_error", status: resp.status, telegram: tg };
  }
  return { ok: true, message_id: tg.result && tg.result.message_id };
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function flag(cc) {
  if (!/^[A-Za-z]{2}$/.test(cc)) return "";
  return String.fromCodePoint(...[...cc.toUpperCase()].map((c) => 127397 + c.charCodeAt(0)));
}

function fmtMoscow(ms) {
  const d = new Date(ms + 3 * 3600e3); // MSK = fixed UTC+3, no DST
  const months = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]}, ${hh}:${mm} МСК`;
}
