"""Parser rå RFC822-epost til et strukturert dikt vi kan lagre."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from email import message_from_bytes
from email.header import decode_header, make_header
from email.utils import parseaddr, parsedate_to_datetime
from html.parser import HTMLParser


@dataclass
class ParsedAttachment:
    filename: str
    content_type: str
    data: bytes


@dataclass
class ParsedEmail:
    message_id: str | None
    from_email: str
    from_name: str
    to_email: str
    subject: str
    body_text: str
    body_html: str
    received_at: datetime | None
    headers: dict
    attachments: list[ParsedAttachment] = field(default_factory=list)


class _HTMLToText(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self._parts: list[str] = []
        self._skip = False

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self._skip = True
        if tag in ("br", "p", "div", "tr", "li"):
            self._parts.append("\n")

    def handle_endtag(self, tag):
        if tag in ("script", "style"):
            self._skip = False

    def handle_data(self, data):
        if not self._skip:
            self._parts.append(data)

    def text(self) -> str:
        raw = "".join(self._parts)
        lines = [ln.strip() for ln in raw.splitlines()]
        return "\n".join(ln for ln in lines if ln)


def html_to_text(html: str) -> str:
    parser = _HTMLToText()
    try:
        parser.feed(html)
    except Exception:
        return ""
    return parser.text()


def _decode(value: str | None) -> str:
    if not value:
        return ""
    try:
        return str(make_header(decode_header(value)))
    except Exception:
        return value


def parse_email(raw: bytes) -> ParsedEmail:
    msg = message_from_bytes(raw)

    from_name, from_email = parseaddr(_decode(msg.get("From")))
    _, to_email = parseaddr(_decode(msg.get("To")))
    subject = _decode(msg.get("Subject"))
    message_id = (msg.get("Message-ID") or "").strip() or None

    received_at: datetime | None = None
    if msg.get("Date"):
        try:
            received_at = parsedate_to_datetime(msg.get("Date"))
            if received_at and received_at.tzinfo is None:
                received_at = received_at.replace(tzinfo=timezone.utc)
        except Exception:
            received_at = None

    body_text = ""
    body_html = ""
    attachments: list[ParsedAttachment] = []

    if msg.is_multipart():
        for part in msg.walk():
            if part.is_multipart():
                continue
            content_type = part.get_content_type()
            disposition = (part.get("Content-Disposition") or "").lower()
            filename = part.get_filename()
            if filename:
                filename = _decode(filename)

            if "attachment" in disposition or filename:
                payload = part.get_payload(decode=True)
                if payload:
                    attachments.append(
                        ParsedAttachment(
                            filename=filename or "vedlegg",
                            content_type=content_type or "application/octet-stream",
                            data=payload,
                        )
                    )
                continue

            if content_type == "text/plain" and not body_text:
                body_text = _payload_text(part)
            elif content_type == "text/html" and not body_html:
                body_html = _payload_text(part)
    else:
        content_type = msg.get_content_type()
        if content_type == "text/html":
            body_html = _payload_text(msg)
        else:
            body_text = _payload_text(msg)

    if not body_text and body_html:
        body_text = html_to_text(body_html)

    headers = {k: _decode(v) for k, v in msg.items()}

    return ParsedEmail(
        message_id=message_id,
        from_email=from_email,
        from_name=from_name,
        to_email=to_email,
        subject=subject,
        body_text=body_text.strip(),
        body_html=body_html,
        received_at=received_at,
        headers=headers,
        attachments=attachments,
    )


def _payload_text(part) -> str:
    payload = part.get_payload(decode=True)
    if payload is None:
        return ""
    charset = part.get_content_charset() or "utf-8"
    try:
        return payload.decode(charset, errors="replace")
    except (LookupError, ValueError):
        return payload.decode("utf-8", errors="replace")
