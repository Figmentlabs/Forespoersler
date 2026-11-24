// qualify-request: oppretter/beriker en Pipedrive-deal for en forespørsel:
//   - valgt konsulent kobles som Person (med Flowcase-ID), selskap blir deal-label
//   - Project start/end date-feltene fylles fra forespørselen
//   - antatt produkt kobles som produktlinje (matchet mot produktkatalogen)
//   - alt oppsummeres også i et deal-notat
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const PIPELINE_ID = 10;
const STAGE_KVALIFISERT_LEAD = 69;
const FIELD_TENDER_DEADLINE = "dacbce15507a611e89de5aadb26a57e206cbcc28";
const FIELD_COMPANY_TAG = "b049dded0010948e240d875ef925e12056dcd734";
const START_FIELD_NAME = "Project start date";
const END_FIELD_NAME = "Project end date";

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
async function pd(path: string, init: RequestInit = {}) {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${PD_BASE}/${path}${sep}api_token=${PD_TOKEN}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body?.success === false) {
    throw new Error(`Pipedrive ${path}: ${res.status} ${JSON.stringify(body?.error ?? body)}`);
  }
  return body.data;
}

let _dealFields: any[] | null = null;
async function dealFields() { if (!_dealFields) _dealFields = (await pd(`dealFields?limit=500`)) || []; return _dealFields; }
async function dealFieldKey(name: string): Promise<string | null> {
  const f = (await dealFields()).find((x: any) => String(x.name).trim().toLowerCase() === name.toLowerCase());
  return f?.key ?? null;
}
async function companyOptionId(company: string): Promise<number | null> {
  const f = (await dealFields()).find((x: any) => x.key === FIELD_COMPANY_TAG);
  const o = (f?.options || []).find((o: any) => String(o.label).trim().toLowerCase() === company.trim().toLowerCase());
  return o?.id ?? null;
}
let _personFields: any[] | null = null;
async function flowcaseFieldKey(): Promise<string | null> {
  if (!_personFields) _personFields = (await pd(`personFields?limit=500`)) || [];
  const f = _personFields.find((x: any) => /flowcase/i.test(String(x.name)));
  return f?.key ?? null;
}
let _products: any[] | null = null;
function norm(s: string) { return String(s || "").toLowerCase().replace(/[^a-zæøå0-9 ]/g, " ").replace(/\s+/g, " ").trim(); }
async function matchProduct(name: string): Promise<any | null> {
  if (!name) return null;
  if (!_products) _products = (await pd(`products?limit=500`)) || [];
  const n = norm(name);
  const nt = [...new Set(n.split(" ").filter((w) => w.length >= 4))];
  let best: any = null, bs = 0;
  for (const p of _products) {
    const pn = norm(p.name); if (!pn) continue;
    if (pn === n) return p;
    const pt = [...new Set(pn.split(" ").filter((w) => w.length >= 4))];
    let s = 0;
    for (const t of nt) if (pn.includes(t)) s++;
    for (const q of pt) if (n.includes(q)) s++;
    for (const t of nt) for (const q of pt) { const k = Math.min(5, t.length, q.length); if (k >= 5 && t.slice(0, k) === q.slice(0, k)) s++; }
    if (s > bs) { bs = s; best = p; }
  }
  return bs >= 1 ? best : null;
}

// Finn/opprett Person for konsulenten og sett Flowcase-ID.
async function linkConsultantPerson(consultant: any): Promise<number | null> {
  try {
    const fcKey = await flowcaseFieldKey();
    const patch: Record<string, unknown> = {};
    if (fcKey && consultant.flowcase_user_id) patch[fcKey] = consultant.flowcase_user_id;
    const found = await pd(`persons/search?term=${encodeURIComponent(consultant.name)}&fields=name&exact_match=true`);
    let personId = found?.items?.[0]?.item?.id ?? null;
    if (personId) {
      if (Object.keys(patch).length) await pd(`persons/${personId}`, { method: "PUT", body: JSON.stringify(patch) });
      return personId;
    }
    const created = await pd(`persons`, { method: "POST", body: JSON.stringify({ name: consultant.name, ...patch }) });
    return created?.id ?? null;
  } catch { return null; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Bruk POST" }, 405);
  if (!PD_TOKEN) return json({ error: "PIPEDRIVE_API_TOKEN er ikke satt" }, 500);

  let request_id: string | undefined;
  let consultant_id: string | undefined;
  try { ({ request_id, consultant_id } = await req.json()); } catch { return json({ error: "Ugyldig JSON" }, 400); }
  if (!request_id) return json({ error: "Mangler request_id" }, 400);

  try {
    const rows = await sb(`requests?id=eq.${request_id}&select=*`);
    const r = rows?.[0];
    if (!r) return json({ error: "Fant ikke forespørselen" }, 404);
    if (r.status === "kvalifisert" && r.pipedrive_deal_id) return json({ ok: true, already: true, deal_id: r.pipedrive_deal_id });

    let consultant: any = null;
    if (consultant_id) {
      const cs = await sb(`consultants?id=eq.${consultant_id}&select=name,company,flowcase_user_id,title`);
      consultant = cs?.[0] ?? null;
    }

    const best = await sb(`match_scores?request_id=eq.${request_id}&select=score,service_areas(name)&order=score.desc&limit=1`);
    const bestArea = best?.[0];

    // Organisasjon (kunde)
    let orgId: number | null = r.pipedrive_org_id ?? null;
    if (!orgId && r.org_name) {
      const found = await pd(`organizations/search?term=${encodeURIComponent(r.org_name)}&exact_match=true`);
      orgId = found?.items?.[0]?.item?.id ?? null;
      if (!orgId) orgId = (await pd(`organizations`, { method: "POST", body: JSON.stringify({ name: r.org_name }) }))?.id ?? null;
    }

    // Person = valgt konsulent (med Flowcase-ID). Uten konsulent: ev. broker-kontakt.
    let personId: number | null = null;
    if (consultant) {
      personId = await linkConsultantPerson(consultant);
    } else if (r.pipedrive_person_id) {
      personId = r.pipedrive_person_id;
    } else if (r.contact_name) {
      personId = (await pd(`persons`, { method: "POST", body: JSON.stringify({ name: r.contact_name, email: r.from_email ? [{ value: r.from_email, primary: true }] : undefined }) }))?.id ?? null;
    }

    // Deal
    const dealBody: Record<string, unknown> = {
      title: r.title ?? r.subject ?? "Brokerforespørsel",
      pipeline_id: PIPELINE_ID,
      stage_id: STAGE_KVALIFISERT_LEAD,
    };
    if (orgId) dealBody.org_id = orgId;
    if (personId) dealBody.person_id = personId;
    if (r.deadline) { dealBody.expected_close_date = r.deadline; dealBody[FIELD_TENDER_DEADLINE] = r.deadline; }
    const company: string | null = consultant?.company ?? null;
    const optId = company ? await companyOptionId(company) : null;
    if (optId) dealBody[FIELD_COMPANY_TAG] = optId;
    // Project start/end date
    const startKey = await dealFieldKey(START_FIELD_NAME);
    const endKey = await dealFieldKey(END_FIELD_NAME);
    if (startKey && r.start_iso) dealBody[startKey] = r.start_iso;
    if (endKey && r.end_iso) dealBody[endKey] = r.end_iso;

    const deal = await pd(`deals`, { method: "POST", body: JSON.stringify(dealBody) });

    // Antatt produkt som produktlinje
    let productName: string | null = null;
    const prod = await matchProduct(r.assumed_product ?? "");
    if (prod) {
      try {
        const price = prod?.prices?.[0]?.price ?? 0;
        await pd(`deals/${deal.id}/products`, { method: "POST", body: JSON.stringify({ product_id: prod.id, item_price: price, quantity: 1 }) });
        productName = prod.name;
      } catch { /* ignorer */ }
    }

    // Notat (oppsummering / fallback)
    const noteLines = [
      `Innkommet via ${r.org_name ?? r.from_email ?? "broker"}.`,
      consultant ? `Konsulent: ${consultant.name}${company ? ` (${company})` : ""}${consultant.flowcase_user_id ? ` · Flowcase-ID ${consultant.flowcase_user_id}` : ""}.` : null,
      bestArea ? `Beste tjenestematch: ${bestArea.service_areas?.name} (${bestArea.score}%).` : null,
      (productName || r.assumed_product) ? `Produkt: ${productName ?? r.assumed_product}.` : null,
      (r.start_iso || r.start_date) ? `Oppstart: ${r.start_iso ?? r.start_date}.` : null,
      (r.end_iso || r.duration) ? `Slutt/varighet: ${r.end_iso ?? r.duration}.` : null,
      r.deadline ? `Frist: ${r.deadline}.` : null,
    ].filter(Boolean).join("<br>");
    await pd(`notes`, { method: "POST", body: JSON.stringify({ content: noteLines, deal_id: deal.id }) });

    await sb(`requests?id=eq.${request_id}`, {
      method: "PATCH",
      body: JSON.stringify({
        status: "kvalifisert", pipedrive_deal_id: deal.id, pipedrive_org_id: orgId,
        pipedrive_person_id: personId, reviewed_at: new Date().toISOString(),
      }),
    });

    return json({
      ok: true, deal_id: deal.id, consultant: consultant?.name ?? null,
      company_label: optId ? company : null, product: productName,
      start: startKey && r.start_iso ? r.start_iso : null, end: endKey && r.end_iso ? r.end_iso : null,
      person_id: personId,
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
