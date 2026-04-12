"""
garmin_sync.py
--------------
Haalt dagelijkse Garmin-data op en schrijft het naar Google Sheets.
Draait elke ochtend automatisch via cron of GitHub Actions.

Installatie:
  pip install garminconnect gspread google-auth python-dotenv
"""

import os
import json
import datetime
import time
import sys
from dotenv import load_dotenv

load_dotenv()

# ── Config ────────────────────────────────────────────────────────────────────
GARMIN_EMAIL    = os.getenv("GARMIN_EMAIL")
GARMIN_PASSWORD = os.getenv("GARMIN_PASSWORD")
SHEET_ID        = os.getenv("GOOGLE_SHEET_ID")
SERVICE_ACCOUNT = os.getenv("GOOGLE_SERVICE_ACCOUNT_JSON")  # pad naar JSON file
SHEET_TAB       = os.getenv("SHEET_TAB_NAME", "coach_data")
TOKEN_STORE     = os.path.join(os.path.dirname(__file__), ".garmin_tokens.json")

TODAY = datetime.date.today().isoformat()

# ── Garmin ophalen ────────────────────────────────────────────────────────────
def get_garmin_data():
    from garminconnect import Garmin

    print(f"[{TODAY}] Verbinden met Garmin Connect...")

    # Token-gebaseerd inloggen (voorkomt dat Garmin account geblokkeerd raakt)
    client = Garmin()
    try:
        client.login(TOKEN_STORE)
        print("  ✓ Ingelogd via opgeslagen tokens")
    except Exception:
        print("  → Tokens verlopen of niet aanwezig, opnieuw inloggen...")
        import sys
        is_interactive = sys.stdin.isatty()
        prompt_mfa = (lambda: input("  Voer je Garmin MFA-code in: ")) if is_interactive else None
        client = Garmin(GARMIN_EMAIL, GARMIN_PASSWORD, prompt_mfa=prompt_mfa)
        client.login()
        client.garth.dump(TOKEN_STORE)
        print("  ✓ Nieuw ingelogd en tokens opgeslagen")

    data = {}

    # Slaap
    try:
        sleep = client.get_sleep_data(TODAY)
        daily = sleep.get("dailySleepDTO", {})
        data["sleep_h"]    = round(daily.get("sleepTimeSeconds", 0) / 3600, 2)
        data["sleep_q"]    = daily.get("sleepScores", {}).get("overall", {}).get("value", "")
        data["sleep_deep"] = round(daily.get("deepSleepSeconds", 0) / 3600, 2)
        data["sleep_rem"]  = round(daily.get("remSleepSeconds", 0) / 3600, 2)
        print(f"  ✓ Slaap: {data['sleep_h']}u, score {data['sleep_q']}")
    except Exception as e:
        print(f"  ✗ Slaap: {e}")

    # HRV
    try:
        hrv = client.get_hrv_data(TODAY)
        summary = hrv.get("hrvSummary", {})
        data["hrv"] = summary.get("lastNight5MinHigh", summary.get("lastNight", ""))
        print(f"  ✓ HRV: {data['hrv']} ms")
    except Exception as e:
        print(f"  ✗ HRV: {e}")

    # Rusthartslag + stress + body battery
    try:
        stats = client.get_stats(TODAY)
        data["rhr"]          = stats.get("restingHeartRate", "")
        data["stress"]       = stats.get("averageStressLevel", "")
        data["body_battery"] = stats.get("bodyBatteryChargedValue", "")
        print(f"  ✓ RHR: {data['rhr']}, Stress: {data['stress']}, Battery: {data['body_battery']}")
    except Exception as e:
        print(f"  ✗ Stats: {e}")

    # Stappen + activiteiten
    try:
        steps = client.get_steps_data(TODAY)
        data["steps"] = sum(s.get("steps", 0) for s in steps) if isinstance(steps, list) else ""
        print(f"  ✓ Stappen: {data['steps']}")
    except Exception as e:
        print(f"  ✗ Stappen: {e}")

    # Training van gisteren (activiteiten)
    try:
        yesterday = (datetime.date.today() - datetime.timedelta(days=1)).isoformat()
        activities = client.get_activities_by_date(yesterday, TODAY)
        if activities:
            act = activities[-1]
            data["trained"]    = True
            data["train_type"] = act.get("activityType", {}).get("typeKey", "")
            data["train_min"]  = round(act.get("duration", 0) / 60)
            data["train_dist"] = round(act.get("distance", 0) / 1000, 2)
            print(f"  ✓ Training: {data['train_type']} ({data['train_min']} min)")
        else:
            data["trained"]    = False
            data["train_type"] = ""
    except Exception as e:
        print(f"  ✗ Activiteiten: {e}")

    return data


# ── Google Sheets schrijven ───────────────────────────────────────────────────
def write_to_sheet(garmin_data):
    import gspread
    from google.oauth2.service_account import Credentials

    print(f"\nVerbinden met Google Sheets...")

    scopes = [
        "https://www.googleapis.com/auth/spreadsheets",
        "https://www.googleapis.com/auth/drive"
    ]
    creds = Credentials.from_service_account_file(SERVICE_ACCOUNT, scopes=scopes)
    gc = gspread.authorize(creds)
    sh = gc.open_by_key(SHEET_ID)

    try:
        ws = sh.worksheet(SHEET_TAB)
    except gspread.WorksheetNotFound:
        ws = sh.add_worksheet(title=SHEET_TAB, rows=1000, cols=30)
        # Headers aanmaken
        ws.append_row(HEADERS)
        print(f"  ✓ Nieuw tabblad '{SHEET_TAB}' aangemaakt met headers")

    # Check of vandaag al bestaat
    all_dates = ws.col_values(1)
    if TODAY in all_dates:
        row_idx = all_dates.index(TODAY) + 1
        print(f"  → Rij {row_idx} bijwerken (datum {TODAY} bestaat al)")
        # Alleen Garmin-velden overschrijven, rest bewaren
        existing = ws.row_values(row_idx)
        existing = existing + [""] * (len(HEADERS) - len(existing))
        row = dict(zip(HEADERS, existing))
        row.update({k: v for k, v in garmin_data.items()})
        row["date"] = TODAY
        ws.update(f"A{row_idx}", [list(row.values())])
    else:
        row = {h: "" for h in HEADERS}
        row.update(garmin_data)
        row["date"] = TODAY
        ws.append_row(list(row.values()))
        print(f"  ✓ Nieuwe rij toegevoegd voor {TODAY}")

    print("  ✓ Google Sheets bijgewerkt")


# ── Headers (moeten overeenkomen met de app) ──────────────────────────────────
HEADERS = [
    "date", "weight", "alcohol", "bp_sys", "bp_dia",
    "sleep_h", "sleep_q", "sleep_deep", "sleep_rem",
    "hrv", "rhr", "stress", "body_battery", "steps",
    "trained", "train_type", "train_min", "train_dist",
    "energy", "mental_unrest", "breathing", "breathing_type", "notes"
]


# ── Main ──────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    print(f"\n{'='*50}")
    print(f"  Garmin → Sheets sync — {TODAY}")
    print(f"{'='*50}\n")

    if not GARMIN_EMAIL or not GARMIN_PASSWORD:
        print("FOUT: Stel GARMIN_EMAIL en GARMIN_PASSWORD in in je .env bestand")
        sys.exit(1)

    if not SHEET_ID or not SERVICE_ACCOUNT:
        print("FOUT: Stel GOOGLE_SHEET_ID en GOOGLE_SERVICE_ACCOUNT_JSON in in je .env bestand")
        sys.exit(1)

    try:
        garmin_data = get_garmin_data()
        write_to_sheet(garmin_data)
        print(f"\n✅ Sync voltooid voor {TODAY}")
    except Exception as e:
        print(f"\n❌ Sync mislukt: {e}")
        sys.exit(1)
