"""Hovedløkke for polleren.

Kjøres periodisk (cron / GitHub Actions). For hver konto, per nye epost:
  1. domenefilter (bare overvåkede avsenderdomener)
  2. parse epost + vedlegg
  3. dublettsjekk (Message-ID + innhold-hash på tvers av kontoer)
  4. lagre forespørsel + vedlegg i Supabase
  5. score mot tjenesteområder OG konsulenter med Claude
  6. lagre match_scores + consultant_matches, oppdater forespørselen

Status settes til 'ny' — kvalifisering/avvisning skjer manuelt i UI-et.
"""
from __future__ import annotations

import hashlib
import logging
import os
import re
import sys
from datetime import date, timedelta
from pathlib import Path

# IMAP krever engelske måneds-forkortelser uansett systemspråk.
_IMAP_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

# Hvor mange dager tilbake IMAP-søket skal dekke. Dublettkontroll (UID +
# innhold-hash) hindrer reprosessering, så et større vindu betyr bare at et
# hull i cron-kjøringen (f.eks. natten over) hentes inn igjen – ingen e-post
# går tapt permanent slik «kun i dag» risikerte ved dato-skifte.
POLL_LOOKBACK_DAYS = int(os.getenv("POLL_LOOKBACK_DAYS", "3"))


def imap_since() -> str:
    t = date.today() - timedelta(days=POLL_LOOKBACK_DAYS)
    return f"{t.day:02d}-{_IMAP_MONTHS[t.month - 1]}-{t.year}"

# Last .env fra prosjektroten automatisk, så kjøring ikke krever `source .env`.
try:
    from dotenv import load_dotenv

    # override=True: .env vinner over evt. utdaterte variabler i shell-økta
    # (f.eks. hvis noen tidligere kjørte `set -a && source .env`).
    load_dotenv(Path(__file__).resolve().parent.parent / ".env", override=True)
except Exception:
    pass

from config import Config, ConfigError, ImapAccount
from email_parser import ParsedEmail, parse_email
from gmail_client import access_token, build_query, get_raw, list_message_ids
from imap_client import ImapClient
from scoring import Scorer, ScoringResult
from supabase_client import Store

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("poller")


def content_hash(mail: ParsedEmail) -> str:
    norm = "\n".join(
        [
            (mail.from_email or "").strip().lower(),
            re.sub(r"\s+", " ", (mail.subject or "")).strip().lower(),
            re.sub(r"\s+", " ", (mail.body_text or "")).strip().lower(),
        ]
    )
    return hashlib.sha256(norm.encode("utf-8")).hexdigest()


def domain_of(email: str | None) -> str:
    if not email or "@" not in email:
        return ""
    return email.rsplit("@", 1)[1].strip().lower()


def _store_request(store: Store, mail: ParsedEmail, chash: str, account_id: str | None) -> str | None:
    payload = {
        "message_id": mail.message_id,
        "content_hash": chash,
        "inbox_account_id": account_id,
        "from_email": mail.from_email or None,
        "from_name": mail.from_name or None,
        "to_email": mail.to_email or None,
        "subject": mail.subject or None,
        "body_text": mail.body_text or None,
        "body_html": mail.body_html or None,
        "received_at": mail.received_at.isoformat() if mail.received_at else None,
        "raw_headers": mail.headers,
        "status": "ny",
    }
    return store.insert_request(payload)


def _store_attachments(store: Store, request_id: str, mail: ParsedEmail) -> None:
    for att in mail.attachments:
        try:
            path = store.upload_attachment(request_id, att.filename, att.content_type, att.data)
            store.insert_attachment(request_id, att.filename, att.content_type, len(att.data), path)
        except Exception as exc:
            log.warning("Kunne ikke lagre vedlegg %s: %s", att.filename, exc)


def _store_scores(store, request_id, areas, consultants, result: ScoringResult) -> None:
    key_to_id = {a["key"]: a["id"] for a in areas}
    rows = []
    for s in result.scores:
        area_id = key_to_id.get(s.area_key)
        if area_id:
            rows.append(
                {
                    "request_id": request_id,
                    "service_area_id": area_id,
                    "score": max(0, min(100, s.score)),
                    "reasoning": s.reasoning,
                }
            )
    store.insert_match_scores(rows)

    cons_ids = {c["id"] for c in consultants}
    crows = [
        {
            "request_id": request_id,
            "consultant_id": c.consultant_id,
            "match_percent": max(0, min(100, c.match)),
            "reasoning": c.reasoning,
            "domain_level": c.domain_level,
            "domain_reasoning": c.domain_reasoning,
        }
        for c in result.consultants
        if c.consultant_id in cons_ids
    ]
    store.insert_consultant_matches(crows)

    best_area_id = key_to_id.get(result.best_area_key)
    store.update_request_scoring(
        request_id, best_area_id, max(0, min(100, result.total_score)),
        result.domain or None, result.title or None, result.subarea or None,
    )
    store.update_request_category(
        request_id, result.category or "mulig",
        max(0, min(100, result.category_confidence)), result.category_reasoning or None,
    )
    store.update_request_location(request_id, result.locations)
    store.update_request_engagement(
        request_id, result.start_date, result.duration, result.assumed_product,
        result.start_iso, result.end_iso,
    )
    store.set_customer(request_id, result.customer)


def score_pending(store, scorer, areas, consultants, examples) -> int:
    """Score forespørsler som mangler scoring (manuell import o.l.)."""
    pend = store.pending_requests()
    for r in pend:
        try:
            candidates = store.open_candidates(r["id"])
            result = scorer.score(areas, consultants, r.get("subject") or "",
                                  r.get("body_text") or "", examples, candidates)
            _store_scores(store, r["id"], areas, consultants, result)
            if result.same_opportunity_id:
                store.link_same_opportunity(r["id"], result.same_opportunity_id)
            log.info("scoret ventende '%s' → %s (%d)",
                     (r.get("title") or r.get("subject") or "")[:50],
                     result.best_area_key, result.total_score)
        except Exception as exc:
            log.error("scoring feilet for ventende %s: %s", r["id"], exc)
            store.mark_request_error(r["id"])
    return len(pend)


def process_account(
    cfg: Config, store: Store, scorer: Scorer, areas, consultants, domains, acc: ImapAccount,
    examples=None,
) -> int:
    key = f"{acc.email}:{acc.mailbox}"
    last_uid = store.get_last_uid(key)
    account_id = store.inbox_account_id(acc.email)
    since = imap_since()
    log.info("[%s] starter fra UID > %s, siste %d dager (SINCE %s)",
             acc.email, last_uid, POLL_LOOKBACK_DAYS, since)

    with ImapClient(acc.host, acc.port, acc.user, acc.password, acc.mailbox) as imap:
        messages = imap.fetch_since(last_uid, cfg.max_fetch, since_date=since)
    log.info("[%s] hentet %d melding(er) (nyeste først)", acc.email, len(messages))

    processed = 0
    highest = last_uid
    for msg in messages:
        highest = max(highest, msg.uid)
        try:
            mail = parse_email(msg.raw)
        except Exception as exc:
            log.warning("[%s] kunne ikke parse UID %s: %s", acc.email, msg.uid, exc)
            continue

        if cfg.filter_domains and domains and domain_of(mail.from_email) not in domains:
            log.info("[%s] hopper over ikke-overvåket avsender: %s", acc.email, mail.from_email)
            store.record_skipped(domain_of(mail.from_email), mail.from_email, mail.subject)
            continue

        chash = content_hash(mail)
        if store.request_exists(mail.message_id, chash):
            log.info("[%s] hopper over duplikat: %s", acc.email, mail.subject)
            continue

        request_id = _store_request(store, mail, chash, account_id)
        if not request_id:
            log.warning("[%s] fikk ingen request_id for UID %s", acc.email, msg.uid)
            continue

        _store_attachments(store, request_id, mail)
        try:
            candidates = store.open_candidates(request_id)
            result = scorer.score(areas, consultants, mail.subject or "", mail.body_text or "",
                                  examples, candidates)
            _store_scores(store, request_id, areas, consultants, result)
            if result.same_opportunity_id:
                store.link_same_opportunity(request_id, result.same_opportunity_id)
            log.info("[%s] scoret '%s' → %s (%d)%s", acc.email, (mail.subject or "")[:50],
                     result.best_area_key, result.total_score,
                     " [samme oppdrag]" if result.same_opportunity_id else "")
        except Exception as exc:
            log.error("[%s] scoring feilet for %s: %s", acc.email, request_id, exc)
            store.mark_request_error(request_id)
        processed += 1

    if highest > last_uid:
        store.set_last_uid(key, highest)
    store.touch_account(acc.email)
    return processed


def process_gmail(
    cfg: Config, store: Store, scorer: Scorer, areas, consultants, domains, conn, examples=None,
) -> int:
    """Hent nye broker-e-poster fra én brukerkoblet Gmail-konto (OAuth)."""
    if not (cfg.google_client_id and cfg.google_client_secret):
        raise ConfigError("GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET mangler – kan ikke hente Gmail.")
    email = conn.get("email") or ""
    account_id = store.inbox_account_id(email)  # som regel None for Gmail-kontoer
    token = access_token(cfg.google_client_id, cfg.google_client_secret, conn["refresh_token"])
    query = build_query(domains if cfg.filter_domains else None, POLL_LOOKBACK_DAYS)
    ids = list_message_ids(token, query, cfg.max_fetch)
    log.info("[gmail:%s] %d melding(er) matcher søk (%s)", email, len(ids), query)

    processed = 0
    for mid in ids:
        try:
            mail = parse_email(get_raw(token, mid))
        except Exception as exc:
            log.warning("[gmail:%s] kunne ikke hente/parse %s: %s", email, mid, exc)
            continue

        if cfg.filter_domains and domains and domain_of(mail.from_email) not in domains:
            store.record_skipped(domain_of(mail.from_email), mail.from_email, mail.subject)
            continue

        chash = content_hash(mail)
        if store.request_exists(mail.message_id, chash):
            continue

        request_id = _store_request(store, mail, chash, account_id)
        if not request_id:
            continue

        _store_attachments(store, request_id, mail)
        try:
            candidates = store.open_candidates(request_id)
            result = scorer.score(areas, consultants, mail.subject or "", mail.body_text or "",
                                  examples, candidates)
            _store_scores(store, request_id, areas, consultants, result)
            if result.same_opportunity_id:
                store.link_same_opportunity(request_id, result.same_opportunity_id)
            log.info("[gmail:%s] scoret '%s' → %s (%d)", email, (mail.subject or "")[:50],
                     result.best_area_key, result.total_score)
        except Exception as exc:
            log.error("[gmail:%s] scoring feilet for %s: %s", email, request_id, exc)
            store.mark_request_error(request_id)
        processed += 1

    store.update_gmail_sync(conn["user_id"], ok=True)
    return processed


def run() -> int:
    try:
        cfg = Config.from_env()
    except ConfigError as exc:
        log.error(str(exc))
        return 2

    store = Store(cfg.supabase_url, cfg.supabase_key, cfg.storage_bucket)
    scorer = Scorer(cfg.anthropic_api_key, cfg.anthropic_model)

    areas = store.service_areas()
    if not areas:
        log.error("Ingen tjenesteområder i databasen — kjør seeding først.")
        return 2
    consultants = store.consultants()
    domains = store.sender_domains()
    examples = store.category_examples()
    log.info("%d tjenesteområder, %d konsulenter, %d overvåkede domener, %d konto(er), %d kategori-eksempler",
             len(areas), len(consultants), len(domains), len(cfg.accounts), len(examples))

    total = 0
    for acc in cfg.accounts:
        try:
            total += process_account(cfg, store, scorer, areas, consultants, domains, acc, examples)
        except Exception as exc:
            log.error("[%s] konto feilet: %s", acc.email, exc)

    # Brukerkoblede Gmail-postkasser (selvbetjent OAuth)
    conns = store.gmail_connections()
    log.info("%d brukerkoblet Gmail-konto(er)", len(conns))
    for c in conns:
        try:
            total += process_gmail(cfg, store, scorer, areas, consultants, domains, c, examples)
        except Exception as exc:
            log.error("[gmail:%s] konto feilet: %s", c.get("email"), exc)
            try:
                store.update_gmail_sync(c["user_id"], ok=False, error=str(exc)[:500])
            except Exception:
                pass

    try:
        pending = score_pending(store, scorer, areas, consultants, examples)
    except Exception as exc:
        pending = 0
        log.error("Scoring av ventende feilet: %s", exc)

    log.info("Ferdig. Behandlet %d ny(e) + scoret %d ventende forespørsel(er).", total, pending)
    return 0


if __name__ == "__main__":
    sys.exit(run())
