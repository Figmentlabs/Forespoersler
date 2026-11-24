"""Automatisk synk av konsulenter og CV-er fra Flowcase til Supabase.

Henter brukere (GET /api/v2/users/search) og deres master-CV
(GET /api/v3/cvs/<user_id>/<cv_id>), mapper til konsulentfelt og upserter
på flowcase_user_id. Kjøres av GitHub Actions (cron) eller manuelt.

Miljø:
  FLOWCASE_SUBDOMAIN         f.eks. "sonat" (delen før .flowcase.com)
  FLOWCASE_API_KEY          API-nøkkel (Flowcase → Account → API Keys)
  FLOWCASE_OFFICE_IDS       (valgfritt) komma-separerte office-id-er for å begrense
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
"""
from __future__ import annotations

import datetime as dt
import logging
import os
import sys
import time
from pathlib import Path

try:
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).resolve().parent.parent / ".env", override=True)
except Exception:
    pass

import httpx
from supabase import create_client

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("flowcase")

# Opprinnelige placeholder/mock-konsulenter. Slettes automatisk etter at ekte
# konsulenter er synket inn fra Flowcase (kun de uten Flowcase-kobling).
MOCK_NAMES = [
    "Lise Haugen", "Anders Moen", "Kari Nordbø", "Jonas Eide",
    "Mette Solberg", "Lise Aasland Ursin",
]


def _req(name: str) -> str:
    v = os.getenv(name)
    if not v:
        log.error("Mangler miljøvariabel: %s", name)
        sys.exit(2)
    return v


def pick(m) -> str:
    """Flerspråklig felt → streng (norsk først, så engelsk, så hva som finnes)."""
    if isinstance(m, str):
        return m
    if not isinstance(m, dict):
        return ""
    for lang in ("no", "nb", "int", "en"):
        if m.get(lang):
            return m[lang]
    for v in m.values():
        if v:
            return v
    return ""


class Flowcase:
    def __init__(self, subdomain: str, api_key: str):
        self.client = httpx.Client(
            base_url=f"https://{subdomain}.flowcase.com",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            timeout=40,
        )

    def _get(self, path: str, **params):
        for attempt in range(5):
            r = self.client.get(path, params=params or None)
            if r.status_code == 429:
                wait = int(r.headers.get("Retry-After", "2"))
                time.sleep(min(wait, 10))
                continue
            r.raise_for_status()
            return r.json()
        r.raise_for_status()

    def users(self, office_ids: list[str]) -> list[dict]:
        out, frm, size = [], 0, 200
        params = {}
        if office_ids:
            params["office_ids[]"] = office_ids
        while True:
            batch = self._get("/api/v2/users/search", **{**params, "from": frm, "size": size})
            if not isinstance(batch, list):
                break
            out += batch
            if len(batch) < size:
                break
            frm += size
        return out

    def cv(self, user_id: str, cv_id: str) -> dict:
        return self._get(f"/api/v3/cvs/{user_id}/{cv_id}")


def map_consultant(user: dict, cv: dict) -> dict:
    name = cv.get("name") or pick(cv.get("name_multilang")) or user.get("name")
    location = pick(cv.get("place_of_residence"))

    skills: list[str] = []
    for cat in cv.get("technologies") or []:
        for s in cat.get("technology_skills") or []:
            t = pick(s.get("tags"))
            if t:
                skills.append(t)
    skills = list(dict.fromkeys(skills))[:40]

    certs: list[str] = []
    for c in cv.get("certifications") or []:
        nm = pick(c.get("name"))
        if nm:
            yr = c.get("year")
            certs.append(f"{nm} ({yr})" if yr else nm)

    summary_parts: list[str] = []
    for kq in cv.get("key_qualifications") or []:
        d = pick(kq.get("long_description")) or pick(kq.get("label"))
        if d:
            summary_parts.append(d)
    summary = " ".join(summary_parts)[:1500] or None

    years = None
    yrs: list[int] = []
    for coll in ("project_experiences", "work_experiences"):
        for p in cv.get(coll) or []:
            try:
                yrs.append(int(p.get("year_from")))
            except (TypeError, ValueError):
                pass
    if yrs:
        years = max(0, dt.date.today().year - min(yrs))

    fid = str(user.get("user_id") or user.get("id"))
    master_cv = {
        "flowcase_user_id": fid,
        "flowcase_cv_id": cv.get("_id") or cv.get("id"),
        "place_of_residence": location,
        "born_year": cv.get("born_year"),
        "languages": [
            {"name": pick(l.get("name")), "level": pick(l.get("level"))}
            for l in (cv.get("languages") or [])
        ],
        "projects": [
            {
                "customer": pick(p.get("customer")),
                "description": pick(p.get("description")),
                "from": p.get("year_from"),
                "to": p.get("year_to"),
            }
            for p in (cv.get("project_experiences") or [])[:15]
        ],
        "source": "flowcase",
    }

    return {
        "flowcase_user_id": fid,
        "name": name,
        "title": pick(cv.get("title")) or None,
        "location": location or None,
        "email": user.get("email") or cv.get("email"),
        "years_experience": years,
        "skills": skills,
        "certifications": certs,
        "summary": summary,
        "master_cv": master_cv,
        "available": not user.get("deactivated", False),
        "flowcase_synced_at": dt.datetime.now(dt.timezone.utc).isoformat(),
    }


def run() -> int:
    sub = _req("FLOWCASE_SUBDOMAIN")
    key = _req("FLOWCASE_API_KEY")
    sb = create_client(_req("SUPABASE_URL"), _req("SUPABASE_SERVICE_ROLE_KEY"))
    office_ids = [x.strip() for x in os.getenv("FLOWCASE_OFFICE_IDS", "").split(",") if x.strip()]

    fc = Flowcase(sub, key)
    users = fc.users(office_ids)
    offices = sorted({f"{u.get('office_id')}:{u.get('office_name')}" for u in users if u.get("office_name")})
    log.info("Fant %d brukere i Flowcase. Kontorer: %s", len(users), ", ".join(offices) or "(ukjent)")

    active = [u for u in users if not u.get("deactivated") and u.get("default_cv_id")]
    synced = 0
    for u in active:
        uid = u.get("user_id") or u.get("id")
        try:
            cv = fc.cv(uid, u["default_cv_id"])
            row = map_consultant(u, cv)
            if not row["name"]:
                continue
            sb.table("consultants").upsert(row, on_conflict="flowcase_user_id").execute()
            synced += 1
            log.info("Synket: %s (%s)", row["name"], row["title"] or "—")
        except Exception as exc:
            log.warning("Feilet for %s: %s", u.get("name"), exc)
        time.sleep(0.15)  # hold oss godt under 10 req/s

    # Rydd bort placeholder-konsulentene når ekte er synket inn.
    if synced > 0:
        try:
            sb.table("consultants").delete().in_("name", MOCK_NAMES).is_(
                "flowcase_user_id", "null"
            ).execute()
            log.info("Ryddet bort placeholder-konsulenter uten Flowcase-kobling.")
        except Exception as exc:
            log.warning("Opprydding av placeholder-konsulenter feilet: %s", exc)

    log.info("Ferdig. Synket %d konsulent(er) fra Flowcase.", synced)
    return 0


if __name__ == "__main__":
    sys.exit(run())
