// gmail-oauth-exchange: tar imot ?code&state fra Google (via appen), verifiserer nonce,
// bytter koden mot refresh-token og lagrer koblingen for innlogget bruker.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID");
const CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET");

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
async function userFromReq(req: Request): Promise<{ id: string; email?: string } | null> {
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  return res.json();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Bruk POST" }, 405);
  if (!CLIENT_ID || !CLIENT_SECRET) return json({ error: "Google-nøkler mangler i server-konfig" }, 500);

  const user = await userFromReq(req);
  if (!user?.id) return json({ error: "Ikke innlogget" }, 401);

  let code: string | undefined, state: string | undefined, redirect_uri: string | undefined;
  try { ({ code, state, redirect_uri } = await req.json()); } catch { return json({ error: "Ugyldig JSON" }, 400); }
  if (!code || !state || !redirect_uri) return json({ error: "Mangler code/state/redirect_uri" }, 400);

  // Verifiser engangs-nonce og at den tilhører innlogget bruker.
  const rows = await sb(`oauth_states?nonce=eq.${encodeURIComponent(state)}&select=user_id`);
  const st = rows?.[0];
  if (!st || st.user_id !== user.id) return json({ error: "Ugyldig eller utløpt state" }, 400);
  await sb(`oauth_states?nonce=eq.${encodeURIComponent(state)}`, { method: "DELETE" });

  // Bytt autorisasjonskode mot tokens.
  const body = new URLSearchParams({
    code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri, grant_type: "authorization_code",
  });
  const tr = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
  });
  const tok = await tr.json();
  if (!tr.ok) return json({ error: "Token-utveksling feilet", detail: tok?.error_description || tok?.error }, 400);

  const refresh_token = tok.refresh_token as string | undefined;
  const access_token = tok.access_token as string | undefined;
  if (!refresh_token) {
    return json({ error: "Ingen refresh_token mottatt. Fjern appens tilgang i Google-kontoen (myaccount.google.com/permissions) og prøv igjen." }, 400);
  }

  // Finn hvilken Gmail-konto som faktisk ble koblet.
  let gmail = user.email || "";
  try {
    const ui = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", { headers: { Authorization: `Bearer ${access_token}` } });
    if (ui.ok) { const u = await ui.json(); if (u.email) gmail = u.email; }
  } catch { /* behold innloggings-e-post */ }

  const now = new Date().toISOString();
  const expiry = new Date(Date.now() + Number(tok.expires_in || 3600) * 1000).toISOString();

  await sb("gmail_connections?on_conflict=user_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      user_id: user.id, email: gmail, refresh_token, access_token, token_expiry: expiry,
      scope: tok.scope || null, status: "connected", last_error: null, connected_at: now, updated_at: now,
    }),
  });
  await sb("app_users?on_conflict=id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      id: user.id, email: user.email || gmail,
      gmail_connected: true, gmail_email: gmail, gmail_status: "connected", gmail_connected_at: now,
    }),
  });

  return json({ ok: true, email: gmail });
});
