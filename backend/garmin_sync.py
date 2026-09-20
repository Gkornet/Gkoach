"""
garmin_sync.py
--------------
Haalt Garmin-data op en schrijft die naar Supabase.
Draait automatisch via GitHub Actions.

Synct standaard niet alleen vandaag, maar een klein venster van de laatste
dagen (SYNC_LOOKBACK_DAYS). Dat is bewust: Garmin levert een deel van de data
pas later aan (activiteiten 's avonds laat, VO2max een dag na een training) en
geplande Actions-runs worden door GitHub regelmatig overgeslagen. Door telkens
een paar dagen terug te kijken herstelt de sync zichzelf.

Installatie:
  pip install garminconnect supabase python-dotenv
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

# Hoeveel dagen we per run opnieuw ophalen (incl. TODAY). 1 = alleen vandaag.
# Standaard 3, zodat late activiteiten, na-geleverde VO2max en overgeslagen
# Actions-runs vanzelf worden ingehaald. Bij een expliciete SYNC_DATE (backfill
# van één dag) blijft het venster 1, tenzij anders opgegeven.
_default_lookback = "1" if os.getenv("SYNC_DATE") else "3"
SYNC_LOOKBACK_DAYS = int(os.getenv("SYNC_LOOKBACK_DAYS", _default_lookback))


def sync_window():
    """Lijst met datums om te syncen, oudste eerst."""
    end = datetime.date.fromisoformat(TODAY)
    n   = max(1, SYNC_LOOKBACK_DAYS)
    return [(end - datetime.timedelta(days=i)).isoformat() for i in range(n - 1, -1, -1)]

def _num(value, default=None):
    """Garmin levert bestaande velden regelmatig als null. dict.get(k, 0) vangt
    dat niet af (de default geldt alleen bij een ontbrekende sleutel), dus elke
    berekening erop klapte het hele blok om. Deze helper doet dat wel."""
    if value is None or value == "":
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


# ── Garmin inloggen ───────────────────────────────────────────────────────────
def login_garmin():
    """Logt één keer in en geeft een herbruikbare client terug."""
    from garminconnect import Garmin

    print("Verbinden met Garmin Connect...")

    # Token-gebaseerd inloggen via ingebouwde tokenstore van garminconnect 0.3.x
    import sys
    token_dir = TOKEN_STORE  # directory waar garminconnect tokens opslaat

    loaded = False
    if os.path.isdir(token_dir) and os.listdir(token_dir):
        try:
            client = Garmin(GARMIN_EMAIL, GARMIN_PASSWORD)
            client.login(tokenstore=token_dir)
            # De dag-endpoints bouwen hun URL met display_name. Ontbreekt die,
            # dan geeft Garmin een lege 200 in plaats van een fout en lijkt de
            # sync te slagen terwijl er niets binnenkomt. Dus: controleer of de
            # proef-aanroep ook echt inhoud teruggeeft.
            # Sessie toetsen op iets dat losstaat van het horloge: is het
            # profiel bereikbaar? Toetsen op "komt er dagdata terug" zou fout
            # zijn — als het horloge stuk is of niet gedragen wordt, is die
            # data terecht leeg en zouden we elk uur opnieuw gaan inloggen.
            if not getattr(client, "display_name", None):
                profile = client.get_user_profile() or {}
                client.display_name = (profile.get("displayName")
                                       or profile.get("userName") or client.display_name)
            if client.display_name:
                print(f"  ✓ Ingelogd via opgeslagen tokens (profiel: {client.display_name})")
                loaded = True
            else:
                print("  ⚠ Profiel niet op te halen — opnieuw inloggen...")
        except Exception as e:
            print(f"  → Tokens niet bruikbaar ({e}) — opnieuw inloggen...")

    if not loaded:
        os.makedirs(token_dir, exist_ok=True)
        is_interactive = sys.stdin.isatty()
        prompt_mfa = (lambda: input("  Voer je Garmin MFA-code in: ")) if is_interactive else None
        client = Garmin(GARMIN_EMAIL, GARMIN_PASSWORD, prompt_mfa=prompt_mfa)
        client.login(tokenstore=token_dir)
        print(f"  ✓ Tokens opgeslagen in {token_dir}")

    return client


# ── Garmin data van één dag ophalen ───────────────────────────────────────────
def fetch_day(client, day):
    """Haalt alle Garmin-metingen voor `day` (YYYY-MM-DD) op."""
    print(f"\n[{day}] Data ophalen...")
    data = {}

    # Slaap
    try:
        sleep = client.get_sleep_data(day) or {}
        daily = sleep.get("dailySleepDTO") or {}
        total = _num(daily.get("sleepTimeSeconds"))
        deep  = _num(daily.get("deepSleepSeconds"))
        rem   = _num(daily.get("remSleepSeconds"))
        if total:
            data["sleep_h"] = round(total / 3600, 2)
        if deep is not None:
            data["sleep_deep"] = round(deep / 3600, 2)
        if rem is not None:
            data["sleep_rem"] = round(rem / 3600, 2)
        data["sleep_q"] = ((daily.get("sleepScores") or {}).get("overall") or {}).get("value") or ""
        if total:
            print(f"  ✓ Slaap: {data['sleep_h']}u, score {data['sleep_q']}")
        else:
            print("  → Slaap: geen data voor deze dag")
    except Exception as e:
        print(f"  ✗ Slaap: {e}")

    # HRV — drie waarden
    try:
        hrv = client.get_hrv_data(day)
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
        stats = client.get_stats(day)
        data["rhr"]          = stats.get("restingHeartRate", "")
        data["stress"]       = stats.get("averageStressLevel", "")
        data["body_battery"] = stats.get("bodyBatteryChargedValue", "")
        data["step_goal"]    = stats.get("dailyStepGoal", "")
        print(f"  ✓ RHR: {data['rhr']}, Stress: {data['stress']}, Battery: {data['body_battery']}, Stappendoel: {data['step_goal']}")
    except Exception as e:
        print(f"  ✗ Stats: {e}")

    # Stappen + activiteiten
    try:
        steps = client.get_steps_data(day)
        # Een lege lijst betekent "geen antwoord", niet "nul stappen". Een echte
        # nul-dag levert wel intervallen op (met 0 erin), dus die blijft kloppen.
        if isinstance(steps, list) and steps:
            data["steps"] = int(sum(_num(x.get("steps"), 0) for x in steps))
            print(f"  ✓ Stappen: {data['steps']}")
        else:
            print("  → Stappen: geen data voor deze dag")
    except Exception as e:
        print(f"  ✗ Stappen: {e}")

    # Activiteiten — alle activiteiten van vandaag + hardloop dynamics voor primaire
    WALKING_TYPES = {"walking", "casual_walking"}
    try:
        yesterday = (datetime.date.fromisoformat(day) - datetime.timedelta(days=1)).isoformat()
        all_fetched = client.get_activities_by_date(yesterday, day)

        # Filter op alleen activiteiten van vandaag
        def activity_date(a):
            start = a.get("startTimeLocal", a.get("startTimeGMT", ""))
            return str(start)[:10]
        activities = [a for a in all_fetched if activity_date(a) == day]
        # Geen fallback naar gisteren — als er vandaag niets is, blijft trained=False
        print(f"  → {len(all_fetched)} activiteiten opgehaald, {len(activities)} van deze dag ({day})")

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
        vo2 = client.get_max_metrics(day)
        if isinstance(vo2, list) and vo2:
            data["vo2max"] = vo2[0].get("generic", {}).get("vo2MaxPreciseValue", "")
            if data["vo2max"]:
                print(f"  ✓ VO2max: {data['vo2max']}")
    except Exception as e:
        print(f"  ⚠ VO2max: {e}")

    # Gewicht wordt niet hier opgehaald maar via backfill_weight() — die pakt
    # vandaag én de afgelopen dagen mee, zodat weegmomenten die pas later
    # synchroniseerden alsnog op de juiste dag terechtkomen.

    return data


# Velden die bewijzen dat Garmin voor deze dag echt iets teruggaf. Zonder deze
# controle schrijft een stukke sessie steps=0 en trained=False over goede data.
EVIDENCE_FIELDS = ("sleep_h", "sleep_q", "hrv", "hrv_7d", "rhr", "stress",
                   "body_battery", "steps", "vo2max", "activities", "train_type")


def has_real_data(data):
    return any(data.get(f) not in ("", None) for f in EVIDENCE_FIELDS)


# ── Supabase schrijven ────────────────────────────────────────────────────────
def write_to_supabase(garmin_data, day, sb=None):
    from supabase import create_client

    if sb is None:
        sb = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)

    # Bouw het record op — sla lege/None waarden over
    record = {k: v for k, v in garmin_data.items() if v not in ("", None)}
    if not record:
        print(f"  → {day}: geen Garmin-velden om te schrijven")
        return

    # Haal eventuele bestaande rij op zodat we handmatige user-data (alcohol, bp, mood, notities,
    # voeding, meditatie) niet overschrijven. Gewicht komt uit de Garmin Index S2 weegschaal.
    existing = sb.table("health_entries").select("id").eq("user_id", GARMIN_USER_ID).eq("date", day).execute()

    if existing.data:
        # UPDATE: alleen de Garmin-velden bijwerken, handmatig ingevulde velden ongemoeid laten
        sb.table("health_entries").update(record).eq("user_id", GARMIN_USER_ID).eq("date", day).execute()
        print(f"  ✓ {day}: rij bijgewerkt ({len(record)} velden)")
    else:
        # INSERT: nieuwe rij voor deze dag
        record["user_id"] = GARMIN_USER_ID
        record["date"]    = day
        sb.table("health_entries").insert(record).execute()
        print(f"  ✓ {day}: nieuwe rij toegevoegd ({len(record)} velden)")


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
    today_obj = datetime.date.fromisoformat(TODAY)

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


# ── Velden (referentie — moet overeenkomen met de app en het Supabase-schema) ──
HEADERS = [
    "date", "weight", "alcohol", "bp_sys", "bp_dia",
    "sleep_h", "sleep_q", "sleep_deep", "sleep_rem",
    "hrv", "hrv_7d", "hrv_5min",
    "rhr", "stress", "body_battery", "steps",
    "trained", "train_type", "train_min", "train_dist",
    "avg_hr", "max_hr", "avg_pace", "cadence",
    "ground_contact", "vertical_osc", "vertical_ratio",
    "stride_length", "training_effect", "vo2max", "run_power",
    "energy", "mental_unrest", "breathing", "breathing_type",
    "notes", "sleep_prep", "koffie", "mood",
    "activities", "step_goal",
    # Handmatig — voeding & geest
    "meditation_min", "veg_fruit", "protein_ok", "late_meal", "snacks",
]


# ── Main ──────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    print(f"\n{'='*50}")
    print(f"  Garmin → Supabase sync — {TODAY}")
    print(f"{'='*50}\n")

    if not GARMIN_EMAIL or not GARMIN_PASSWORD:
        print("FOUT: Stel GARMIN_EMAIL en GARMIN_PASSWORD in in je .env bestand")
        sys.exit(1)

    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY or not GARMIN_USER_ID:
        print("FOUT: Stel SUPABASE_URL, SUPABASE_SERVICE_KEY en GARMIN_USER_ID in in je .env bestand")
        sys.exit(1)

    # Stap 1: één keer inloggen bij Garmin (niet fataal als dit mislukt)
    client = None
    try:
        client = login_garmin()
    except Exception as e:
        import traceback
        print(f"\n❌ Garmin inloggen mislukt: {e}")
        traceback.print_exc()

    days = sync_window()
    print(f"\nSync-venster: {days[0]} t/m {days[-1]} ({len(days)} dag(en))")

    # Stap 2: per dag ophalen en wegschrijven. Elke dag staat op zichzelf: een
    # fout op één dag mag de rest niet blokkeren.
    from supabase import create_client
    sb = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)

    ok_days, failed_days = [], []
    for day in days:
        try:
            data = fetch_day(client, day) if client else {}
        except Exception as e:
            print(f"  ✗ {day}: Garmin ophalen mislukt: {e}")
            data = {}

        try:
            # Alleen schrijven als Garmin echt iets teruggaf. Anders zouden
            # steps=0 en trained=False over goede data heen gaan.
            if not has_real_data(data):
                if day == TODAY:
                    # Rij voor vandaag toch aanmaken, zodat de app iets heeft om
                    # handmatige invoer aan te hangen.
                    existing = sb.table("health_entries").select("id") \
                        .eq("user_id", GARMIN_USER_ID).eq("date", day).execute()
                    if not existing.data:
                        sb.table("health_entries").insert(
                            {"user_id": GARMIN_USER_ID, "date": day}).execute()
                        print(f"  ✓ {day}: lege rij aangemaakt")
                print(f"  → {day}: geen Garmin-data, bestaande rij niet aangeraakt")
                failed_days.append(day)
                continue
            write_to_supabase(data, day, sb=sb)
            ok_days.append(day)
        except Exception as e:
            import traceback
            print(f"  ✗ {day}: Supabase schrijven mislukt: {e}")
            traceback.print_exc()
            failed_days.append(day)

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

    print(f"\n{'='*50}")
    if ok_days and not failed_days:
        print(f"✅ Sync voltooid — {len(ok_days)} dag(en): {', '.join(ok_days)}")
    elif ok_days:
        print(f"⚠ Sync deels voltooid — ok: {', '.join(ok_days)} | zonder data: {', '.join(failed_days)}")
    elif client is None:
        # Echt kapot: we kwamen niet eens binnen bij Garmin.
        print("❌ Geen verbinding met Garmin — er is niets opgehaald.")
        print("   Ververs zo nodig de GARMIN_TOKENS secret (backend/refresh_garmin_token.py).")
        sys.exit(1)
    else:
        # Ingelogd, maar geen dagdata. Dat is normaal als het horloge niet
        # gedragen of weggebracht wordt — geen reden om de run te laten falen.
        print("ℹ Geen dagdata van het horloge voor deze dagen.")
        print("  Bestaande rijen zijn niet aangeraakt. Gewicht en geplande")
        print("  workouts lopen los van het horloge en zijn wel bijgewerkt.")
