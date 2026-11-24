"""LLM-basert match: tjenesteområder + konsulenter, i ett kall.

Claude leser emne + brødtekst og gir:
  - score (0–100) + begrunnelse per tjenesteområde, beste område, totalscore
  - match (0–100) + begrunnelse per konsulent (mot masterCV)
Strukturert output (json_schema) sikrer gyldig JSON.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any

import anthropic

MAX_BODY_CHARS = 8000
DOMAIN_LEVELS = ["svak", "middels", "sterk", "veldig_sterk"]
MAX_CONSULTANTS = 25  # antall konsulenter KI-en vurderer per forespørsel
_WORD = re.compile(r"[a-zæøå0-9]{3,}")


def shortlist_consultants(consultants, subject, body, n=MAX_CONSULTANTS):
    """Grov forhåndsutvelgelse på nøkkelord-overlapp, så KI-kallet holder seg
    bundet selv med hundrevis av konsulenter. KI-en gjør den nyanserte
    vurderingen på kortlista."""
    if len(consultants) <= n:
        return consultants
    qwords = set(_WORD.findall(f"{subject} {body}".lower()))
    if not qwords:
        return consultants[:n]

    def overlap(c):
        bag = " ".join([
            c.get("title") or "",
            " ".join(c.get("skills") or []),
            " ".join(c.get("keywords") or []),
            c.get("summary") or "",
        ]).lower()
        return len(qwords & set(_WORD.findall(bag)))

    return sorted(consultants, key=overlap, reverse=True)[:n]

SYSTEM_PROMPT = """Du er analytiker hos konsulentselskapet Figment (del av Sonatgruppen).
Du vurderer innkomne oppdragsforespørsler fra brokere mot (1) Figments \
tjenesteområder, (2) aktuelle konsulenter og (3) domene (bransje/sektor).

For hvert tjenesteområde: gi en score 0–100 for hvor godt oppdraget passer, med kort \
begrunnelse på norsk. Vær nøktern – høy score kun ved tydelig match. Sett total_score \
til hvor relevant oppdraget er for Figment samlet (typisk høyeste områdescore), og \
best_area_key til beste område.

Fastsett en kort OPPDRAGSTITTEL (rolle/stilling) hentet fra epostens INNHOLD, ikke \
nødvendigvis emnefeltet – f.eks. «Senior prosjektleder – ERP-innføring». Broker-eposter \
har ofte generiske emner mens den reelle rollen står i teksten. Inneholder eposten flere \
roller, velg den mest sentrale. Er det ikke et konkret oppdrag, lag en kort beskrivende tittel.

Fastsett oppdragets DOMENE (kort norsk etikett for bransje/sektor), f.eks. \
«Offentlig sektor – helse», «Offentlig forvaltning», «Bank og finans», «Energi», \
«Industri», «Transport».

Avgjør KATEGORI for e-posten:
- «klar»: e-posten er helt klart en konkret oppdragsforespørsel – en navngitt rolle \
eller et konkret oppdrag en broker søker å fylle, med nok innhold til å vurderes.
- «mulig»: e-posten KAN være en forespørsel, men er usikker – automatiske jobbvarsler \
og digester (f.eks. «new jobs published»), nyhetsbrev, generiske massehenvendelser, \
vage forespørsler, eller noe som like gjerne kan være støy eller feil.
Sett category_confidence (0–100) for hvor sikker du er, og en kort norsk \
category_reasoning. Finnes det eksempler fra teamet nedenfor, vekt dem tungt – de \
viser hvordan liknende e-poster faktisk skal kategoriseres.

Fastsett LOKASJON for oppdraget som en liste (locations): norske bynavn der \
oppdraget skal utføres (f.eks. «Oslo», «Bergen», «Trondheim»), og i tillegg \
«Remote» og/eller «Hybrid» der det er aktuelt. Tom liste hvis stedet ikke framgår.

Er det listet opp andre åpne forespørsler under «Andre åpne forespørsler», vurder \
om DENNE e-posten gjelder NØYAKTIG samme underliggende oppdrag (samme rolle hos \
samme sluttkunde) som en av dem – brokere sender ofte ut samme oppdrag. I så fall, \
sett same_opportunity_id til id-en til den matchende forespørselen. Er det ikke \
samme oppdrag, sett tom streng.

For hver konsulent: gi (a) en match 0–100 for hvor godt konsulenten passer oppdraget \
basert på rolle, ferdigheter og erfaring i masterCV-en, og (b) en domenematch – hvor \
godt konsulentens domenekunnskap (fra CV/erfaring) passer oppdragets domene – på en \
firetrinns skala: svak, middels, sterk, veldig_sterk. Gi kort, faktabasert begrunnelse \
for begge (bruk fornavn, ingen selgende prosa)."""


@dataclass
class AreaScore:
    area_key: str
    score: int
    reasoning: str


@dataclass
class ConsultantScore:
    consultant_id: str
    match: int
    reasoning: str
    domain_level: str | None = None
    domain_reasoning: str = ""


@dataclass
class ScoringResult:
    scores: list[AreaScore]
    best_area_key: str
    total_score: int
    title: str = ""
    domain: str = ""
    category: str = "mulig"
    category_confidence: int = 0
    category_reasoning: str = ""
    locations: list[str] = field(default_factory=list)
    same_opportunity_id: str = ""
    consultants: list[ConsultantScore] = field(default_factory=list)
    summary: str = ""


def _areas_block(areas: list[dict[str, Any]]) -> str:
    out = []
    for a in areas:
        subs = ", ".join(a.get("subitems") or [])
        out.append(
            f"- nøkkel: {a['key']}\n  navn: {a['name']}\n"
            f"  beskrivelse: {a['description']}\n  underpunkter: {subs}"
        )
    return "\n".join(out)


def _cons_block(cons: list[dict[str, Any]]) -> str:
    out = []
    for c in cons:
        skills = ", ".join(c.get("skills") or [])
        kws = ", ".join(c.get("keywords") or [])
        out.append(
            f"- id: {c['id']}\n  navn: {c['name']}\n  rolle: {c.get('title','')}\n"
            f"  ferdigheter: {skills}\n  nøkkelord (hele CV, inkl. prosjekter): {kws}\n"
            f"  sammendrag: {c.get('summary','')}"
        )
    return "\n".join(out)


def _examples_block(examples: list[dict[str, Any]]) -> str:
    out = []
    for e in examples:
        excerpt = (e.get("body_excerpt") or "").replace("\n", " ")[:300]
        out.append(
            f"- KATEGORI: {e['category']}\n  Emne: {e.get('subject','') or ''}\n"
            f"  Utdrag: {excerpt}"
        )
    return "\n".join(out)


def _candidates_block(candidates: list[dict[str, Any]]) -> str:
    out = []
    for c in candidates:
        out.append(
            f"- id: {c['id']}\n  tittel: {c.get('title') or c.get('subject') or ''}\n"
            f"  foretak: {c.get('org_name') or ''}\n  broker: {c.get('from_email') or ''}\n"
            f"  frist: {c.get('deadline') or ''}"
        )
    return "\n".join(out)


def _schema(area_keys: list[str], cons_ids: list[str],
            candidate_ids: list[str] | None = None) -> dict[str, Any]:
    props: dict[str, Any] = {
        "scores": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "area_key": {"type": "string", "enum": area_keys},
                    "score": {"type": "integer"},
                    "reasoning": {"type": "string"},
                },
                "required": ["area_key", "score", "reasoning"],
                "additionalProperties": False,
            },
        },
        "best_area_key": {"type": "string", "enum": area_keys},
        "total_score": {"type": "integer"},
        "title": {"type": "string"},
        "domain": {"type": "string"},
        "category": {"type": "string", "enum": ["klar", "mulig"]},
        "category_confidence": {"type": "integer"},
        "category_reasoning": {"type": "string"},
        "locations": {"type": "array", "items": {"type": "string"}},
        "same_opportunity_id": {"type": "string", "enum": [""] + (candidate_ids or [])},
        "summary": {"type": "string"},
    }
    required = ["scores", "best_area_key", "total_score", "title", "domain",
                "category", "category_confidence", "category_reasoning",
                "locations", "same_opportunity_id", "summary"]
    if cons_ids:
        props["consultants"] = {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "consultant_id": {"type": "string", "enum": cons_ids},
                    "match": {"type": "integer"},
                    "reasoning": {"type": "string"},
                    "domain_level": {"type": "string", "enum": DOMAIN_LEVELS},
                    "domain_reasoning": {"type": "string"},
                },
                "required": ["consultant_id", "match", "reasoning", "domain_level", "domain_reasoning"],
                "additionalProperties": False,
            },
        }
        required.append("consultants")
    return {
        "type": "json_schema",
        "schema": {
            "type": "object",
            "properties": props,
            "required": required,
            "additionalProperties": False,
        },
    }


class Scorer:
    def __init__(self, api_key: str, model: str):
        self.client = anthropic.Anthropic(api_key=api_key)
        self.model = model

    def score(
        self,
        areas: list[dict[str, Any]],
        consultants: list[dict[str, Any]],
        subject: str,
        body_text: str,
        examples: list[dict[str, Any]] | None = None,
        candidates: list[dict[str, Any]] | None = None,
    ) -> ScoringResult:
        body = (body_text or "")[:MAX_BODY_CHARS]
        consultants = shortlist_consultants(consultants, subject, body)
        candidates = candidates or []
        area_keys = [a["key"] for a in areas]
        cons_ids = [c["id"] for c in consultants]
        candidate_ids = [c["id"] for c in candidates]

        parts = [
            "Figments tjenesteområder:",
            _areas_block(areas),
            "",
        ]
        if consultants:
            parts += ["Aktuelle konsulenter:", _cons_block(consultants), ""]
        if examples:
            parts += [
                "Eksempler på hvordan teamet har kategorisert liknende e-poster "
                "(bruk disse som fasit for klar/mulig):",
                _examples_block(examples),
                "",
            ]
        if candidates:
            parts += [
                "Andre åpne forespørsler (kan være samme oppdrag fra en annen broker):",
                _candidates_block(candidates),
                "",
            ]
        parts += [
            "Innkommen forespørsel:",
            f"Emne: {subject}",
            "",
            f"Tekst:\n{body}",
            "",
            "Score HVERT tjenesteområde"
            + (" og HVER konsulent." if consultants else "."),
        ]
        user_content = "\n".join(parts)

        response = self.client.messages.create(
            model=self.model,
            max_tokens=4000,
            system=SYSTEM_PROMPT,
            output_config={"effort": "low",
                           "format": _schema(area_keys, cons_ids, candidate_ids)},
            messages=[{"role": "user", "content": user_content}],
        )
        text = next((b.text for b in response.content if b.type == "text"), None)
        if not text:
            raise RuntimeError("Scoring ga ingen tekstrespons")
        data = json.loads(text)

        scores = [
            AreaScore(s["area_key"], int(s["score"]), s.get("reasoning", ""))
            for s in data["scores"]
        ]
        cons = [
            ConsultantScore(
                c["consultant_id"], int(c["match"]), c.get("reasoning", ""),
                c.get("domain_level"), c.get("domain_reasoning", ""),
            )
            for c in data.get("consultants", [])
        ]
        return ScoringResult(
            scores=scores,
            best_area_key=data["best_area_key"],
            total_score=int(data["total_score"]),
            title=data.get("title", ""),
            domain=data.get("domain", ""),
            category=data.get("category", "mulig"),
            category_confidence=int(data.get("category_confidence", 0) or 0),
            category_reasoning=data.get("category_reasoning", ""),
            locations=[str(x) for x in (data.get("locations") or []) if str(x).strip()],
            same_opportunity_id=data.get("same_opportunity_id", "") or "",
            consultants=cons,
            summary=data.get("summary", ""),
        )
