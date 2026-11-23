"""Tynn IMAP-klient: henter nye meldinger siden sist behandlede UID."""
from __future__ import annotations

import imaplib
from dataclasses import dataclass


@dataclass
class FetchedMessage:
    uid: int
    raw: bytes


class ImapClient:
    def __init__(self, host: str, port: int, user: str, password: str, mailbox: str):
        self.host = host
        self.port = port
        self.user = user
        self.password = password
        self.mailbox = mailbox
        self._conn: imaplib.IMAP4_SSL | None = None

    def __enter__(self) -> "ImapClient":
        self._conn = imaplib.IMAP4_SSL(self.host, self.port)
        self._conn.login(self.user, self.password)
        self._conn.select(self.mailbox)
        return self

    def __exit__(self, *exc) -> None:
        if self._conn is not None:
            try:
                self._conn.close()
            except Exception:
                pass
            try:
                self._conn.logout()
            except Exception:
                pass
            self._conn = None

    def fetch_since(
        self, last_uid: int, max_fetch: int, since_date: str | None = None
    ) -> list[FetchedMessage]:
        """Hent meldinger med UID > last_uid, NYESTE FØRST, opptil max_fetch.

        since_date (IMAP-format 'DD-Mon-YYYY') begrenser til meldinger mottatt
        på eller etter den datoen — brukes for å kun polle inneværende dag.
        """
        assert self._conn is not None
        start = last_uid + 1
        criteria = f"UID {start}:*"
        if since_date:
            criteria = f"SINCE {since_date} {criteria}"
        typ, data = self._conn.uid("search", None, criteria)
        if typ != "OK" or not data or not data[0]:
            return []

        uids = [int(x) for x in data[0].split()]
        # IMAP kan returnere den høyeste meldingen selv om ingen er > last_uid.
        # Nyeste først (synkende UID).
        uids = sorted((u for u in uids if u >= start), reverse=True)
        if not uids:
            return []
        uids = uids[:max_fetch]

        messages: list[FetchedMessage] = []
        for uid in uids:
            typ, msg_data = self._conn.uid("fetch", str(uid), "(RFC822)")
            if typ != "OK" or not msg_data:
                continue
            raw = None
            for item in msg_data:
                if isinstance(item, tuple) and len(item) == 2:
                    raw = item[1]
                    break
            if raw:
                messages.append(FetchedMessage(uid=uid, raw=raw))
        return messages
