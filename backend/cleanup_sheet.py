"""
cleanup_sheet.py
----------------
Herstelt de Google Sheet: verwijdert lege/dubbele rijen, ruimt stray data op,
en herschrijft alle rijen naar de correcte kolomvolgorde.

Gebruik:
  cd /Users/gertkornet/Projects/Gkoach/backend
  python cleanup_sheet.py
"""

import os, json
from dotenv import load_dotenv

load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "..", ".env"))

SHEET_ID        = os.getenv("GOOGLE_SHEET_ID")
SERVICE_ACCOUNT = os.getenv("GOOGLE_SERVICE_ACCOUNT_JSON")
SHEET_TAB       = os.getenv("SHEET_TAB_NAME", "coach_data")

# ── Headers — moeten exact overeenkomen met garmin_sync.py en App.jsx ─────────
NEW_HEADERS = [
    "date", "weight", "alcohol", "bp_sys", "bp_dia",          # A–E
    "sleep_h", "sleep_q", "sleep_deep", "sleep_rem",           # F–I
    "hrv", "hrv_7d", "hrv_5min",                               # J–L
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

DATE_COL = "date"


def col_letter(n):
    """Zet 1-indexed kolomnummer om naar letter(s): 1→A, 27→AA, enz."""
    result = ""
    while n > 0:
        n, rem = divmod(n - 1, 26)
        result = chr(65 + rem) + result
    return result


def cleanup():
    import gspread
    from google.oauth2.service_account import Credentials

    scopes = [
        "https://www.googleapis.com/auth/spreadsheets",
        "https://www.googleapis.com/auth/drive"
    ]
    creds = Credentials.from_service_account_file(SERVICE_ACCOUNT, scopes=scopes)
    gc = gspread.authorize(creds)
    sh = gc.open_by_key(SHEET_ID)
    ws = sh.worksheet(SHEET_TAB)

    major = int(gspread.__version__.split(".")[0])

    # ── Stap 1: Lees alles ────────────────────────────────────────────────────
    all_values = ws.get_all_values()
    if len(all_values) < 2:
        print("Sheet heeft minder dan 2 rijen — niets te doen.")
        return

    sheet_headers = [h.strip().lower() for h in all_values[0]]
    data_rows     = all_values[1:]
    total_cols    = len(all_values[0])

    print(f"Sheet heeft {len(data_rows)} data-rijen, {total_cols} kolommen")
    print(f"Sheet headers ({len(sheet_headers)}): {sheet_headers[:len(NEW_HEADERS)]}")
    print(f"Doelkolommen ({len(NEW_HEADERS)}): {NEW_HEADERS}")

    # ── Stap 2: Bouw records op via werkelijke sheet-headers ──────────────────
    records = []
    for i, row in enumerate(data_rows):
        record = {}
        for j, h in enumerate(sheet_headers):
            if h:
                record[h] = row[j] if j < len(row) else ""
        records.append(record)

    # ── Stap 3: Filter lege rijen (geen geldige datum) ────────────────────────
    def is_valid_date(s):
        import re
        return bool(s and re.match(r"\d{4}-\d{2}-\d{2}", str(s).strip()))

    valid   = [r for r in records if is_valid_date(r.get(DATE_COL, ""))]
    removed = len(records) - len(valid)
    if removed:
        print(f"\n  → {removed} lege/ongeldige rijen verwijderd")

    # ── Stap 4: Dedupliceer op datum (bewaar meest gevulde versie) ────────────
    seen = {}
    for r in valid:
        date = r[DATE_COL].strip()
        filled = sum(1 for v in r.values() if v not in ("", None, "FALSE", False))
        if date not in seen or filled > seen[date][1]:
            seen[date] = (r, filled)

    deduped = [v[0] for v in sorted(seen.values(), key=lambda x: x[0].get(DATE_COL, ""))]
    dupes   = len(valid) - len(deduped)
    if dupes:
        print(f"  → {dupes} dubbele rijen samengevoegd (meest gevulde versie bewaard)")

    print(f"\nResultaat: {len(deduped)} unieke rijen ({len(data_rows)} origineel)")

    # Preview
    print("\nPreview (datum, hrv, rhr, stappen, step_goal):")
    for r in deduped:
        print(f"  {r.get('date','?'):12s}  hrv={r.get('hrv',''):4s}  rhr={r.get('rhr',''):3s}  "
              f"steps={r.get('steps',''):6s}  step_goal={r.get('step_goal','')}")

    # ── Bevestiging ───────────────────────────────────────────────────────────
    print(f"\n{'='*60}")
    print(f"Klaar om sheet te herschrijven:")
    print(f"  • Header-rij bijwerken naar {len(NEW_HEADERS)} kolommen")
    print(f"  • {len(deduped)} data-rijen terugschrijven")
    if total_cols > len(NEW_HEADERS):
        print(f"  • Stray kolommen {col_letter(len(NEW_HEADERS)+1)}–{col_letter(total_cols)} wissen")
    confirm = input("\nDoorgaan? (ja/nee): ")
    if confirm.strip().lower() not in ("ja", "j", "yes", "y"):
        print("Afgebroken.")
        return

    # ── Stap 5: Wis het hele tabblad en schrijf alles opnieuw ─────────────────
    ws.clear()
    print("  ✓ Sheet leeggemaakt")

    all_rows = [NEW_HEADERS] + [
        [r.get(h, "") for h in NEW_HEADERS] for r in deduped
    ]

    if major >= 6:
        ws.update(all_rows, "A1")
    else:
        ws.update("A1", all_rows)

    print(f"  ✓ {len(deduped)} rijen + header teruggeschreven naar A1")
    print(f"\n✅ Sheet cleanup voltooid!")
    print("  → Voer nu een Garmin sync uit om vandaag's rij correct bij te werken.")


if __name__ == "__main__":
    if not SHEET_ID or not SERVICE_ACCOUNT:
        print("FOUT: stel GOOGLE_SHEET_ID en GOOGLE_SERVICE_ACCOUNT_JSON in in .env")
        exit(1)
    cleanup()
