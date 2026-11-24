// set-category: flytt en forespørsel mellom "klar" og "mulig" (server-side),
// marker den som manuelt overstyrt, og lagre et merket eksempel til læring.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

function emailFromJwt(auth: string | null): string | null {
  try {
    const tok = (auth || "").replace(/^Bearer\s+/i, "");
    const payload = JSON.parse(atob(tok.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return payload.email || payload.user_metadata?.email || null;
  } catch { return null; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Bruk POST" }, 405);

  let request_id: string | undefined; let category: string | undefined;
  try { ({ request_id, category } = await req.json()); } catch { return json({ error: "Ugyldig JSON" }, 400); }
  if (!request_id) return json({ error: "Mangler request_id" }, 400);
  if (category !== "klar" && category !== "mulig") return json({ error: "category må være 'klar' eller 'mulig'" }, 400);

  const h = {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    "Content-Type": "application/json",
  };

  // Hent forespørselen for å snapshotte til læringseksempelet.
  const getRes = await fetch(
    `${SUPABASE_URL}/rest/v1/requests?id=eq.${request_id}&select=subject,body_text,from_email`,
    { headers: h },
  );
  if (!getRes.ok) return json({ error: `Supabase: ${getRes.status} ${await getRes.text()}` }, 500);
  const found = await getRes.json();
  if (!found?.length) return json({ error: "Fant ikke forespørselen" }, 404);
  const r = found[0];

  // Oppdater kategori + marker som manuelt overstyrt (scoring skal ikke overskrive).
  const upd = await fetch(`${SUPABASE_URL}/rest/v1/requests?id=eq.${request_id}`, {
    method: "PATCH",
    headers: { ...h, Prefer: "return=representation" },
    body: JSON.stringify({ category, category_overridden: true, updated_at: new Date().toISOString() }),
  });
  if (!upd.ok) return json({ error: `Supabase: ${upd.status} ${await upd.text()}` }, 500);
  const rows = await upd.json();
  if (!rows?.length) return json({ error: "Oppdatering feilet" }, 404);

  // Lagre merket eksempel (teamets korrigering) til few-shot-læring.
  await fetch(`${SUPABASE_URL}/rest/v1/category_feedback`, {
    method: "POST",
    headers: { ...h, Prefer: "return=minimal" },
    body: JSON.stringify({
      request_id,
      subject: r.subject ?? null,
      body_excerpt: (r.body_text ?? "").slice(0, 800) || null,
      from_email: r.from_email ?? null,
      category,
      created_by: emailFromJwt(req.headers.get("Authorization")),
    }),
  });

  return json({ ok: true, id: request_id, category });
});
