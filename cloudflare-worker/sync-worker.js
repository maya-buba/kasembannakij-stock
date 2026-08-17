// Kasembannakij Stock — sync backend.
//
// Deploy: Cloudflare dashboard -> Workers & Pages -> Create -> paste this file in, deploy.
// Needs no CLI and no local setup. See ../README.md "Cloud sync" section for the full
// step-by-step (KV namespace, binding, secret, CORS origin).
//
// Contract:
//   GET  /data   -> current stored state (or an empty skeleton if nothing saved yet)
//   PUT  /data   -> body: { data: {...}, baseUpdatedAt: number }
//                   saves `data` with a fresh `updatedAt`, UNLESS someone else's save
//                   already moved `updatedAt` past `baseUpdatedAt` — then responds 409
//                   with the current server copy so the client can re-sync before retrying.
//   Every request needs `Authorization: Bearer <SYNC_TOKEN>` matching the Worker secret.

const EMPTY_STATE = {
  books: [], sales: [], locations: [], settings: { lowStockThreshold: 3 },
  expenses: [], expenseCategories: [], updatedAt: 0,
};

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}
function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

export default {
  async fetch(request, env) {
    const origin = env.ALLOWED_ORIGIN || "*";
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(origin) });
    }

    const authHeader = request.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!env.SYNC_TOKEN || token !== env.SYNC_TOKEN) {
      return json({ error: "unauthorized" }, 401, origin);
    }

    if (url.pathname !== "/data") {
      return json({ error: "not found" }, 404, origin);
    }

    if (request.method === "GET") {
      const raw = await env.kasembannakij_kv.get("state");
      return json(raw ? JSON.parse(raw) : EMPTY_STATE, 200, origin);
    }

    if (request.method === "PUT") {
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return json({ error: "bad json" }, 400, origin);
      }
      if (!body || typeof body !== "object" || !body.data) {
        return json({ error: "expected { data, baseUpdatedAt }" }, 400, origin);
      }

      const raw = await env.kasembannakij_kv.get("state");
      const existing = raw ? JSON.parse(raw) : EMPTY_STATE;
      const baseUpdatedAt = Number(body.baseUpdatedAt) || 0;

      if (existing.updatedAt && existing.updatedAt > baseUpdatedAt) {
        return json({ error: "conflict", server: existing }, 409, origin);
      }

      const toStore = { ...body.data, updatedAt: Date.now() };
      await env.kasembannakij_kv.put("state", JSON.stringify(toStore));
      return json({ ok: true, updatedAt: toStore.updatedAt }, 200, origin);
    }

    return json({ error: "method not allowed" }, 405, origin);
  },
};
