import webpush from "web-push";

const ALERT_THRESHOLD = 70;

function corsHeaders(env) {
  return {
    "access-control-allow-origin": env.APP_ORIGIN,
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type",
  };
}

function json(data, init = {}, env) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json", ...corsHeaders(env), ...init.headers },
  });
}

async function subscriptionKey(subscription) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(subscription.endpoint));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function scoreForecast(pressures, index) {
  const current = pressures[index];
  if (!Number.isFinite(current)) return 0;
  const at = (offset) => pressures[index + offset];
  const drop = (offset) => (Number.isFinite(at(offset)) ? Math.max(0, current - at(offset)) : 0);
  const futureTrend = Math.max(drop(3) * 18, drop(6) * 12, drop(12) * 8, drop(24) * 7);
  const lowPressureLoad = Math.max(0, 1008 - current) * 4;
  return Math.round(Math.min(100, 8 + futureTrend + lowPressureLoad));
}

async function fetchAlert(location) {
  const params = new URLSearchParams({
    latitude: location.latitude,
    longitude: location.longitude,
    hourly: "pressure_msl",
    timezone: "auto",
    forecast_days: "2",
  });
  const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
  if (!response.ok) throw new Error("forecast fetch failed");
  const data = await response.json();
  const now = Date.now();
  const index = Math.max(0, data.hourly.time.findIndex((time) => new Date(time).getTime() >= now));
  const scores = Array.from({ length: 13 }, (_, offset) => ({
    offset,
    score: scoreForecast(data.hourly.pressure_msl, index + offset),
    time: data.hourly.time[index + offset],
  }));
  return scores.find(({ score }) => score >= ALERT_THRESHOLD);
}

async function saveSubscription(request, env) {
  const body = await request.json();
  if (!body.subscription?.endpoint || !body.location) return json({ error: "invalid subscription" }, { status: 400 }, env);
  const key = await subscriptionKey(body.subscription);
  const existing = await env.SUBSCRIPTIONS.get(`subscription:${key}`, "json");
  await env.SUBSCRIPTIONS.put(
    `subscription:${key}`,
    JSON.stringify({
      ...body,
      intervalMinutes: Number(body.intervalMinutes) || 60,
      lastNotificationAt: existing?.lastNotificationAt || 0,
    }),
  );
  return json({ ok: true }, {}, env);
}

async function deleteSubscription(request, env) {
  const body = await request.json();
  if (!body.endpoint) return json({ error: "invalid endpoint" }, { status: 400 }, env);
  const key = await subscriptionKey({ endpoint: body.endpoint });
  await env.SUBSCRIPTIONS.delete(`subscription:${key}`);
  return json({ ok: true }, {}, env);
}

async function sendScheduledNotifications(env) {
  webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  let cursor;
  do {
    const page = await env.SUBSCRIPTIONS.list({ prefix: "subscription:", cursor });
    for (const key of page.keys) {
      const record = await env.SUBSCRIPTIONS.get(key.name, "json");
      try {
        const alert = await fetchAlert(record.location);
        const intervalMs = record.intervalMinutes * 60 * 1000;
        if (!alert || Date.now() - record.lastNotificationAt < intervalMs) continue;
        await webpush.sendNotification(
          record.subscription,
          JSON.stringify({
            title: "気圧ケア: バックグラウンド警告",
            body: `${alert.time}ごろの不調リスク参考指数は ${alert.score}。早めに休息を取りましょう。`,
          }),
        );
        record.lastNotificationAt = Date.now();
        await env.SUBSCRIPTIONS.put(key.name, JSON.stringify(record));
      } catch (error) {
        if ([404, 410].includes(error.statusCode)) await env.SUBSCRIPTIONS.delete(key.name);
        else console.error("push failed", error);
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders(env) });
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true }, {}, env);
    if (url.pathname === "/subscribe" && request.method === "POST") return saveSubscription(request, env);
    if (url.pathname === "/subscribe" && request.method === "DELETE") return deleteSubscription(request, env);
    return json({ error: "not found" }, { status: 404 }, env);
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(sendScheduledNotifications(env));
  },
};
