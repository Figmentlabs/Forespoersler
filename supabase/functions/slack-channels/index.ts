// slack-channels: lister offentlige Slack-kanaler (for kanalvelgeren ved deling).
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
async function userFromReq(req: Request): Promise<{ id: string } | null> {
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  return res.json();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Bruk POST" }, 405);
  if (!SLACK_TOKEN) return json({ error: "SLACK_BOT_TOKEN mangler i server-konfig" }, 500);

  const user = await userFromReq(req);
  if (!user?.id) return json({ error: "Ikke innlogget" }, 401);

  const channels: { id: string; name: string }[] = [];
  let cursor = "";
  try {
    do {
      const u = new URL("https://slack.com/api/conversations.list");
      u.searchParams.set("types", "public_channel");
      u.searchParams.set("exclude_archived", "true");
      u.searchParams.set("limit", "200");
      if (cursor) u.searchParams.set("cursor", cursor);
      const r = await fetch(u, { headers: { Authorization: `Bearer ${SLACK_TOKEN}` } });
      const d = await r.json();
      if (!d.ok) return json({ error: `Slack: ${d.error}` }, 400);
      for (const c of d.channels || []) channels.push({ id: c.id, name: c.name });
      cursor = d.response_metadata?.next_cursor || "";
    } while (cursor && channels.length < 1000);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }

  channels.sort((a, b) => a.name.localeCompare(b.name));
  return json({ channels });
});
