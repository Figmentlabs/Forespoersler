"""Gmail API-tilgang for brukerkoblede postkasser (OAuth refresh-token).

Bruker kun lesescope (gmail.readonly). Henter rå RFC822 som mates rett inn i
den eksisterende e-postparseren.
"""
from __future__ import annotations

import base64

import httpx

GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me"


class GmailError(RuntimeError):
    pass


def access_token(client_id: str, client_secret: str, refresh_token: str) -> str:
    """Bytt et refresh-token mot et ferskt access-token."""
    r = httpx.post(
        GOOGLE_TOKEN_URL,
        data={
            "client_id": client_id,
            "client_secret": client_secret,
            "refresh_token": refresh_token,
            "grant_type": "refresh_token",
        },
        timeout=30,
    )
    if r.status_code != 200:
        raise GmailError(f"token refresh {r.status_code}: {r.text[:300]}")
    tok = r.json().get("access_token")
    if not tok:
        raise GmailError("token refresh: mangler access_token")
    return tok


def list_message_ids(token: str, query: str, max_results: int = 50) -> list[str]:
    """List melding-IDer som matcher Gmail-søket (nyeste først)."""
    ids: list[str] = []
    page: str | None = None
    headers = {"Authorization": f"Bearer {token}"}
    while True:
        params: dict[str, str | int] = {"q": query, "maxResults": min(100, max_results)}
        if page:
            params["pageToken"] = page
        r = httpx.get(f"{GMAIL_API}/messages", params=params, headers=headers, timeout=30)
        if r.status_code != 200:
            raise GmailError(f"messages.list {r.status_code}: {r.text[:300]}")
        data = r.json()
        for m in data.get("messages", []):
            ids.append(m["id"])
        page = data.get("nextPageToken")
        if not page or len(ids) >= max_results:
            break
    return ids[:max_results]


def get_raw(token: str, msg_id: str) -> bytes:
    """Hent rå RFC822-bytes for én melding."""
    r = httpx.get(
        f"{GMAIL_API}/messages/{msg_id}",
        params={"format": "raw"},
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    if r.status_code != 200:
        raise GmailError(f"messages.get {r.status_code}: {r.text[:300]}")
    raw = r.json().get("raw", "")
    return base64.urlsafe_b64decode(raw.encode("utf-8"))


def build_query(domains: set[str] | None, lookback_days: int) -> str:
    """Bygg et Gmail-søk: nylige meldinger, begrenset til overvåkede avsenderdomener."""
    q = f"newer_than:{max(1, lookback_days)}d"
    doms = sorted(d for d in (domains or set()) if d)
    if doms:
        q += " from:(" + " OR ".join(doms) + ")"
    return q
