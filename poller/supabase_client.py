"""Alt databasearbeid mot Supabase (Postgres + Storage).

Bruker service_role-nøkkelen og omgår RLS. Kjøres kun server-side.
"""
from __future__ import annotations

import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from supabase import Client, create_client

_ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _iso_or_none(v: str | None) -> str | None:
    return v if (v and _ISO_DATE.match(v)) else None


class Store:
    def __init__(self, url: str, key: str, bucket: str):
        self.client: Client = create_client(url, key)
        self.bucket = bucket

    # --- Oppslag ---
    def service_areas(self) -> list[dict[str, Any]]:
        res = (
            self.client.table("service_areas")
            .select("id, key, name, description, subitems")
            .eq("active", True)
            .order("sort_order")
            .execute()
        )
        return res.data or []

    def consultants(self) -> list[dict[str, Any]]:
        res = (
            self.client.table("consultants")
            .select("id, name, title, skills, keywords, summary")
            .eq("available", True)
            .execute()
        )
        return res.data or []

    def pending_requests(self, limit: int = 20) -> list[dict[str, Any]]:
        """Uscorede forespørsler (f.eks. manuelt importerte) som venter på scoring."""
        res = (
            self.client.table("requests")
            .select("id, subject, title, body_text")
            .is_("scored_at", "null")
            .eq("status", "ny")
            .limit(limit)
            .execute()
        )
        return res.data or []

    def record_skipped(self, domain: str, from_email: str | None, subject: str | None) -> None:
        """Logg et avsender-domene som ble filtrert bort (for UI-et «Hoppet over»)."""
        if not domain:
            return
        try:
            self.client.rpc("record_skipped_sender", {
                "p_domain": domain, "p_from": from_email, "p_subject": subject,
            }).execute()
        except Exception:
            pass

    def open_candidates(self, exclude_id: str, days: int = 30, limit: int = 40) -> list[dict[str, Any]]:
        """Nylige forespørsler (ekskl. den aktuelle) – kandidater for «samme oppdrag»."""
        cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
        res = (
            self.client.table("requests")
            .select("id, subject, title, org_name, from_email, deadline, opportunity_group_id")
            .neq("id", exclude_id)
            .gte("received_at", cutoff)
            .order("received_at", desc=True)
            .limit(limit)
            .execute()
        )
        return res.data or []

    def category_examples(self, limit: int = 40) -> list[dict[str, Any]]:
        """Teamets korrigeringer (klar/mulig) som few-shot til klassifiseringen."""
        res = (
            self.client.table("category_feedback")
            .select("subject, body_excerpt, category")
            .order("created_at", desc=True)
            .limit(limit)
            .execute()
        )
        return res.data or []

    def sender_domains(self) -> set[str]:
        res = (
            self.client.table("sender_domains")
            .select("domain")
            .eq("active", True)
            .execute()
        )
        return {d["domain"].lower() for d in (res.data or [])}

    def inbox_account_id(self, email: str) -> str | None:
        res = (
            self.client.table("inbox_accounts")
            .select("id")
            .eq("email", email)
            .limit(1)
            .execute()
        )
        return res.data[0]["id"] if res.data else None

    def touch_account(self, email: str) -> None:
        self.client.table("inbox_accounts").update(
            {"last_sync": datetime.now(timezone.utc).isoformat()}
        ).eq("email", email).execute()

    # --- Tilstand (siste UID per konto+mappe) ---
    def get_last_uid(self, mailbox: str) -> int:
        res = (
            self.client.table("ingest_state")
            .select("last_uid")
            .eq("mailbox", mailbox)
            .limit(1)
            .execute()
        )
        return int(res.data[0]["last_uid"]) if res.data else 0

    def set_last_uid(self, mailbox: str, last_uid: int) -> None:
        self.client.table("ingest_state").upsert(
            {
                "mailbox": mailbox,
                "last_uid": last_uid,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            },
            on_conflict="mailbox",
        ).execute()

    # --- Dublettkontroll ---
    def request_exists(self, message_id: str | None, content_hash: str | None) -> bool:
        if message_id:
            r = (
                self.client.table("requests")
                .select("id")
                .eq("message_id", message_id)
                .limit(1)
                .execute()
            )
            if r.data:
                return True
        if content_hash:
            r = (
                self.client.table("requests")
                .select("id")
                .eq("content_hash", content_hash)
                .limit(1)
                .execute()
            )
            if r.data:
                return True
        return False

    # --- Skriv ---
    def insert_request(self, payload: dict[str, Any]) -> str | None:
        res = self.client.table("requests").insert(payload).execute()
        return res.data[0]["id"] if res.data else None

    def update_request_scoring(
        self,
        request_id: str,
        best_area_id: str | None,
        total_score: int,
        domain: str | None = None,
        title: str | None = None,
        subarea: str | None = None,
    ) -> None:
        self.client.table("requests").update(
            {
                "best_area_id": best_area_id,
                "total_score": total_score,
                "domain": domain,
                "title": title,
                "subarea": subarea,
                "scored_at": datetime.now(timezone.utc).isoformat(),
            }
        ).eq("id", request_id).execute()

    def update_request_location(self, request_id: str, locations: list[str] | None) -> None:
        self.client.table("requests").update(
            {"locations": locations or []}
        ).eq("id", request_id).execute()

    def link_same_opportunity(self, request_id: str, matched_id: str) -> None:
        """Knytt request_id til samme oppdragsgruppe som matched_id."""
        if not matched_id or matched_id == request_id:
            return
        m = (
            self.client.table("requests")
            .select("opportunity_group_id")
            .eq("id", matched_id)
            .limit(1)
            .execute()
        )
        if not m.data:
            return
        gid = m.data[0].get("opportunity_group_id")
        if not gid:
            gid = str(uuid.uuid4())
            self.client.table("requests").update(
                {"opportunity_group_id": gid}
            ).eq("id", matched_id).execute()
        self.client.table("requests").update(
            {"opportunity_group_id": gid}
        ).eq("id", request_id).execute()

    def set_customer(self, request_id: str, customer: str | None) -> None:
        if customer:
            self.client.table("requests").update(
                {"org_name": customer}
            ).eq("id", request_id).execute()

    def update_request_engagement(
        self, request_id: str, start_date: str | None, duration: str | None,
        assumed_product: str | None, start_iso: str | None = None, end_iso: str | None = None,
    ) -> None:
        self.client.table("requests").update(
            {
                "start_date": start_date or None,
                "duration": duration or None,
                "assumed_product": assumed_product or None,
                "start_iso": _iso_or_none(start_iso),
                "end_iso": _iso_or_none(end_iso),
            }
        ).eq("id", request_id).execute()

    def update_request_category(
        self, request_id: str, category: str, confidence: int, reasoning: str | None
    ) -> None:
        # Rør aldri en kategori brukeren har overstyrt manuelt.
        self.client.table("requests").update(
            {
                "category": category,
                "category_confidence": confidence,
                "category_reasoning": reasoning,
            }
        ).eq("id", request_id).eq("category_overridden", False).execute()

    def mark_request_error(self, request_id: str) -> None:
        self.client.table("requests").update({"status": "feil"}).eq(
            "id", request_id
        ).execute()

    def insert_match_scores(self, rows: list[dict[str, Any]]) -> None:
        if rows:
            self.client.table("match_scores").upsert(
                rows, on_conflict="request_id,service_area_id"
            ).execute()

    def insert_consultant_matches(self, rows: list[dict[str, Any]]) -> None:
        if rows:
            self.client.table("consultant_matches").upsert(
                rows, on_conflict="request_id,consultant_id"
            ).execute()

    # --- Vedlegg ---
    def upload_attachment(
        self, request_id: str, filename: str, content_type: str, data: bytes
    ) -> str:
        path = f"{request_id}/{filename}"
        self.client.storage.from_(self.bucket).upload(
            path,
            data,
            {"content-type": content_type or "application/octet-stream", "upsert": "true"},
        )
        return path

    def insert_attachment(
        self, request_id: str, filename: str, content_type: str, size: int, path: str
    ) -> None:
        self.client.table("attachments").insert(
            {
                "request_id": request_id,
                "filename": filename,
                "content_type": content_type,
                "size_bytes": size,
                "storage_path": path,
            }
        ).execute()
