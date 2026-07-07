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
GARMIN_EMAIL         = os.getenv("GARMIN_EMAIL")
GARMIN_PASSWORD      = os.getenv("GARMIN_PASSWORD")
SUPABASE_URL         = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY")
GARMIN_USER_ID       = os.getenv("GARMIN_USER_ID")
TOKEN_STORE          = os.path.join(os.path.dirname(__file__), ".garmin_tokens")

# Hoeveel dagen terug we gewicht van de weegschaal bijwerken (incl. vandaag).
# Vangt weegmomenten op die pas na de ochtendsync met Garmin synchroniseerden.
WEIGHT_LOOKBACK_DAYS = int(os.getenv("WEIGHT_LOOKBACK_DAYS", "7"))

# Datum om te syncen — standaard vandaag, of override via SYNC_DATE (YYYY-MM-DD)
# zodat we een gemiste dag handmatig kunnen ophalen.
TODAY = os.getenv("SYNC_DATE") or datetime.date.today().isoformat()

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
        yesterday = (datetime.date.fromisoformat(TODAY) - datetime.timedelta(days=1)).isoformat()
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
                    s = details.get("summaryDTO", {})

                    cad = s.get("averageRunCadence")
                    gc  = s.get("groundContactTime")
                    vo  = s.get("verticalOscillation")   # al in cm
                    vr  = s.get("verticalRatio")
                    sl  = s.get("strideLength")           # in cm → /100 = m
                    pw  = s.get("averagePower")

                    data["cadence"]         = round(cad) if cad else ""
                    data["ground_contact"]  = round(gc)  if gc  else ""
                    data["vertical_osc"]    = round(vo, 1) if vo else ""
                    data["vertical_ratio"]  = round(vr, 1) if vr else ""
                    data["stride_length"]   = round(sl / 100, 2) if sl else ""
                    data["training_effect"] = s.get("trainingEffectLabel", "")
                    data["run_power"]       = round(pw) if pw else ""

                    print(f"  ✓ Hardloop dynamics: cadans {data['cadence']} spm, GCT {data['ground_contact']} ms, "
                          f"V.osc {data['vertical_osc']} cm, vermogen {data['run_power']} W")
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

    # Gewicht wordt niet hier opgehaald maar via backfill_weight() — die pakt
    # vandaag én de afgelopen dagen mee, zodat weegmomenten die pas later
    # synchroniseerden alsnog op de juiste dag terechtkomen.

    return client, data


# ── Supabase schrijven ────────────────────────────────────────────────────────
def write_to_supabase(garmin_data):
    from supabase import create_client

    print(f"\nVerbinden met Supabase...")
    sb = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)

    # Bouw het record op — sla lege/None waarden over
    record = {k: v for k, v in garmin_data.items() if v not in ("", None)}

    # Haal eventuele bestaande rij op zodat we handmatige user-data (alcohol, bp, mood, notities)
    # niet overschrijven. Gewicht komt sinds de Garmin Index S2 weegschaal uit Garmin zelf.
    existing = sb.table("health_entries").select("*").eq("user_id", GARMIN_USER_ID).eq("date", TODAY).execute()

    if existing.data:
        # UPDATE: alleen de Garmin-velden bijwerken, handmatig ingevulde velden ongemoeid laten
        sb.table("health_entries").update(record).eq("user_id", GARMIN_USER_ID).eq("date", TODAY).execute()
        print(f"  ✓ Bestaande rij bijgewerkt voor {TODAY} ({len(record)} velden)")
    else:
        # INSERT: nieuwe rij voor vandaag
        record["user_id"] = GARMIN_USER_ID
        record["date"]    = TODAY
        sb.table("health_entries").insert(record).execute()
        print(f"  ✓ Nieuwe rij toegevoegd voor {TODAY} ({len(record)} velden)")


# ── Gewicht bijwerken (Garmin Index S2 weegschaal) ────────────────────────────
def backfill_weight(garmin_client, days=WEIGHT_LOOKBACK_DAYS):
    """Haalt weegmomenten op over de afgelopen `days` dagen (t/m TODAY) en
    schrijft het gewicht per dag naar de juiste rij in Supabase. Zo worden ook
    afgelopen dagen bijgewerkt — niet alleen vandaag."""
    from supabase import create_client

    end   = datetime.date.fromisoformat(TODAY)
    start = end - datetime.timedelta(days=max(0, days - 1))
    print(f"\nGewicht ophalen van {start} t/m {end} (weegschaal)...")

    try:
        body = garmin_client.get_body_composition(start.isoformat(), end.isoformat())
    except Exception as e:
        print(f"  ⚠ Gewicht ophalen mislukt: {e}")
        return

    rows = (body or {}).get("dateWeightList", []) or []
    if not rows:
        print("  → Geen weegmomenten in deze periode")
        return

    sb = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    count = 0
    for r in rows:
        cal      = r.get("calendarDate")
        weight_g = r.get("weight")
        if not cal or not weight_g:
            continue
        # Garmin levert gewicht in gram → kg met 1 decimaal
        weight_kg = round(weight_g / 1000, 1)
        # Upsert op (user_id, date): werkt alleen het weight-veld bij, laat de
        # rest van de rij ongemoeid. Bestaat de dag nog niet, dan wordt hij aangemaakt.
        sb.table("health_entries").upsert(
            {"user_id": GARMIN_USER_ID, "date": cal, "weight": weight_kg},
            on_conflict="user_id,date"
        ).execute()
        count += 1
        print(f"  ✓ {cal}: {weight_kg} kg")

    print(f"  ✓ {count} weegmoment(en) bijgewerkt in Supabase")


# ── Geplande workouts schrijven ───────────────────────────────────────────────
def write_planned_workouts(garmin_client):
    from supabase import create_client

    print(f"\nGeplande workouts ophalen...")
    today_obj = datetime.date.today()

    # Haal komende 2 maanden op via Garmin
    items = []
    for delta in range(2):
        year  = (today_obj.replace(day=1) + datetime.timedelta(days=32 * delta)).year
        month = (today_obj.replace(day=1) + datetime.timedelta(days=32 * delta)).month
        try:
            cal = garmin_client.get_scheduled_workouts(year, month)
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

    # Dedupliceer op workout_id
    seen_ids, unique_items = set(), []
    for item in sorted(items, key=lambda x: x["date"]):
        key = item["workout_id"] or f"{item['date']}_{item['title']}"
        if key not in seen_ids:
            seen_ids.add(key)
            unique_items.append(item)
    items = unique_items
    print(f"  ✓ {len(items)} geplande workouts gevonden")

    # Schrijf naar Supabase: verwijder toekomstige workouts en zet nieuwe neer
    sb = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    sb.table("planned_workouts").delete().eq("user_id", GARMIN_USER_ID).gte("date", TODAY).execute()

    for item in items:
        sb.table("planned_workouts").upsert(
            {"user_id": GARMIN_USER_ID, **item},
            on_conflict="user_id,date"
        ).execute()

    print(f"  ✓ planned_workouts bijgewerkt in Supabase ({len(items)} rijen)")


# ── Headers (moeten overeenkomen met de app én de Google Sheet kolomvolgorde) ──
# Kolom A-J: datum t/m hrv, dan K=hrv_7d L=hrv_5min (door gebruiker aangemaakt),
# dan M=rhr N=stress O=body_battery P=steps, enz.
HEADERS = [
    "date", "weight", "alcohol", "bp_sys", "bp_dia",          # A–E
    "sleep_h", "sleep_q", "sleep_deep", "sleep_rem",           # F–I
    "hrv", "hrv_7d", "hrv_5min",                               # J–L
    "rhr", "stress", "body_battery", "steps",                  # M–P
    "trained", "train_type", "train_min", "train_dist",        # Q–T
    "avg_hr", "max_hr", "avg_pace", "cadence",                 # U–X
    "ground_contact", "vertical_osc", "vertical_ratio",        # Y–AA
    "stride_length", "training_effect", "vo2max", "run_power", # AB–AE
    "energy", "mental_unrest", "breathing", "breathing_type",  # AF–AI
    "notes", "sleep_prep", "koffie", "mood",                   # AJ–AM
    "activities",                                               # AN
    "step_goal",                                               # AO
]


# ── Main ──────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    print(f"\n{'='*50}")
    print(f"  Garmin → Sheets sync — {TODAY}")
    print(f"{'='*50}\n")

    if not GARMIN_EMAIL or not GARMIN_PASSWORD:
        print("FOUT: Stel GARMIN_EMAIL en GARMIN_PASSWORD in in je .env bestand")
        sys.exit(1)

    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY or not GARMIN_USER_ID:
        print("FOUT: Stel SUPABASE_URL, SUPABASE_SERVICE_KEY en GARMIN_USER_ID in in je .env bestand")
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

    # Stap 2: Altijd naar Supabase schrijven (zelfs als Garmin leeg is)
    try:
        write_to_supabase(garmin_data)
        print(f"✅ Supabase bijgewerkt voor {TODAY}")
    except Exception as e:
        import traceback
        print(f"\n❌ Supabase schrijven mislukt: {e}")
        traceback.print_exc()
        sys.exit(1)

    # Stap 3: Gewicht bijwerken over de afgelopen dagen (alleen als Garmin werkte)
    if client:
        try:
            backfill_weight(client)
        except Exception as e:
            print(f"⚠ Gewicht bijwerken mislukt (niet fataal): {e}")

    # Stap 4: Geplande workouts (alleen als Garmin werkte)
    if client:
        try:
            write_planned_workouts(client)
        except Exception as e:
            print(f"⚠ Geplande workouts mislukt (niet fataal): {e}")

    if garmin_ok:
        print(f"\n✅ Sync volledig voltooid voor {TODAY}")
    else:
        print(f"\n⚠ Sync gedeeltelijk voltooid voor {TODAY} — Garmin data ontbreekt, rij is aangemaakt")
