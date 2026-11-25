// gmail-oauth-start: bygger Google OAuth-URL for å koble innlogget bruker sin Gmail.
// Lager en engangs-nonce (oauth_states) som knytter Google-callbacken til brukeren.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID");
// Kun lesetilgang til Gmail + e-post/profil for å vise hvilken konto som ble koblet.
const SCOPE = "https://www.googleapis.com/auth/gmail.readonly email profile";

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
  if (!CLIENT_ID) return json({ error: "GOOGLE_CLIENT_ID mangler i server-konfig" }, 500);

  let redirect_uri: string | undefined;
  try { ({ redirect_uri } = await req.json()); } catch { return json({ error: "Ugyldig JSON" }, 400); }
  if (!redirect_uri) return json({ error: "Mangler redirect_uri" }, 400);

  const user = await userFromReq(req);
  if (!user?.id) return json({ error: "Ikke innlogget" }, 401);

  const nonce = crypto.randomUUID();
  await sb("oauth_states", { method: "POST", body: JSON.stringify({ nonce, user_id: user.id, email: user.email }) });

  const p = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: nonce,
    login_hint: user.email || "",
  });
  return json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${p.toString()}` });
});
