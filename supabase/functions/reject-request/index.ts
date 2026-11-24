// reject-request: markerer en brokerforespørsel som avvist (server-side).
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Bruk POST" }, 405);
  let request_id: string | undefined; let reason: string | undefined;
  try { ({ request_id, reason } = await req.json()); } catch { return json({ error: "Ugyldig JSON" }, 400); }
  if (!request_id) return json({ error: "Mangler request_id" }, 400);

  const res = await fetch(`${SUPABASE_URL}/rest/v1/requests?id=eq.${request_id}`, {
    method: "PATCH",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      status: "avvist",
      rejection_reason: reason || "Avvist etter gjennomgang.",
      reviewed_at: new Date().toISOString(),
    }),
  });
  if (!res.ok) return json({ error: `Supabase: ${res.status} ${await res.text()}` }, 500);
  const rows = await res.json();
  if (!rows?.length) return json({ error: "Fant ikke forespørselen" }, 404);
  return json({ ok: true, id: request_id });
});
