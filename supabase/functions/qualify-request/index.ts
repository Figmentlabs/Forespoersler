// qualify-request: oppretter en Pipedrive-deal for en forespørsel, med valgt
// konsulent, selskaps-label (fra konsulentens selskap), oppstart/varighet og
// antatt produkt – både i deal-notatet (alltid synlig) og som produktlinje.
//
// Miljø:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (injiseres automatisk)
//   PIPEDRIVE_API_TOKEN                        (funksjonshemmelighet)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const PIPELINE_ID = 10;                 // Sonat Gruppen
const STAGE_KVALIFISERT_LEAD = 69;      // «Kvalifisert lead»
const FIELD_TENDER_DEADLINE = "dacbce15507a611e89de5aadb26a57e206cbcc28"; // dato
const FIELD_COMPANY_TAG = "b049dded0010948e240d875ef925e12056dcd734";     // sett-felt: selskap

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
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

async function sb(path: string, init: RequestInit = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(init.headers ?? {}),
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

// Slå opp option-id-en for et selskap i selskaps-sett-feltet (robust mot endrede id-er).
async function companyOptionId(company: string): Promise<number | null> {
  try {
    const fields = await pd(`dealFields?limit=500`);
    const f = (fields || []).find((x: any) => x.key === FIELD_COMPANY_TAG);
    const opt = (f?.options || []).find(
      (o: any) => String(o.label).trim().toLowerCase() === company.trim().toLowerCase(),
    );
    return opt?.id ?? null;
  } catch {
    return null;
  }
}

// Koble «antatt produkt» til dealen som produktlinje hvis et produkt matcher navnet.
async function attachProduct(dealId: number, name: string): Promise<boolean> {
  if (!name) return false;
  try {
    const res = await pd(`products/search?term=${encodeURIComponent(name)}&exact_match=false`);
    const item = res?.items?.[0]?.item;
    if (!item?.id) return false;
    const price = item?.prices?.[0]?.price ?? 0;
    await pd(`deals/${dealId}/products`, {
      method: "POST",
      body: JSON.stringify({ product_id: item.id, item_price: price, quantity: 1 }),
    });
    return true;
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Bruk POST" }, 405);
  if (!PD_TOKEN) return json({ error: "PIPEDRIVE_API_TOKEN er ikke satt" }, 500);

  let request_id: string | undefined;
  let consultant_id: string | undefined;
  try {
    ({ request_id, consultant_id } = await req.json());
  } catch {
    return json({ error: "Ugyldig JSON" }, 400);
  }
  if (!request_id) return json({ error: "Mangler request_id" }, 400);

  try {
    const rows = await sb(`requests?id=eq.${request_id}&select=*`);
    const r = rows?.[0];
    if (!r) return json({ error: "Fant ikke forespørselen" }, 404);
    if (r.status === "kvalifisert" && r.pipedrive_deal_id) {
      return json({ ok: true, already: true, deal_id: r.pipedrive_deal_id });
    }

    // Valgt konsulent (navn, selskap, Flowcase-ID)
    let consultant: any = null;
    if (consultant_id) {
      const cs = await sb(
        `consultants?id=eq.${consultant_id}&select=name,company,flowcase_user_id,title`,
      );
      consultant = cs?.[0] ?? null;
    }

    // Beste tjenesteområde (til note)
    const best = await sb(
      `match_scores?request_id=eq.${request_id}&select=score,reasoning,service_areas(name)&order=score.desc&limit=1`,
    );
    const bestArea = best?.[0];

    // Organisasjon i Pipedrive
    let orgId: number | null = r.pipedrive_org_id ?? null;
    if (!orgId && r.org_name) {
      const found = await pd(
        `organizations/search?term=${encodeURIComponent(r.org_name)}&exact_match=true`,
      );
      orgId = found?.items?.[0]?.item?.id ?? null;
      if (!orgId) {
        orgId = (await pd(`organizations`, {
          method: "POST",
          body: JSON.stringify({ name: r.org_name }),
        }))?.id ?? null;
      }
    }

    // Kontaktperson (valgfritt)
    let personId: number | null = r.pipedrive_person_id ?? null;
    if (!personId && r.contact_name) {
      personId = (await pd(`persons`, {
        method: "POST",
        body: JSON.stringify({
          name: r.contact_name,
          email: r.from_email ? [{ value: r.from_email, primary: true }] : undefined,
          org_id: orgId ?? undefined,
        }),
      }))?.id ?? null;
    }

    // Deal
    const dealBody: Record<string, unknown> = {
      title: r.title ?? r.subject ?? "Brokerforespørsel",
      pipeline_id: PIPELINE_ID,
      stage_id: STAGE_KVALIFISERT_LEAD,
    };
    if (orgId) dealBody.org_id = orgId;
    if (personId) dealBody.person_id = personId;
    if (r.deadline) {
      dealBody.expected_close_date = r.deadline;
      dealBody[FIELD_TENDER_DEADLINE] = r.deadline;
    }
    // Selskaps-label fra konsulentens selskap
    const company: string | null = consultant?.company ?? null;
    const optId = company ? await companyOptionId(company) : null;
    if (optId) dealBody[FIELD_COMPANY_TAG] = optId;

    const deal = await pd(`deals`, { method: "POST", body: JSON.stringify(dealBody) });

    // Note med konsulent, selskap, oppstart/varighet, antatt produkt
    const noteLines = [
      `Innkommet via ${r.org_name ?? r.from_email ?? "broker"}.`,
      consultant
        ? `Konsulent: ${consultant.name}${company ? ` (${company})` : ""}${
            consultant.flowcase_user_id ? ` · Flowcase-ID ${consultant.flowcase_user_id}` : ""
          }.`
        : null,
      bestArea ? `Beste tjenestematch: ${bestArea.service_areas?.name} (${bestArea.score}%).` : null,
      r.assumed_product ? `Antatt produkt: ${r.assumed_product}.` : null,
      r.start_date ? `Oppstart: ${r.start_date}.` : null,
      r.duration ? `Varighet: ${r.duration}.` : null,
      r.relationship_level ? `Relasjon til foretak: ${r.relationship_level}.` : null,
      r.deadline ? `Frist: ${r.deadline}.` : null,
    ].filter(Boolean).join("<br>");
    await pd(`notes`, { method: "POST", body: JSON.stringify({ content: noteLines, deal_id: deal.id }) });

    // Antatt produkt som produktlinje (best effort)
    const productAttached = await attachProduct(deal.id, r.assumed_product ?? "");

    // Oppdater forespørselen
    await sb(`requests?id=eq.${request_id}`, {
      method: "PATCH",
      body: JSON.stringify({
        status: "kvalifisert",
        pipedrive_deal_id: deal.id,
        pipedrive_org_id: orgId,
        pipedrive_person_id: personId,
        reviewed_at: new Date().toISOString(),
      }),
    });

    return json({
      ok: true,
      deal_id: deal.id,
      consultant: consultant?.name ?? null,
      company_label: optId ? company : null,
      product_attached: productAttached,
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
