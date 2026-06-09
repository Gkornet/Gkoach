"""
migrate_to_supabase.py
----------------------
Eenmalig migratiescript: kopieert alle data uit Google Sheets naar Supabase.

Leest:
  1. coach_data tab  — Garmin + check-in history
  2. dataset tab     — historische alcohol, bloeddruk, gewicht (ook ontbrekende jaren)

Vereiste env vars (.env):
  GOOGLE_SHEET_ID
  GOOGLE_SERVICE_ACCOUNT_JSON
  SUPABASE_URL
  SUPABASE_SERVICE_KEY     ← service role key (niet de anon key!)
  GARMIN_USER_ID           ← UUID van de Supabase auth-user (zie Supabase dashboard → Auth → Users)

Gebruik:
  cd /Users/gertkornet/Projects/Gkoach/backend
  python3 migrate_to_supabase.py
"""

import os
import datetime
from dotenv import load_dotenv

load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "..", ".env"))

SHEET_ID             = os.getenv("GOOGLE_SHEET_ID")
SERVICE_ACCOUNT      = os.getenv("GOOGLE_SERVICE_ACCOUNT_JSON")
SUPABASE_URL         = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY")
GARMIN_USER_ID       = os.getenv("GARMIN_USER_ID")

# Velden met specifiek type in de database
BOOL_FIELDS      = {"trained", "mental_unrest", "breathing", "sleep_prep", "koffie"}
INT_FIELDS       = {"steps", "step_goal", "mood"}
TEXT_FIELDS      = {"date", "avg_pace", "train_type", "training_effect", "breathing_type",
                    "notes", "activities"}


def parse_value(field, raw):
    """Converteert een string uit Google Sheets naar het juiste Python-type voor Supabase."""
    if raw in ("", None):
        return None
    raw = str(raw).strip()
    if not raw or raw == "None":
        return None

    if field in BOOL_FIELDS:
        return raw.upper() in ("TRUE", "1", "JA", "YES")

    if field in TEXT_FIELDS:
        return raw

    # Numeriek — een niet-numerieke waarde hoort nooit in een getalskolom
    try:
        val = float(raw.replace(",", "."))
    except ValueError:
        return None
    if field in INT_FIELDS:
        return int(round(val))
    return val


def normalize_date(raw):
    """Converteert diverse datumformaten naar YYYY-MM-DD."""
    raw = str(raw).strip()
    for fmt in ("%d-%m-%Y", "%Y-%m-%d", "%d/%m/%Y", "%m/%d/%Y"):
        try:
            return datetime.datetime.strptime(raw, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return None


def run():
    import gspread
    from google.oauth2.service_account import Credentials
    from supabase import create_client

    sb = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)

    scopes = ["https://www.googleapis.com/auth/spreadsheets",
              "https://www.googleapis.com/auth/drive"]
    creds  = Credentials.from_service_account_file(SERVICE_ACCOUNT, scopes=scopes)
    gc     = gspread.authorize(creds)
    sh     = gc.open_by_key(SHEET_ID)

    records = {}  # date → record dict

    # ── Stap 1: coach_data tab ────────────────────────────────────────────────
    print("Lezen uit coach_data tab...")
    ws      = sh.worksheet("coach_data")
    all_rows = ws.get_all_values()

    if len(all_rows) < 2:
        print("  ✗ Geen data gevonden in coach_data")
        return

    headers = [h.strip().lower() for h in all_rows[0]]
    for row in all_rows[1:]:
        if not row or not row[0].strip():
            continue
        dt = normalize_date(row[0])
        if not dt:
            continue

        record = {"user_id": GARMIN_USER_ID, "date": dt}
        for i, field in enumerate(headers[1:], 1):
            if field and field != "date" and i < len(row):
                val = parse_value(field, row[i])
                if val is not None:
                    record[field] = val
        records[dt] = record

    print(f"  → {len(records)} rijen gevonden in coach_data")

    # ── Stap 2: dataset tab (historische alcohol, bp, weight) ─────────────────
    print("Lezen uit dataset tab...")
    try:
        ds       = sh.worksheet("dataset")
        ds_rows  = ds.get_all_values()
        new_rows = 0
        filled   = 0

        for row in ds_rows:
            if not row or not row[0].strip():
                continue
            dt = normalize_date(row[0])
            if not dt:
                continue

            # Kolommen: A=datum, B=bp_dia, C=bp_sys, D=alcohol, E=weight
            ds_fields = {}
            if len(row) > 1 and row[1].strip(): ds_fields["bp_dia"]  = parse_value("bp_dia",  row[1])
            if len(row) > 2 and row[2].strip(): ds_fields["bp_sys"]  = parse_value("bp_sys",  row[2])
            if len(row) > 3 and row[3].strip(): ds_fields["alcohol"] = parse_value("alcohol", row[3])
            if len(row) > 4 and row[4].strip(): ds_fields["weight"]  = parse_value("weight",  row[4])
            ds_fields = {k: v for k, v in ds_fields.items() if v is not None}

            if not ds_fields:
                continue

            if dt in records:
                # Vul ontbrekende velden aan (overschrijf nooit bestaande waarden)
                for field, val in ds_fields.items():
                    if records[dt].get(field) is None:
                        records[dt][field] = val
                        filled += 1
            else:
                # Historische rij die alleen in dataset staat
                records[dt] = {"user_id": GARMIN_USER_ID, "date": dt, **ds_fields}
                new_rows += 1

        print(f"  → {new_rows} nieuwe historische rijen, {filled} velden aangevuld vanuit dataset tab")
    except Exception as e:
        print(f"  ⚠ Dataset tab overgeslagen: {e}")

    # ── Stap 3: Upserten naar Supabase ────────────────────────────────────────
    all_records = sorted(records.values(), key=lambda r: r["date"])
    print(f"\nUpserten van {len(all_records)} rijen naar Supabase...")

    def upsert_batch(batch):
        """Upsert een batch; valt terug op rij-voor-rij als de batch faalt,
        zodat één foute rij de rest niet meesleept."""
        try:
            sb.table("health_entries").upsert(batch, on_conflict="user_id,date").execute()
            return len(batch), 0
        except Exception:
            ok = err = 0
            for rec in batch:
                try:
                    sb.table("health_entries").upsert(rec, on_conflict="user_id,date").execute()
                    ok += 1
                except Exception as e:
                    err += 1
                    print(f"  ✗ Rij {rec.get('date')} mislukt: {e}")
            return ok, err

    ok     = 0
    errors = 0
    batch  = []

    for rec in all_records:
        batch.append(rec)
        if len(batch) >= 50:
            b_ok, b_err = upsert_batch(batch)
            ok += b_ok; errors += b_err
            print(f"  → {ok}/{len(all_records)} gereed...")
            batch = []

    if batch:
        b_ok, b_err = upsert_batch(batch)
        ok += b_ok; errors += b_err

    print(f"\n✅ Migratie klaar: {ok} rijen OK, {errors} fouten")
    print(f"   Periode: {all_records[0]['date']} t/m {all_records[-1]['date']}")


if __name__ == "__main__":
    missing = [v for v in ["GOOGLE_SHEET_ID", "GOOGLE_SERVICE_ACCOUNT_JSON",
                           "SUPABASE_URL", "SUPABASE_SERVICE_KEY", "GARMIN_USER_ID"]
               if not os.getenv(v)]
    if missing:
        print(f"FOUT: Stel deze env vars in in .env: {', '.join(missing)}")
        exit(1)
    run()
