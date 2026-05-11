"""
backfill_run_dynamics.py
------------------------
Vult missende hardloop-dynamics in voor de afgelopen N dagen.
Haalt per run de summaryDTO op en schrijft cadans, grondcontact,
verticale oscillatie, verticale ratio, stap-lengte, training-effect
en loopvermogen terug naar Google Sheets.

Gebruik:
  cd /Users/gertkornet/Projects/Gkoach/backend
  python backfill_run_dynamics.py           # laatste 30 dagen
  python backfill_run_dynamics.py 60        # laatste 60 dagen
"""

import os, sys, json, datetime, time
from dotenv import load_dotenv

load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "..", ".env"))
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), ".env"), override=False)

GARMIN_EMAIL    = os.getenv("GARMIN_EMAIL")
GARMIN_PASSWORD = os.getenv("GARMIN_PASSWORD")
SHEET_ID        = os.getenv("GOOGLE_SHEET_ID")
SERVICE_ACCOUNT = os.getenv("GOOGLE_SERVICE_ACCOUNT_JSON")
SHEET_TAB       = os.getenv("SHEET_TAB_NAME", "coach_data")
TOKEN_STORE     = os.path.join(os.path.dirname(__file__), ".garmin_tokens")

DAYS_BACK = int(sys.argv[1]) if len(sys.argv) > 1 else 30

TODAY     = datetime.date.today()
START     = TODAY - datetime.timedelta(days=DAYS_BACK)

RUNNING_TYPES = {"running", "trail_running", "treadmill_running", "track_running"}


def fetch_run_dynamics(client, activity_id):
    """Haal summaryDTO op en retourneer running dynamics dict."""
    details = client.get_activity(activity_id)
    s = details.get("summaryDTO", {})

    cad = s.get("averageRunCadence")
    gc  = s.get("groundContactTime")
    vo  = s.get("verticalOscillation")   # al in cm
    vr  = s.get("verticalRatio")
    sl  = s.get("strideLength")           # in cm → /100 = m
    pw  = s.get("averagePower")

    return {
        "cadence":         round(cad) if cad else "",
        "ground_contact":  round(gc)  if gc  else "",
        "vertical_osc":    round(vo, 1) if vo else "",
        "vertical_ratio":  round(vr, 1) if vr else "",
        "stride_length":   round(sl / 100, 2) if sl else "",
        "training_effect": s.get("trainingEffectLabel", ""),
        "run_power":       round(pw) if pw else "",
    }


def main():
    print(f"\n{'='*55}")
    print(f"  Backfill run dynamics — {START} t/m {TODAY}")
    print(f"{'='*55}\n")

    # ── Garmin inloggen ───────────────────────────────────────────────────────
    from garminconnect import Garmin
    client = Garmin(GARMIN_EMAIL, GARMIN_PASSWORD)
    client.login(tokenstore=TOKEN_STORE)
    print("✓ Ingelogd bij Garmin Connect\n")

    # ── Alle hardloopactiviteiten ophalen ────────────────────────────────────
    print(f"Hardloopactiviteiten ophalen ({START} → {TODAY})...")
    activities = client.get_activities_by_date(
        START.isoformat(), TODAY.isoformat(), activitytype="running"
    )
    print(f"  {len(activities)} hardloopactiviteiten gevonden\n")

    if not activities:
        print("Niets te verwerken.")
        return

    # ── Google Sheets verbinden ───────────────────────────────────────────────
    import gspread
    from google.oauth2.service_account import Credentials
    scopes = [
        "https://www.googleapis.com/auth/spreadsheets",
        "https://www.googleapis.com/auth/drive"
    ]
    creds = Credentials.from_service_account_file(SERVICE_ACCOUNT, scopes=scopes)
    gc    = gspread.authorize(creds)
    sh    = gc.open_by_key(SHEET_ID)
    ws    = sh.worksheet(SHEET_TAB)

    all_values   = ws.get_all_values()
    sheet_headers = [h.strip().lower() for h in all_values[0]]

    def col_idx(name):
        try:
            return sheet_headers.index(name) + 1   # 1-indexed
        except ValueError:
            return None

    # Kolom-indices voor de velden die we bijwerken
    fields = ["cadence", "ground_contact", "vertical_osc", "vertical_ratio",
              "stride_length", "training_effect", "run_power"]
    col_map = {f: col_idx(f) for f in fields}
    date_col = col_idx("date")

    missing = [f for f, c in col_map.items() if c is None]
    if missing:
        print(f"⚠  Kolommen niet gevonden in sheet: {missing}")
        print("   Voer eerst cleanup_sheet.py uit om de header-rij bij te werken.")
        return

    # Bouw datum → rijnummer map (rij 1 = headers, data vanaf rij 2)
    date_to_row = {}
    for i, row in enumerate(all_values[1:], start=2):
        d = row[date_col - 1].strip() if len(row) >= date_col else ""
        if d:
            date_to_row[d] = i

    print(f"Sheet heeft {len(date_to_row)} datumrijen\n")

    # ── Per activiteit: dynamics ophalen en terugschrijven ───────────────────
    updated = 0
    skipped = 0

    for act in activities:
        act_date = act.get("startTimeLocal", "")[:10]
        act_id   = act.get("activityId")
        act_type = act.get("activityType", {}).get("typeKey", "")

        if act_date not in date_to_row:
            print(f"  ⚠ {act_date}: geen rij in sheet gevonden — overgeslagen")
            skipped += 1
            continue

        row_num = date_to_row[act_date]

        print(f"  {act_date} (rij {row_num}) — {act_type} — ophalen...")
        try:
            dyn = fetch_run_dynamics(client, act_id)
        except Exception as e:
            print(f"    ✗ Fout: {e}")
            skipped += 1
            continue

        print(f"    cadans={dyn['cadence']} spm  GCT={dyn['ground_contact']} ms  "
              f"V.osc={dyn['vertical_osc']} cm  vermogen={dyn['run_power']} W  "
              f"effect={dyn['training_effect']}")

        # Batch-update: alle velden in één API-call per rij
        cell_updates = []
        for field, val in dyn.items():
            col = col_map.get(field)
            if col is None:
                continue
            cell_updates.append({
                "range": gspread.utils.rowcol_to_a1(row_num, col),
                "values": [[val]],
            })
        if cell_updates:
            ws.batch_update(cell_updates, value_input_option="USER_ENTERED")

        updated += 1
        time.sleep(2.0)   # rustiger rate-limit voor Garmin + Sheets

    print(f"\n{'='*55}")
    print(f"✅ Klaar: {updated} runs bijgewerkt, {skipped} overgeslagen")
    print(f"   Je kunt de app nu herladen om de data te zien.")


if __name__ == "__main__":
    if not all([GARMIN_EMAIL, GARMIN_PASSWORD, SHEET_ID, SERVICE_ACCOUNT]):
        print("FOUT: Stel GARMIN_EMAIL, GARMIN_PASSWORD, GOOGLE_SHEET_ID en "
              "GOOGLE_SERVICE_ACCOUNT_JSON in je .env bestand in")
        sys.exit(1)
    main()
