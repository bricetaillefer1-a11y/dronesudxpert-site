// DroneSudXpert — "Récupérer mon dossier"
// Stores client job reports/photos in R2, gated by a one-time code, auto-deleted
// after a configurable number of days (default 10). See ../README.md.

const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L — avoids confusion
const DEFAULT_DAYS = 10;

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGIN || "").split(",").map(s => s.trim()).filter(Boolean);
  const allowOrigin = allowed.includes(origin) ? origin : (allowed[0] || "*");
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,X-Admin-Password,X-Filename",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function json(data, status, extraHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

function generateCode() {
  let part = (len) => {
    let s = "";
    const bytes = crypto.getRandomValues(new Uint8Array(len));
    for (let i = 0; i < len; i++) s += CODE_CHARS[bytes[i] % CODE_CHARS.length];
    return s;
  };
  return `${part(4)}-${part(4)}`;
}

function requireAdmin(request, env) {
  const given = request.headers.get("X-Admin-Password") || "";
  if (!env.ADMIN_PASSWORD || given !== env.ADMIN_PASSWORD) return false;
  return true;
}

function sanitizeFilename(name) {
  const stripped = (name || "fichier").normalize("NFD").replace(/[̀-ͯ]/g, "");
  return stripped.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 150);
}

async function getDossier(env, code) {
  const raw = await env.DOSSIERS_KV.get(`dossier:${code}`);
  if (!raw) return null;
  const d = JSON.parse(raw);
  if (Date.now() > d.expiresAt) return null;
  return d;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const cors = corsHeaders(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      // --- Admin: create a new dossier, returns a fresh code ---
      if (path === "/api/admin/create" && request.method === "POST") {
        if (!requireAdmin(request, env)) return json({ error: "unauthorized" }, 401, cors);
        const body = await request.json().catch(() => ({}));
        const clientName = (body.clientName || "Client").slice(0, 200);
        const days = Math.min(Math.max(parseInt(body.days, 10) || DEFAULT_DAYS, 1), 60);

        let code;
        for (let i = 0; i < 5; i++) {
          code = generateCode();
          const exists = await env.DOSSIERS_KV.get(`dossier:${code}`);
          if (!exists) break;
        }

        const dossier = {
          code,
          clientName,
          createdAt: Date.now(),
          expiresAt: Date.now() + days * 24 * 60 * 60 * 1000,
          files: [],
        };
        await env.DOSSIERS_KV.put(`dossier:${code}`, JSON.stringify(dossier));
        return json({ code, expiresAt: dossier.expiresAt }, 200, cors);
      }

      // --- Admin: upload one file into an existing dossier ---
      // POST /api/admin/upload/:code   body = raw file bytes, header X-Filename
      const uploadMatch = path.match(/^\/api\/admin\/upload\/([A-Z0-9-]+)$/);
      if (uploadMatch && request.method === "POST") {
        if (!requireAdmin(request, env)) return json({ error: "unauthorized" }, 401, cors);
        const code = uploadMatch[1];
        const raw = await env.DOSSIERS_KV.get(`dossier:${code}`);
        if (!raw) return json({ error: "dossier introuvable" }, 404, cors);
        const dossier = JSON.parse(raw);

        const filename = sanitizeFilename(request.headers.get("X-Filename"));
        const key = `${code}/${filename}`;
        const contentType = request.headers.get("Content-Type") || "application/octet-stream";
        await env.DOSSIERS_BUCKET.put(key, request.body, {
          httpMetadata: { contentType },
        });

        const size = parseInt(request.headers.get("Content-Length") || "0", 10);
        dossier.files = dossier.files.filter(f => f.name !== filename);
        dossier.files.push({ name: filename, size, contentType });
        await env.DOSSIERS_KV.put(`dossier:${code}`, JSON.stringify(dossier));

        return json({ ok: true, files: dossier.files }, 200, cors);
      }

      // --- Admin: list all non-expired dossiers ---
      if (path === "/api/admin/list" && request.method === "GET") {
        if (!requireAdmin(request, env)) return json({ error: "unauthorized" }, 401, cors);
        const list = await env.DOSSIERS_KV.list({ prefix: "dossier:" });
        const now = Date.now();
        const dossiers = [];
        for (const key of list.keys) {
          const raw = await env.DOSSIERS_KV.get(key.name);
          if (!raw) continue;
          const d = JSON.parse(raw);
          if (d.expiresAt < now) continue;
          dossiers.push(d);
        }
        dossiers.sort((a, b) => b.createdAt - a.createdAt);
        return json({ dossiers }, 200, cors);
      }

      // --- Admin: delete a single file from a dossier ---
      const fileDeleteMatch = path.match(/^\/api\/admin\/file\/([A-Z0-9-]+)\/(.+)$/);
      if (fileDeleteMatch && request.method === "DELETE") {
        if (!requireAdmin(request, env)) return json({ error: "unauthorized" }, 401, cors);
        const code = fileDeleteMatch[1];
        const filename = decodeURIComponent(fileDeleteMatch[2]);
        const raw = await env.DOSSIERS_KV.get(`dossier:${code}`);
        if (!raw) return json({ error: "dossier introuvable" }, 404, cors);
        const dossier = JSON.parse(raw);

        await env.DOSSIERS_BUCKET.delete(`${code}/${filename}`);
        dossier.files = dossier.files.filter(f => f.name !== filename);
        await env.DOSSIERS_KV.put(`dossier:${code}`, JSON.stringify(dossier));

        return json({ ok: true, files: dossier.files }, 200, cors);
      }

      // --- Admin: rename a file within a dossier ---
      const renameMatch = path.match(/^\/api\/admin\/rename\/([A-Z0-9-]+)$/);
      if (renameMatch && request.method === "POST") {
        if (!requireAdmin(request, env)) return json({ error: "unauthorized" }, 401, cors);
        const code = renameMatch[1];
        const body = await request.json().catch(() => ({}));
        const oldName = body.oldName;
        const newName = sanitizeFilename(body.newName);
        if (!oldName || !newName) return json({ error: "missing_name" }, 400, cors);

        const raw = await env.DOSSIERS_KV.get(`dossier:${code}`);
        if (!raw) return json({ error: "dossier introuvable" }, 404, cors);
        const dossier = JSON.parse(raw);
        const fileEntry = dossier.files.find(f => f.name === oldName);
        if (!fileEntry) return json({ error: "file_not_found" }, 404, cors);

        if (newName !== oldName) {
          if (dossier.files.some(f => f.name === newName)) {
            return json({ error: "name_taken" }, 409, cors);
          }
          const obj = await env.DOSSIERS_BUCKET.get(`${code}/${oldName}`);
          if (!obj) return json({ error: "file_not_found" }, 404, cors);
          await env.DOSSIERS_BUCKET.put(`${code}/${newName}`, obj.body, {
            httpMetadata: obj.httpMetadata,
          });
          await env.DOSSIERS_BUCKET.delete(`${code}/${oldName}`);
          fileEntry.name = newName;
          await env.DOSSIERS_KV.put(`dossier:${code}`, JSON.stringify(dossier));
        }

        return json({ ok: true, files: dossier.files }, 200, cors);
      }

      // --- Admin: delete a dossier early ---
      const deleteMatch = path.match(/^\/api\/admin\/delete\/([A-Z0-9-]+)$/);
      if (deleteMatch && request.method === "DELETE") {
        if (!requireAdmin(request, env)) return json({ error: "unauthorized" }, 401, cors);
        const code = deleteMatch[1];
        await deleteDossier(env, code);
        return json({ ok: true }, 200, cors);
      }

      // --- Public: look up a dossier by code ---
      const lookupMatch = path.match(/^\/api\/dossier\/([A-Z0-9-]+)$/);
      if (lookupMatch && request.method === "GET") {
        const code = lookupMatch[1].toUpperCase();
        const dossier = await getDossier(env, code);
        if (!dossier) return json({ error: "not_found" }, 404, cors);
        if (!dossier.firstViewedAt) {
          dossier.firstViewedAt = Date.now();
          await env.DOSSIERS_KV.put(`dossier:${code}`, JSON.stringify(dossier));
        }
        return json({
          clientName: dossier.clientName,
          createdAt: dossier.createdAt,
          expiresAt: dossier.expiresAt,
          files: dossier.files,
        }, 200, cors);
      }

      // --- Public: download one file from a dossier ---
      const fileMatch = path.match(/^\/api\/dossier\/([A-Z0-9-]+)\/file\/(.+)$/);
      if (fileMatch && request.method === "GET") {
        const code = fileMatch[1].toUpperCase();
        const filename = decodeURIComponent(fileMatch[2]);
        const dossier = await getDossier(env, code);
        if (!dossier) return json({ error: "not_found" }, 404, cors);
        const obj = await env.DOSSIERS_BUCKET.get(`${code}/${filename}`);
        if (!obj) return json({ error: "file_not_found" }, 404, cors);
        const headers = new Headers(cors);
        headers.set("Content-Type", obj.httpMetadata?.contentType || "application/octet-stream");
        // ?dl=1 forces a save-to-device; otherwise the browser is free to display it inline (Visualiser).
        const disposition = url.searchParams.get("dl") === "1" ? "attachment" : "inline";
        headers.set("Content-Disposition", `${disposition}; filename="${filename}"`);
        return new Response(obj.body, { headers });
      }

      return json({ error: "not_found" }, 404, cors);
    } catch (err) {
      return json({ error: "server_error", message: String(err) }, 500, cors);
    }
  },

  // Runs on the cron schedule defined in wrangler.toml — deletes expired dossiers.
  async scheduled(event, env, ctx) {
    const list = await env.DOSSIERS_KV.list({ prefix: "dossier:" });
    const now = Date.now();
    for (const key of list.keys) {
      const raw = await env.DOSSIERS_KV.get(key.name);
      if (!raw) continue;
      const d = JSON.parse(raw);
      if (d.expiresAt < now) {
        await deleteDossier(env, d.code);
      }
    }
  },
};

async function deleteDossier(env, code) {
  const listed = await env.DOSSIERS_BUCKET.list({ prefix: `${code}/` });
  for (const obj of listed.objects) {
    await env.DOSSIERS_BUCKET.delete(obj.key);
  }
  await env.DOSSIERS_KV.delete(`dossier:${code}`);
}
