// qualify-request: kvalifiserer en brokerforespørsel ved å opprette en deal i
// Pipedrive (pipeline «Sonat Gruppen» → steg «Kvalifisert lead»), koble
// organisasjon/kontakt, sette Tender deadline, legge ved en note med match- og
// relasjonsbegrunnelse, og oppdatere forespørselen i databasen.
//
// Miljø:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (injiseres automatisk)
//   PIPEDRIVE_API_TOKEN                        (settes som funksjonshemmelighet)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const PIPELINE_ID = 10;                 // Sonat Gruppen
const STAGE_KVALIFISERT_LEAD = 69;      // «Kvalifisert lead»
const FIELD_TENDER_DEADLINE = "dacbce15507a611e89de5aadb26a57e206cbcc28"; // dato
// Merk: «Figment»-selskapstagg er et sett-felt (kode
// b049dded0010948e240d875ef925e12056dcd734) som krever en option-id. Settes når
// den id-en er hentet fra Pipedrive – se README / neste steg.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PD_TOKEN = Deno.env.get("PIPEDRIVE_API_TOKEN");
const PD_BASE = "https://api.pipedrive.com/v1";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Bruk POST" }, 405);
  if (!PD_TOKEN) return json({ error: "PIPEDRIVE_API_TOKEN er ikke satt" }, 500);

  let request_id: string | undefined;
  try {
    ({ request_id } = await req.json());
  } catch {
    return json({ error: "Ugyldig JSON" }, 400);
  }
  if (!request_id) return json({ error: "Mangler request_id" }, 400);

  try {
    // 1. Hent forespørselen
    const rows = await sb(
      `requests?id=eq.${request_id}&select=*`,
    );
    const r = rows?.[0];
    if (!r) return json({ error: "Fant ikke forespørselen" }, 404);
    if (r.status === "kvalifisert" && r.pipedrive_deal_id) {
      return json({ ok: true, already: true, deal_id: r.pipedrive_deal_id });
    }

    // 2. Beste tjenesteområde + beste konsulent (for note)
    const best = await sb(
      `match_scores?request_id=eq.${request_id}&select=score,reasoning,service_areas(name)&order=score.desc&limit=1`,
    );
    const bestArea = best?.[0];
    const bestCons = await sb(
      `consultant_matches?request_id=eq.${request_id}&select=match_percent,consultants(name)&order=match_percent.desc&limit=1`,
    );
    const bc = bestCons?.[0];

    // 3. Organisasjon i Pipedrive
    let orgId: number | null = r.pipedrive_org_id ?? null;
    if (!orgId && r.org_name) {
      const found = await pd(
        `organizations/search?term=${encodeURIComponent(r.org_name)}&exact_match=true`,
      );
      orgId = found?.items?.[0]?.item?.id ?? null;
      if (!orgId) orgId = (await pd(`organizations`, {
        method: "POST",
        body: JSON.stringify({ name: r.org_name }),
      }))?.id ?? null;
    }

    // 4. Kontaktperson (valgfritt)
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

    // 5. Opprett deal
    const dealBody: Record<string, unknown> = {
      title: r.subject ?? "Brokerforespørsel",
      pipeline_id: PIPELINE_ID,
      stage_id: STAGE_KVALIFISERT_LEAD,
    };
    if (orgId) dealBody.org_id = orgId;
    if (personId) dealBody.person_id = personId;
    if (r.deadline) {
      dealBody.expected_close_date = r.deadline;
      dealBody[FIELD_TENDER_DEADLINE] = r.deadline;
    }
    const deal = await pd(`deals`, { method: "POST", body: JSON.stringify(dealBody) });

    // 6. Note med match- og relasjonsbegrunnelse
    const noteLines = [
      `Innkommet via ${r.org_name ?? r.from_email ?? "broker"}.`,
      bestArea ? `Beste tjenestematch: ${bestArea.service_areas?.name} (${bestArea.score}%).` : null,
      bc ? `Foreslått konsulent: ${bc.consultants?.name} (${bc.match_percent}%).` : null,
      r.relationship_level ? `Relasjon til foretak: ${r.relationship_level}.` : null,
      r.deadline ? `Frist: ${r.deadline}.` : null,
    ].filter(Boolean).join("<br>");
    await pd(`notes`, {
      method: "POST",
      body: JSON.stringify({ content: noteLines, deal_id: deal.id }),
    });

    // 7. Oppdater forespørselen
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

    return json({ ok: true, deal_id: deal.id, org_id: orgId, person_id: personId });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
