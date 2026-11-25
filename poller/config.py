"""Konfigurasjon lest fra miljøvariabler.

Ingen hemmeligheter i koden. Flere postkasser støttes via IMAP_ACCOUNTS (JSON);
ellers brukes de enkle IMAP_*-variablene som én konto.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field


class ConfigError(RuntimeError):
    pass


def _req(name: str) -> str:
    val = os.getenv(name)
    if not val:
        raise ConfigError(f"Mangler påkrevd miljøvariabel: {name}")
    return val


@dataclass
class ImapAccount:
    email: str
    host: str
    user: str
    password: str
    port: int = 993
    mailbox: str = "INBOX"


@dataclass
class Config:
    accounts: list[ImapAccount]
    supabase_url: str
    supabase_key: str
    storage_bucket: str
    anthropic_api_key: str
    anthropic_model: str
    max_fetch: int
    google_client_id: str | None = None
    google_client_secret: str | None = None
    filter_domains: bool = True  # hopp over avsendere utenfor sender_domains

    @classmethod
    def from_env(cls) -> "Config":
        accounts: list[ImapAccount] = []
        raw = os.getenv("IMAP_ACCOUNTS")
        if raw:
            try:
                for a in json.loads(raw):
                    accounts.append(
                        ImapAccount(
                            email=a["email"],
                            host=a["host"],
                            user=a.get("user", a["email"]),
                            password=a["password"],
                            port=int(a.get("port", 993)),
                            mailbox=a.get("mailbox", "INBOX"),
                        )
                    )
            except (json.JSONDecodeError, KeyError) as exc:
                raise ConfigError(f"Ugyldig IMAP_ACCOUNTS: {exc}") from exc
        elif os.getenv("IMAP_USER"):
            # Valgfri felles-postkasse via klassisk IMAP (brukerkoblede Gmail-kontoer
            # håndteres via gmail_connections i databasen, ikke her).
            user = _req("IMAP_USER")
            accounts.append(
                ImapAccount(
                    email=user,
                    host=_req("IMAP_HOST"),
                    user=user,
                    password=_req("IMAP_PASSWORD"),
                    port=int(os.getenv("IMAP_PORT", "993")),
                    mailbox=os.getenv("IMAP_MAILBOX", "INBOX"),
                )
            )

        return cls(
            accounts=accounts,
            supabase_url=_req("SUPABASE_URL"),
            supabase_key=_req("SUPABASE_SERVICE_ROLE_KEY"),
            storage_bucket=os.getenv("STORAGE_BUCKET", "attachments"),
            anthropic_api_key=_req("ANTHROPIC_API_KEY"),
            anthropic_model=os.getenv("ANTHROPIC_MODEL", "claude-opus-5-5"),
            max_fetch=int(os.getenv("MAX_FETCH", "50")),
            google_client_id=os.getenv("GOOGLE_CLIENT_ID") or None,
            google_client_secret=os.getenv("GOOGLE_CLIENT_SECRET") or None,
            filter_domains=os.getenv("FILTER_DOMAINS", "true").lower() != "false",
        )
