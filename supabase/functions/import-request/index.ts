// import-request: oppretter en forespørsel manuelt (fra chat-vinduet) ut fra
// innlimt tekst + instruksjoner + evt. vedlegg. Forespørselen scores «på samme
// vis» som e-poster: den legges inn uscoret, og polleren plukker den opp.
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

function emailFromJwt(auth: string | null): string | null {
  try {
    const tok = (auth || "").replace(/^Bearer\s+/i, "");
    const p = JSON.parse(atob(tok.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return p.email || null;
  } catch { return null; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Bruk POST" }, 405);

  let text: string | undefined, instructions: string | undefined, subject: string | undefined;
  let attachments: any[] | undefined;
  try { ({ text, instructions, subject, attachments } = await req.json()); } catch { return json({ error: "Ugyldig JSON" }, 400); }
  if (!text || text.trim().length < 10) return json({ error: "Forespørselsteksten er for kort" }, 400);

  const by = emailFromJwt(req.headers.get("Authorization"));
  const body_text = (instructions && instructions.trim())
    ? `${text.trim()}\n\n---\n[Importnotat fra ${by || "bruker"}]: ${instructions.trim()}`
    : text.trim();
  const subj = (subject && subject.trim())
    || (instructions && instructions.trim().slice(0, 120))
    || text.trim().split("\n")[0].slice(0, 120)
    || "Manuell import";

  try {
    const rows = await sb(`requests`, {
      method: "POST",
      body: JSON.stringify({
        source: "manuell",
        status: "ny",
        subject: subj,
        from_name: "Manuell import",
        from_email: by,
        body_text,
        received_at: new Date().toISOString(),
      }),
    });
    const request_id = rows?.[0]?.id;
    if (!request_id) return json({ error: "Kunne ikke opprette forespørsel" }, 500);

    for (const a of (attachments || [])) {
      if (!a?.storage_path) continue;
      try {
        await sb(`attachments`, {
          method: "POST",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({
            request_id,
            filename: a.filename ?? "vedlegg",
            content_type: a.content_type ?? null,
            size_bytes: a.size_bytes ?? null,
            storage_path: a.storage_path,
          }),
        });
      } catch { /* hopp over feilende vedlegg */ }
    }

    // Trigg en poll-kjøring med én gang så scoringen skjer raskt (ellers tas den
    // ved neste 5-min-syklus).
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/rpc/trigger_github_poll`, {
        method: "POST",
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
        body: "{}",
      });
    } catch { /* best effort */ }

    return json({ ok: true, request_id });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
