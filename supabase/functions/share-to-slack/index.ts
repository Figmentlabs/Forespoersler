// share-to-slack: poster en forespørsel som et formatert kort til valgt Slack-kanal.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SLACK_TOKEN = Deno.env.get("SLACK_BOT_TOKEN");

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
async function userFromReq(req: Request): Promise<{ id: string; email?: string } | null> {
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  return res.json();
}
const mk = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
function slackErr(e: string): string {
  if (e === "not_in_channel") return "Boten er ikke i kanalen. Inviter den til kanalen, eller gi Slack-appen scope chat:write.public.";
  if (e === "channel_not_found") return "Fant ikke kanalen.";
  if (e === "is_archived") return "Kanalen er arkivert.";
  return "Slack: " + e;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Bruk POST" }, 405);
  if (!SLACK_TOKEN) return json({ error: "SLACK_BOT_TOKEN mangler i server-konfig" }, 500);

  const user = await userFromReq(req);
  if (!user?.id) return json({ error: "Ikke innlogget" }, 401);

  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return json({ error: "Ugyldig JSON" }, 400); }
  const channel = String(b.channel || "");
  const title = String(b.title || "").trim();
  if (!channel || !title) return json({ error: "Mangler kanal eller tittel" }, 400);

  const fields: { type: string; text: string }[] = [];
  const add = (label: string, val: unknown) => { const v = String(val ?? "").trim(); if (v) fields.push({ type: "mrkdwn", text: `*${label}:*\n${mk(v)}` }); };
  add("Kunde", b.customer);
  add("Tjenesteområde", b.area ? `${b.area}${b.areaPct != null ? ` (${b.areaPct}%)` : ""}` : "");
  add("Anbefaling", b.recommendation);
  add("Status", b.status);
  add("Lokasjon", b.location);
  add("Oppstart", b.start);
  add("Varighet", b.duration);
  add("Antatt produkt", b.product);

  const blocks: unknown[] = [{ type: "header", text: { type: "plain_text", text: trunc(title, 150), emoji: true } }];
  if (fields.length) blocks.push({ type: "section", fields: fields.slice(0, 10) });
  const note = String(b.note || "").trim();
  if (note) blocks.push({ type: "section", text: { type: "mrkdwn", text: `💬 ${mk(note)}` } });
  const url = String(b.url || "");
  if (/^https:\/\//i.test(url)) blocks.push({ type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Åpne i Kvalifiseringstavla" }, url }] });
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `Delt av ${mk(user.email || "")} · Kvalifiseringstavla` }] });

  const text = `${title}${b.customer ? ` – ${b.customer}` : ""}`;
  try {
    const r = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { Authorization: `Bearer ${SLACK_TOKEN}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ channel, text, blocks, unfurl_links: false }),
    });
    const d = await r.json();
    if (!d.ok) return json({ error: slackErr(d.error) }, 400);
    return json({ ok: true, ts: d.ts });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
