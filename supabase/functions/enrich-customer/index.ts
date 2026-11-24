// enrich-customer: beregner kunde-aktivitetsscore (0–100) mot Pipedrive.
//   0   = ukjent kunde / ikke funnet
//   50  = tidligere oppdrag (eldre vunne deals, ingen pågående)
//   80  = ett pågående oppdrag (nylig vunnet / sluttdato i framtiden)
//   100 = mer enn ett pågående oppdrag
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PD_TOKEN = Deno.env.get("PIPEDRIVE_API_TOKEN");
const PD_BASE = "https://api.pipedrive.com/v1";
const ONGOING_MONTHS = 12; // vunnet nyere enn dette (uten sluttdato) = pågående

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
async function pd(path: string) {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${PD_BASE}/${path}${sep}api_token=${PD_TOKEN}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body?.success === false) {
    throw new Error(`Pipedrive ${path}: ${res.status} ${JSON.stringify(body?.error ?? body)}`);
  }
  return body.data;
}

function isOngoing(deal: any, now: number, cutoff: number): boolean {
  const ecd = deal.expected_close_date ? Date.parse(deal.expected_close_date) : NaN;
  if (!isNaN(ecd) && ecd >= now) return true; // sluttdato i framtiden
  const wt = deal.won_time ? Date.parse(deal.won_time) : (deal.add_time ? Date.parse(deal.add_time) : NaN);
  if (!isNaN(wt) && wt >= cutoff) return true; // vunnet nylig
  return false;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Bruk POST" }, 405);
  if (!PD_TOKEN) return json({ error: "PIPEDRIVE_API_TOKEN er ikke satt" }, 500);

  let request_id: string | undefined;
  try { ({ request_id } = await req.json()); } catch { return json({ error: "Ugyldig JSON" }, 400); }
  if (!request_id) return json({ error: "Mangler request_id" }, 400);

  async function save(score: number, signals: Record<string, unknown>) {
    await sb(`requests?id=eq.${request_id}`, {
      method: "PATCH",
      body: JSON.stringify({ customer_activity: score, customer_activity_signals: signals }),
    });
    return json({ ok: true, customer_activity: score, ...signals });
  }

  try {
    const rows = await sb(`requests?id=eq.${request_id}&select=org_name,pipedrive_org_id`);
    const r = rows?.[0];
    if (!r) return json({ error: "Fant ikke forespørselen" }, 404);
    const name: string | null = r.org_name;
    if (!name) return save(0, { reason: "ukjent kunde" });

    let orgId: number | null = r.pipedrive_org_id ?? null;
    if (!orgId) {
      const found = await pd(`organizations/search?term=${encodeURIComponent(name)}&exact_match=true`);
      orgId = found?.items?.[0]?.item?.id ?? null;
    }
    if (!orgId) return save(0, { reason: "kunde ikke funnet i Pipedrive", org_name: name });

    const deals = (await pd(`organizations/${orgId}/deals?status=won&limit=500`)) || [];
    const now = Date.now();
    const cutoff = now - ONGOING_MONTHS * 30 * 24 * 3600 * 1000;
    let ongoing = 0, previous = 0;
    for (const d of deals) { if (isOngoing(d, now, cutoff)) ongoing++; else previous++; }

    const score = ongoing >= 2 ? 100 : ongoing === 1 ? 80 : previous >= 1 ? 50 : 0;
    return save(score, { org_id: orgId, org_name: name, ongoing, previous, won_total: deals.length });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
