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
TOKEN_STORE     = os.path.join(os.path.dirname(__file__), ".garmin_tokens")

TODAY = datetime.date.today().isoformat()

# ── Garmin ophalen ────────────────────────────────────────────────────────────
def get_garmin_data():
    from garminconnect import Garmin

    print(f"[{TODAY}] Verbinden met Garmin Connect...")

    # Token-gebaseerd inloggen via ingebouwde tokenstore van garminconnect 0.3.x
    import sys
    token_dir = TOKEN_STORE  # directory waar garminconnect tokens opslaat

    loaded = False
    if os.path.isdir(token_dir) and os.listdir(token_dir):
        try:
            client = Garmin(GARMIN_EMAIL, GARMIN_PASSWORD)
            client.login(tokenstore=token_dir)
            # Test of de sessie nog geldig is
            client.connectapi(f"/usersummary-service/usersummary/daily/{client.display_name}", params={"calendarDate": TODAY})
            print("  ✓ Ingelogd via opgeslagen tokens")
            loaded = True
        except Exception:
            print("  → Tokens verlopen, opnieuw inloggen...")

    if not loaded:
        os.makedirs(token_dir, exist_ok=True)
        is_interactive = sys.stdin.isatty()
        prompt_mfa = (lambda: input("  Voer je Garmin MFA-code in: ")) if is_interactive else None
        client = Garmin(GARMIN_EMAIL, GARMIN_PASSWORD, prompt_mfa=prompt_mfa)
        client.login(tokenstore=token_dir)
        print(f"  ✓ Tokens opgeslagen in {token_dir}")

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

    # HRV — drie waarden
    try:
        hrv = client.get_hrv_data(TODAY)
        summary = hrv.get("hrvSummary", {})
        # Gebruik `or ""` zodat None (Garmin retourneert null als data ontbreekt) ook "" wordt
        data["hrv"]      = summary.get("lastNightAvg")       or ""
        data["hrv_7d"]   = summary.get("weeklyAvg")         or ""
        data["hrv_5min"] = summary.get("lastNight5MinHigh") or ""
        print(f"  ✓ HRV nacht={data['hrv']} 7d={data['hrv_7d']} 5min={data['hrv_5min']} ms")
        print(f"  DEBUG hrv raw summary keys: {list(summary.keys())}")
    except Exception as e:
        print(f"  ✗ HRV: {e}")

    # Rusthartslag + stress + body battery + stappendoel
    try:
        stats = client.get_stats(TODAY)
        data["rhr"]          = stats.get("restingHeartRate", "")
        data["stress"]       = stats.get("averageStressLevel", "")
        data["body_battery"] = stats.get("bodyBatteryChargedValue", "")
        data["step_goal"]    = stats.get("dailyStepGoal", "")
        print(f"  ✓ RHR: {data['rhr']}, Stress: {data['stress']}, Battery: {data['body_battery']}, Stappendoel: {data['step_goal']}")
    except Exception as e:
        print(f"  ✗ Stats: {e}")

    # Stappen + activiteiten
    try:
        steps = client.get_steps_data(TODAY)
        data["steps"] = sum(s.get("steps", 0) for s in steps) if isinstance(steps, list) else ""
        print(f"  ✓ Stappen: {data['steps']}")
    except Exception as e:
        print(f"  ✗ Stappen: {e}")

    # Activiteiten — alle activiteiten van vandaag + hardloop dynamics voor primaire
    WALKING_TYPES = {"walking", "casual_walking"}
    try:
        yesterday = (datetime.date.today() - datetime.timedelta(days=1)).isoformat()
        all_fetched = client.get_activities_by_date(yesterday, TODAY)

        # Filter op alleen activiteiten van vandaag
        def activity_date(a):
            start = a.get("startTimeLocal", a.get("startTimeGMT", ""))
            return str(start)[:10]
        activities = [a for a in all_fetched if activity_date(a) == TODAY]
        # Geen fallback naar gisteren — als er vandaag niets is, blijft trained=False
        print(f"  → {len(all_fetched)} activiteiten opgehaald, {len(activities)} van vandaag ({TODAY})")

        # Sla alle activiteiten op als JSON-lijst
        all_acts = []
        for a in activities:
            t = a.get("activityType", {}).get("typeKey", "")
            dist_km = round(a.get("distance", 0) / 1000, 2)
            all_acts.append({
                "type":  t,
                "name":  a.get("activityName", ""),
                "min":   round(a.get("duration", 0) / 60),
                "dist":  dist_km if dist_km > 0 else None,
                "hr":    a.get("averageHR") or None,
                "id":    a.get("activityId"),
            })
        data["activities"] = json.dumps(all_acts, ensure_ascii=False) if all_acts else ""

        # Primaire training = eerste niet-wandel activiteit, anders eerste van alles
        primary = next((a for a in activities if a.get("activityType", {}).get("typeKey", "") not in WALKING_TYPES), None)
        if primary is None and activities:
            primary = activities[-1]

        if primary:
            ptype = primary.get("activityType", {}).get("typeKey", "")
            data["trained"]    = ptype not in WALKING_TYPES
            data["train_type"] = ptype
            data["train_min"]  = round(primary.get("duration", 0) / 60)
            data["train_dist"] = round(primary.get("distance", 0) / 1000, 2)
            data["avg_hr"]     = primary.get("averageHR", "")
            data["max_hr"]     = primary.get("maxHR", "")

            speed = primary.get("averageSpeed", 0)
            if speed and speed > 0:
                sec_km = 1000 / speed
                data["avg_pace"] = f"{int(sec_km // 60)}:{int(sec_km % 60):02d}"

            if primary.get("activityId") and "run" in ptype.lower():
                try:
                    details = client.get_activity(primary["activityId"])
                    data["cadence"]         = details.get("averageRunningCadenceInStepsPerMinute", "")
                    data["ground_contact"]  = details.get("avgGroundContactTime", "")
                    data["vertical_osc"]    = round(details.get("avgVerticalOscillation", 0) / 10, 1) or ""
                    data["vertical_ratio"]  = details.get("avgVerticalRatio", "")
                    data["stride_length"]   = round(details.get("avgStrideLength", 0) / 100, 2) or ""
                    data["training_effect"] = details.get("trainingEffect", "")
                    print(f"  ✓ Hardloop dynamics: cadans {data['cadence']}, GCT {data['ground_contact']}ms")
                except Exception as e:
                    print(f"  ⚠ Hardloop dynamics: {e}")

            print(f"  ✓ Activiteiten ({len(all_acts)}x): {[a['type'] for a in all_acts]}")
        else:
            data["trained"]    = False
            data["train_type"] = ""
    except Exception as e:
        print(f"  ✗ Activiteiten: {e}")

    # VO2max
    try:
        vo2 = client.get_max_metrics(TODAY)
        if isinstance(vo2, list) and vo2:
            data["vo2max"] = vo2[0].get("generic", {}).get("vo2MaxPreciseValue", "")
            if data["vo2max"]:
                print(f"  ✓ VO2max: {data['vo2max']}")
    except Exception as e:
        print(f"  ⚠ VO2max: {e}")

    return client, data


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
        ws = sh.add_worksheet(title=SHEET_TAB, rows=1000, cols=50)
        ws.append_row(HEADERS)
        print(f"  ✓ Nieuw tabblad '{SHEET_TAB}' aangemaakt met headers")

    # Zorg dat de header-rij (rij 1) altijd overeenkomt met de huidige HEADERS definitie.
    # Dit herstelt kolom-namen die door eerder (de)synchronisatie verschoven of hernoemd zijn.
    import gspread as _gs
    major = int(_gs.__version__.split(".")[0])
    current_headers = ws.row_values(1)
    if current_headers[:len(HEADERS)] != HEADERS:
        if major >= 6:
            ws.update([HEADERS], "A1")
        else:
            ws.update("A1", [HEADERS])
        print(f"  ✓ Header-rij bijgewerkt naar actuele HEADERS ({len(HEADERS)} kolommen)")
    else:
        print(f"  ✓ Header-rij al correct")

    all_dates = ws.col_values(1)

    if TODAY in all_dates:
        row_idx = all_dates.index(TODAY) + 1
        print(f"  → Rij {row_idx} bijwerken (datum {TODAY} bestaat al)")
        existing = ws.row_values(row_idx)
        existing = existing + [""] * (len(HEADERS) - len(existing))
        row = dict(zip(HEADERS, existing))
        row.update({k: v for k, v in garmin_data.items()})
        row["date"] = TODAY
        if major >= 6:
            result = ws.update([list(row.values())], f"A{row_idx}")
        else:
            result = ws.update(f"A{row_idx}", [list(row.values())])
        print(f"  ✓ Rij {row_idx} bijgewerkt (result={result})")
    else:
        row = {h: "" for h in HEADERS}
        row.update(garmin_data)
        row["date"] = TODAY
        print(f"  DEBUG: appending row, date={row['date']}, fields met data={[k for k,v in row.items() if v not in ('', None, False)]}")
        result = ws.append_row(list(row.values()), value_input_option="USER_ENTERED", table_range="A1")
        print(f"  ✓ Nieuwe rij toegevoegd voor {TODAY} (result={result})")

    print("  ✓ Google Sheets bijgewerkt")


# ── Geplande workouts schrijven ───────────────────────────────────────────────
PLANNED_TAB = "planned_workouts"
PLANNED_HEADERS = ["date", "title", "sport", "workout_id"]

def write_planned_workouts(client):
    import gspread
    from google.oauth2.service_account import Credentials

    print(f"\nGeplande workouts ophalen...")

    # Haal komende 2 maanden op
    today_obj = datetime.date.today()
    items = []
    for delta in range(2):
        year = (today_obj.replace(day=1) + datetime.timedelta(days=32 * delta)).year
        month = (today_obj.replace(day=1) + datetime.timedelta(days=32 * delta)).month
        try:
            cal = client.get_scheduled_workouts(year, month)
            for item in cal.get("calendarItems", []):
                if item.get("itemType") == "workout" and item.get("date", "") >= today_obj.isoformat():
                    items.append({
                        "date":       item.get("date", ""),
                        "title":      item.get("title", ""),
                        "sport":      item.get("sportTypeKey", ""),
                        "workout_id": str(item.get("workoutId", "")),
                    })
        except Exception as e:
            print(f"  ⚠ Kalender maand {month}: {e}")

    items.sort(key=lambda x: x["date"])
    print(f"  ✓ {len(items)} geplande workouts gevonden")

    scopes = ["https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/drive"]
    creds = Credentials.from_service_account_file(SERVICE_ACCOUNT, scopes=scopes)
    gc = gspread.authorize(creds)
    sh = gc.open_by_key(SHEET_ID)

    try:
        ws = sh.worksheet(PLANNED_TAB)
        ws.clear()
    except gspread.WorksheetNotFound:
        ws = sh.add_worksheet(title=PLANNED_TAB, rows=200, cols=10)

    ws.append_row(PLANNED_HEADERS)
    for item in items:
        ws.append_row([item[h] for h in PLANNED_HEADERS])
    print(f"  ✓ planned_workouts tab bijgewerkt ({len(items)} rijen)")


# ── Headers (moeten overeenkomen met de app én de Google Sheet kolomvolgorde) ──
# Kolom A-J: datum t/m hrv, dan K=hrv_7d L=hrv_5min (door gebruiker aangemaakt),
# dan M=rhr N=stress O=body_battery P=steps, enz.
HEADERS = [
    "date", "weight", "alcohol", "bp_sys", "bp_dia",          # A–E
    "sleep_h", "sleep_q", "sleep_deep", "sleep_rem",           # F–I
    "hrv", "hrv_7d", "hrv_5min",                               # J–L  ← nieuw
    "rhr", "stress", "body_battery", "steps",                  # M–P
    "trained", "train_type", "train_min", "train_dist",        # Q–T
    "avg_hr", "max_hr", "avg_pace", "cadence",                 # U–X
    "ground_contact", "vertical_osc", "vertical_ratio",        # Y–AA
    "stride_length", "training_effect", "vo2max",              # AB–AD
    "energy", "mental_unrest", "breathing", "breathing_type",  # AE–AH
    "notes", "sleep_prep", "koffie", "mood",                   # AI–AL
    "activities",                                               # AM
    "step_goal",                                               # AN
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

    # Stap 1: Garmin data ophalen (niet fataal als dit mislukt)
    garmin_data = {}
    client = None
    garmin_ok = False
    try:
        client, garmin_data = get_garmin_data()
        garmin_ok = True
        print(f"\n✅ Garmin data opgehaald ({len(garmin_data)} velden)")
    except Exception as e:
        import traceback
        print(f"\n❌ Garmin ophalen mislukt: {e}")
        traceback.print_exc()
        print("  → Ga door met lege Garmin data (rij voor vandaag wordt toch aangemaakt)")

    # Stap 2: Altijd naar Sheets schrijven (zelfs als Garmin leeg is)
    try:
        write_to_sheet(garmin_data)
        print(f"✅ Sheets bijgewerkt voor {TODAY}")
    except Exception as e:
        import traceback
        print(f"\n❌ Sheets schrijven mislukt: {e}")
        traceback.print_exc()
        sys.exit(1)

    # Stap 3: Geplande workouts (alleen als Garmin werkte)
    if client:
        try:
            write_planned_workouts(client)
        except Exception as e:
            print(f"⚠ Geplande workouts mislukt (niet fataal): {e}")

    if garmin_ok:
        print(f"\n✅ Sync volledig voltooid voor {TODAY}")
    else:
        print(f"\n⚠ Sync gedeeltelijk voltooid voor {TODAY} — Garmin data ontbreekt, rij is aangemaakt")
