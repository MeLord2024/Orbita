// Orbita · Supabase Edge Function «orbita» — общий сервер для расширения.
//
// Как выложить (без CLI):
//   Dashboard → Edge Functions → «Deploy new function» → Name: orbita →
//   выбрать шаблон «Hello World» → очистить редактор → вставить ЭТОТ файл целиком →
//   Deploy → (если спрашивает) «Create a version».
//   Затем на вкладке функции выключить «Configure URL authorization» / Verify JWT —
//   иначе запросы из расширения получат 401 (у нас авторизации нет намеренно:
//   анонимный чат, лимиты держатся на IP + канале в Postgres).
//
// Ключи никуда вписывать не нужно: SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY Supabase
// выдаёт каждой Edge Function сам. В расширение не попадает ни один ключ — клиент
// ходит только по https://<ref>.supabase.co/functions/v1/<slug>/api/...
// Важно: <slug> Supabase берёт из колонки URL в списке функций, а не из имени. При
// имени «orbita» slug может быть случайным (например «smooth-handler»).
//
// Контракт совпадает с локальным прототипом server/server.js, поэтому в расширении
// достаточно вписать URL в «Сервер синхронизации».
//
// Зависимостей нет намеренно: только fetch к PostgREST, никаких npm-импортов.

const BASE = Deno.env.get("SUPABASE_URL") ?? "";
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

// те же лимиты, что в клиенте (store.js): 5 сообщений за 20 секунд
const RATE_WINDOW_MS = 20_000;
const RATE_MAX = 5;
const KEEP_DAYS = 30;

let lastPrune = 0;

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-max-age": "86400",
};

function send(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS },
  });
}

async function rpc(fn: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: KEY, authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${fn}: ${res.status} ${text}`);
  const data = JSON.parse(text);
  return (Array.isArray(data) ? data[0] : data) ?? {};
}

const asText = (v: unknown): string => (typeof v === "string" ? v : "");
const asList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, 5000) : [];

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const path = url.pathname;

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (!BASE || !KEY) return send({ error: "not_configured" }, 500);

  // раз в 6 часов кто-нибудь из запросов чистит хвосты (у бесплатного тарифа cron не вечен)
  if (Date.now() - lastPrune > 6 * 3600_000) {
    lastPrune = Date.now();
    rpc("orb_prune", { p_keep_days: KEEP_DAYS }).catch(() => {});
  }

  try {
    if (path === "/" || path.endsWith("/")) {
      const h = await rpc("orb_health", {});
      return new Response(
        `Orbita sync server\nmessages: ${h.messages}\nonline: ${h.clients}\n`,
        { headers: { ...CORS, "content-type": "text/plain; charset=utf-8" } }
      );
    }

    if (path.endsWith("/api/health")) return send(await rpc("orb_health", {}));

    if (path.endsWith("/api/pull")) {
      // Math.floor, а не |0: since — миллисекунды, и 32-битное усечение превратило бы
      // «1.76e12» в «4e8», то есть в 1970 год, и pull всякий раз тащил бы всё заново.
      return send(
        await rpc("orb_pull", {
          p_since: Math.floor(Number(url.searchParams.get("since") || 0)) || 0,
          p_lang: url.searchParams.get("lang") ?? null,
          p_chan: url.searchParams.get("channel") ?? null,
        })
      );
    }

    if (path.endsWith("/api/presence") && req.method === "POST") {
      const body = await req.json();
      const client = asText(body.id);
      const pageUrl = asText(body.url);
      const lang = asText(body.lang);
      if (!client || !pageUrl || !lang) return send({ error: "bad_presence" }, 400);
      return send(await rpc("orb_presence", { p_client: client.slice(0, 120), p_url: pageUrl.slice(0, 500), p_lang: lang.slice(0, 8) }));
    }

    if (path.endsWith("/api/push") && req.method === "POST") {
      const body = await req.json();
      const msg = (body && body.message) || {};
      const id = asText(msg.id);
      const pageUrl = asText(msg.url);
      const lang = asText(msg.lang);
      const text = asText(msg.text);
      if (!id || !pageUrl || !lang || !text.trim()) return send({ error: "bad_message" }, 400);

      const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "no-ip";
      const ch = asText(msg.ch) || `${pageUrl}#${lang}`;
      const out = await rpc("orb_push", {
        p_bucket: `${ip}|${ch}`.slice(0, 400),
        p_max: RATE_MAX,
        p_window: RATE_WINDOW_MS,
        p: {
          id: id.slice(0, 64),
          ch: ch.slice(0, 600),
          url: pageUrl.slice(0, 500),
          lang: lang.slice(0, 8),
          ts: Number(msg.ts) || Date.now(),
          author: msg.author ?? {},
          text: text.slice(0, 2000),
          links: Array.isArray(msg.links) ? msg.links.slice(0, 4) : [],
          up: asList(msg.up),
          down: asList(msg.down),
          stars: asList(msg.stars),
          reports: asList(msg.reports),
          effect: msg.effect ?? null,
          quote: asText(msg.quote).slice(0, 500),
        },
      });
      return send(out, out.error === "rate_limited" ? 429 : 200);
    }

    if (path.endsWith("/api/patch") && req.method === "POST") {
      const body = await req.json();
      const msgId = asText(body.msgId);
      if (!msgId) return send({ error: "bad_request" }, 400);
      const patch: Record<string, unknown> = {};
      for (const field of ["up", "down", "stars", "reports"]) if (Array.isArray(body[field])) patch[field] = asList(body[field]);
      // снятый alias: union его не убирает, поэтому он уезжает отдельным списком rm
      const src = body.rm && typeof body.rm === "object" ? body.rm : {};
      const rm: Record<string, string[]> = {};
      for (const field of ["up", "down", "stars", "reports"]) if (Array.isArray(src[field])) rm[field] = asList(src[field]);
      if (Object.keys(rm).length) patch.rm = rm;
      if (body.effect) patch.effect = body.effect;
      const out = await rpc("orb_patch", { p_id: msgId.slice(0, 64), p: patch });
      return send(out, out.error === "not_found" ? 404 : 200);
    }

    if (path.endsWith("/api/delete") && req.method === "POST") {
      const body = await req.json();
      const msgId = asText(body.msgId);
      const by = asText(body.by);
      if (!msgId || !by) return send({ error: "bad_request" }, 400);
      const out = await rpc("orb_delete", { p_id: msgId.slice(0, 64), p_by: by.slice(0, 64) });
      return send(out, out.error === "not_mine" ? 403 : 200);
    }

    return send({ error: "not_found", path }, 404);
  } catch (err) {
    return send({ error: "server_error", detail: String(err && (err as Error).message) }, 500);
  }
});
