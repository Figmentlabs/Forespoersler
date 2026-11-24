// unqualify-request: avkvalifiserer en forespørsel – sletter dealen i Pipedrive
// og setter forespørselen tilbake til "ny".
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PD_TOKEN = Deno.env.get("PIPEDRIVE_API_TOKEN");
const PD_BASE = "https://api.pipedrive.com/v1";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
async function sb(path: string, init: RequestInit = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json", Prefer: "return=representation", ...(init.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`Supabase ${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Bruk POST" }, 405);

  let request_id: string | undefined;
  try { ({ request_id } = await req.json()); } catch { return json({ error: "Ugyldig JSON" }, 400); }
  if (!request_id) return json({ error: "Mangler request_id" }, 400);

  try {
    const rows = await sb(`requests?id=eq.${request_id}&select=pipedrive_deal_id`);
    const r = rows?.[0];
    if (!r) return json({ error: "Fant ikke forespørselen" }, 404);

    let dealDeleted = false;
    if (r.pipedrive_deal_id && PD_TOKEN) {
      try {
        const res = await fetch(`${PD_BASE}/deals/${r.pipedrive_deal_id}?api_token=${PD_TOKEN}`, { method: "DELETE" });
        dealDeleted = res.ok;
      } catch { /* deal kan allerede være borte */ }
    }

    await sb(`requests?id=eq.${request_id}`, {
      method: "PATCH",
      body: JSON.stringify({
        status: "ny",
        pipedrive_deal_id: null,
        reviewed_at: null,
        rejection_reason: null,
      }),
    });

    return json({ ok: true, id: request_id, deal_deleted: dealDeleted });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
