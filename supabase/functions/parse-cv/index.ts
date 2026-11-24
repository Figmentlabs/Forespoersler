// parse-cv: strukturerer CV-tekst til konsulentfelt med Claude.
// Krever hemmeligheten ANTHROPIC_API_KEY (Supabase → Edge Functions → Secrets).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const KEY = Deno.env.get("ANTHROPIC_API_KEY");
const MODEL = Deno.env.get("ANTHROPIC_MODEL") || "claude-opus-5-5";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const SYSTEM = `Du er en assistent som leser en konsulent-CV og trekker ut strukturerte felt.
Svar KUN med gyldig JSON (ingen forklaring, ingen kodeblokk) på dette formatet:
{"name": string, "title": string, "location": string|null, "years_experience": number|null,
 "skills": string[], "certifications": string[], "summary": string}
- summary: 2-4 setninger, faktabasert, på norsk, bruk fornavn, ingen selgende prosa.
- skills: nøkkelkvalifikasjoner/kompetanser.
- certifications: sertifiseringer (med årstall hvis oppgitt).
- Bruk tom streng/[]/null når noe mangler. Ikke dikt opp.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Bruk POST" }, 405);
  if (!KEY) return json({ error: "ANTHROPIC_API_KEY er ikke satt i Supabase" }, 500);

  let cv_text: string | undefined;
  try { ({ cv_text } = await req.json()); } catch { return json({ error: "Ugyldig JSON" }, 400); }
  if (!cv_text || cv_text.trim().length < 20) return json({ error: "Mangler cv_text" }, 400);

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1500,
        system: SYSTEM,
        messages: [{ role: "user", content: cv_text.slice(0, 16000) }],
      }),
    });
    const data = await res.json();
    if (!res.ok) return json({ error: `Anthropic: ${res.status} ${JSON.stringify(data?.error ?? data)}` }, 500);
    let text = (data.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    text = text.trim().replace(/^```[a-z]*\s*/i, "").replace(/```$/, "").trim();
    const fields = JSON.parse(text);
    return json({ fields });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
