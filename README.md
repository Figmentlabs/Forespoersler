# Brokerforespørsler

Verktøy for å samle inn og jobbe med oppdragsforespørsler fra brokere. Eposter som
sendes til felles adresser hentes inn, lagres, scores mot Figments tjenesteområder og
konsulenter, beriket med foretak/kontakt/relasjon fra Pipedrive, og kvalifiseres (til
Pipedrive) eller avvises etter manuell gjennomgang.

## Arkitektur

```
Broker-eposter ──IMAP──▶ Poller (Python)
   (flere kontoer)          │  domenefilter + dublettsjekk (Message-ID + innhold-hash)
                            ▼
                     Supabase (Postgres + Storage)
                            │  LLM-scoring (Claude): tjeneste% + konsulent%
                            ▼
                   Gjennomgangs-UI (Figment-innlogging)
                     filter på status + lokasjon · anbefalt aksjon
                            │                    │
                        Kvalifiser              Avvis
                            ▼
                  Edge Function «qualify-request»
                  ─▶ Pipedrive deal (Sonat Gruppen → Kvalifisert lead)
```

## Status

| Del | Innhold | Status |
|-----|---------|--------|
| Database | Skjema, tjenesteområder, konsulenter, kontoer, domener, dublett, lokasjon | ✅ |
| Poller | Flere kontoer, domenefilter, innhold-hash-dedup, vedlegg | ✅ Kode |
| Scoring | Tjeneste- + konsulentmatch (Claude, strukturert output) | ✅ Kode |
| RLS | Lesepolicyer for innlogget tilgang | ✅ |
| Pipedrive | `qualify-request` Edge Function (deployet) | ✅ Trenger token |
| Mock-UI | Figment-stil, filtre, anbefaling, relasjon, innstillinger | ✅ Artefakt |
| Innlogging | `user`-kapabilitet i artefakten (som OKR-verktøyet) | ✅ |

Mock-UI (artefakt): kun koden i `ui/review-mock.html`. Selve verktøyet kjører live først
når nøklene under er på plass.

## Supabase

- Prosjekt: **Brokerforesporsler** (`wocrhuiyzrckxihqzrla`), eu-north-1
- URL: `https://wocrhuiyzrckxihqzrla.supabase.co`
- Edge Function: `qualify-request` (krever hemmeligheten `PIPEDRIVE_API_TOKEN`)
- Tabeller: `service_areas`, `requests`, `match_scores`, `consultants`,
  `consultant_matches`, `attachments`, `brokers`, `inbox_accounts`,
  `sender_domains`, `ingest_state`

## Poller

`poller/` – kjøres periodisk (GitHub Actions, se `.github/workflows/poll.yml`).

```bash
cp .env.example .env     # fyll inn hemmeligheter
pip install -r poller/requirements.txt
set -a && source .env && set +a
python poller/run.py
```

Flere kontoer settes via `IMAP_ACCOUNTS` (JSON) – se `.env.example`.

---

## Koblingsliste – hva som skal kobles til, og DINE aksjoner

Anbefalt rekkefølge: **A → B/C → poller live → D (Pipedrive) → E (innlogging)**.

### A. Supabase (opprettet, tilkoblet)
- [ ] **Din aksjon:** Hent `service_role`-nøkkel (Project Settings → API). Hold den hemmelig.
- Min del: RLS-policyer ✅ (allerede satt).

### B. E-postkontoer (IMAP) – kan være flere
- [ ] **Din aksjon:** Bekreft postkassene (f.eks. `broker@figment.no`, `oppdrag@figment.no`)
      og skaff IMAP-host + **app-passord** per konto.
- [ ] **Din aksjon:** Legg inn kontoer og avsenderdomener i Innstillinger (eller gi meg dem).

### C. Anthropic API-nøkkel (matchscore)
- [ ] **Din aksjon:** Lag nøkkel på console.anthropic.com. Modell via `ANTHROPIC_MODEL`
      (`claude-opus-5-5` standard, `claude-haiku-5-5` billigere).

### D. Pipedrive (kvalifisering + relasjonsberikelse)
- [ ] **Din aksjon:** Lag en **API-token** for appen (Pipedrive → innstillinger → API).
- [ ] **Din aksjon:** Sett den som funksjonshemmelighet `PIPEDRIVE_API_TOKEN` i Supabase.
- [ ] Min del: hente «Figment»-taggens option-id, og lage berikelses-funksjon (org/kontakt/relasjon).

### E. Figment-innlogging / brukere
- Artefakten bruker `user`-kapabiliteten ✅ – ingen aksjon for mock-en.
- [ ] **Din beslutning:** egen app i stedet for artefakt? Da settes Supabase Auth med Google
      opp, begrenset til `@figment.no` (krever Google OAuth client-id/secret).

### F. GitHub (poller-cron + kodehosting)
- [ ] **Din aksjon:** Opprett privat repo og gi tilgang. (GitHub-koblingen i økta må
      re-autoriseres via `/mcp` om jeg skal bruke den.)
- [ ] **Din aksjon:** Legg hemmelighetene fra B/C som GitHub Actions secrets.

### G. masterCV for konsulenter
- [ ] **Din aksjon:** Skaff reelle masterCV-er (format?). Fem er seedet som eksempel i dag.

### H. Beslutninger
- [ ] Hvor UI-et skal leve (artefakt vs. egen app)
- [ ] Terskler for anbefalt aksjon, vekting i relasjonsscore, hvilke lokasjoner som er «interessante»
