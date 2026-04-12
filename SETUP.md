# Coach App — Complete Setup Guide

## Wat je nodig hebt
- GitHub account (gratis)
- Vercel account (gratis)
- Google Cloud account (gratis)
- Python 3.9+ op je laptop
- Node.js 18+ op je laptop

---

## Stap 1 — Project aanmaken

```bash
# Clone of maak de structuur
mkdir coach-app && cd coach-app
git init

# Zet de bestanden neer (zie bijgeleverde bestanden)
# Structuur:
# coach-app/
#   backend/
#     garmin_sync.py
#   frontend/
#     src/App.jsx
#     package.json
#     vite.config.js
#   .github/workflows/garmin_sync.yml
#   .env.example
```

---

## Stap 2 — Google Cloud instellen (15 min)

### 2a. Project aanmaken
1. Ga naar https://console.cloud.google.com
2. Nieuw project → naam: "coach-app"
3. Selecteer het project

### 2b. Google Sheets API aanzetten
1. APIs & Services → Library
2. Zoek "Google Sheets API" → Enable
3. Zoek "Google Drive API" → Enable

### 2c. Service Account aanmaken
1. APIs & Services → Credentials
2. "+ Create Credentials" → Service Account
3. Naam: "coach-sync" → Create
4. Rol: "Editor" → Done
5. Klik op het service account → Keys → Add Key → JSON
6. Sla het JSON bestand op als `backend/service_account.json`

### 2d. Google Sheet delen met service account
1. Open je Google Sheet
2. Deel → voeg het e-mailadres van het service account toe
   (staat in het JSON bestand bij "client_email")
3. Geef "Bewerker" toegang

### 2e. Sheet ID ophalen
URL: `docs.google.com/spreadsheets/d/SHEET_ID_HIER/edit`
Kopieer het gedeelte tussen `/d/` en `/edit`.

---

## Stap 3 — .env aanmaken

```bash
cp .env.example .env
# Vul alle waarden in met je editor
```

Vul in:
- `GARMIN_EMAIL` — je Garmin Connect e-mailadres
- `GARMIN_PASSWORD` — je Garmin wachtwoord
- `GOOGLE_SHEET_ID` — het Sheet ID uit stap 2e
- `GOOGLE_SERVICE_ACCOUNT_JSON` — `./backend/service_account.json`
- `VITE_GOOGLE_SHEET_ID` — zelfde Sheet ID
- `VITE_GOOGLE_SERVICE_ACCOUNT_EMAIL` — "client_email" uit het JSON bestand
- `VITE_GOOGLE_PRIVATE_KEY` — "private_key" uit het JSON bestand

---

## Stap 4 — Python backend testen

```bash
cd backend
pip install garminconnect gspread google-auth python-dotenv

# Eerste keer inloggen (Garmin vraagt mogelijk om 2FA)
python garmin_sync.py
```

Bij de eerste keer vraagt Garmin je mogelijk om een verificatiecode via e-mail.
Daarna worden tokens opgeslagen en werkt het automatisch.

Na succesvolle sync zie je in je Google Sheet een nieuwe rij met de data van vandaag.

---

## Stap 5 — Frontend lokaal testen

```bash
cd frontend
npm install
npm run dev
# Open http://localhost:5173
```

---

## Stap 6 — GitHub repo aanmaken

```bash
# Op GitHub: maak een nieuwe (private) repo aan
git remote add origin https://github.com/JOUW_USERNAME/coach-app.git

# Voeg toe aan .gitignore:
echo ".env" >> .gitignore
echo "backend/service_account.json" >> .gitignore
echo "backend/.garmin_tokens.json" >> .gitignore
echo "node_modules/" >> .gitignore

git add .
git commit -m "Initial coach app"
git push -u origin main
```

---

## Stap 7 — GitHub Secrets instellen

Ga naar GitHub → jouw repo → Settings → Secrets and variables → Actions

Voeg toe:
| Secret | Waarde |
|--------|--------|
| `GARMIN_EMAIL` | jouw@email.com |
| `GARMIN_PASSWORD` | jouwwachtwoord |
| `GOOGLE_SHEET_ID` | jouw sheet ID |
| `GOOGLE_SERVICE_ACCOUNT_JSON_CONTENT` | de volledige inhoud van service_account.json |

Voor de laatste: open `backend/service_account.json`, kopieer de hele inhoud (inclusief `{}`).

---

## Stap 8 — Vercel deployen

1. Ga naar https://vercel.com → New Project
2. Importeer je GitHub repo
3. Root directory: `frontend`
4. Framework: Vite
5. Environment variables toevoegen (zelfde als .env, maar zonder GARMIN vars):
   - `VITE_GOOGLE_SHEET_ID`
   - `VITE_GOOGLE_SERVICE_ACCOUNT_EMAIL`
   - `VITE_GOOGLE_PRIVATE_KEY`
6. Deploy

Je krijgt een URL zoals `coach-app-xyz.vercel.app` — dit is je app.

---

## Stap 9 — Op telefoon installeren

**iPhone (Safari):**
1. Open de Vercel URL in Safari
2. Deel-knop (vierkant met pijl omhoog)
3. "Zet op beginscherm"

**Android (Chrome):**
1. Open de Vercel URL in Chrome
2. Menu (⋮) → "Toevoegen aan startscherm"

---

## Stap 10 — Automatische sync testen

1. Ga naar GitHub → jouw repo → Actions
2. Klik op "Garmin Daily Sync"
3. "Run workflow" → Run
4. Bekijk de logs — je ziet de Garmin data binnenkomen

Daarna draait het elke ochtend automatisch om 06:30.

---

## Troubleshooting

**Garmin inloggen mislukt:**
- Garmin blokkeert soms automatisch inloggen. Wacht 30 min en probeer opnieuw.
- Controleer of je wachtwoord klopt en geen speciale tekens bevat die escaped moeten worden.

**Google Sheets 403 error:**
- Controleer of het service account als bewerker toegang heeft tot het Sheet.
- Controleer of de Sheets API en Drive API zijn ingeschakeld.

**Vercel build mislukt:**
- Controleer of alle VITE_ env vars zijn ingesteld.
- De private key moet `\n` gebruiken voor newlines in Vercel env vars.

---

## Dagelijkse workflow daarna

1. 06:30 — Garmin sync draait automatisch, vult je Sheet
2. 's Ochtends — Open app op telefoon, check je metrics
3. Druk "Coach mij nu" voor je dagelijkse analyse
4. Vul eventueel aan wat Garmin niet meet (alcohol, BP, mentale onrust)
5. Klaar

Totale dagelijkse tijdsinvestering: 2–3 minuten.
