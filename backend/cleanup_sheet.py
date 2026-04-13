"""
cleanup_sheet.py
----------------
Herstelt de Google Sheet na het invoegen van kolommen K (hrv_7d) en L (hrv_5min).

Probleem:
  De gebruiker heeft 2 nieuwe kolommen ingevoegd op positie K en L in de sheet.
  Daarna schreef de backend data met de OUDE kolomvolgorde, waardoor:
  - K (hrv_7d) de rhr-waarde bevat in plaats van HRV 7-daags gemiddelde
  - L (hrv_5min) de stress-waarde bevat
  - Verdere kolommen zijn ook verschoven / verkeerd beschreven

Oplossing:
  Lees alle rijen via de WERKELIJKE sheet-headers (dynamische mapping),
  herschrijf elke rij zodat de waarden op de juiste NIEUWE kolomposities staan.

Gebruik:
  cd /Users/gertkornet/Projects/Gkoach/backend
  pip install gspread google-auth python-dotenv
  python cleanup_sheet.py
"""

import os, json
from dotenv import load_dotenv

load_dotenv()

SHEET_ID       = os.getenv("GOOGLE_SHEET_ID")
SERVICE_ACCOUNT = os.getenv("GOOGLE_SERVICE_ACCOUNT_JSON")
SHEET_TAB      = os.getenv("SHEET_TAB_NAME", "coach_data")

# ── Nieuwe HEADERS (moeten overeenkomen met App.jsx en garmin_sync.py) ──────────
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
]

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

    # Lees alle data inclusief header-rij
    all_values = ws.get_all_values()
    if len(all_values) < 2:
        print("Sheet heeft minder dan 2 rijen — niets te doen.")
        return

    sheet_headers = [h.strip().lower() for h in all_values[0]]
    data_rows     = all_values[1:]

    print(f"Sheet heeft {len(data_rows)} data-rijen")
    print(f"Sheet headers ({len(sheet_headers)}): {sheet_headers[:20]}...")
    print(f"Nieuwe HEADERS ({len(NEW_HEADERS)}): {NEW_HEADERS[:20]}...")

    # Bouw voor elke rij een dict op via de werkelijke sheet-headers
    fixed_rows = []
    for i, row in enumerate(data_rows):
        # Map via sheet-headers
        record = {}
        for j, h in enumerate(sheet_headers):
            if h:
                record[h] = row[j] if j < len(row) else ""

        # Maak een correcte rij op basis van NEW_HEADERS
        new_row = [record.get(h, "") for h in NEW_HEADERS]
        fixed_rows.append((i + 2, new_row))  # +2 want rij 1 = headers

        date = record.get("date", f"rij {i+2}")
        hrv  = record.get("hrv", "")
        hrv7 = record.get("hrv_7d", "")
        rhr  = record.get("rhr", "")
        steps = record.get("steps", "")
        print(f"  {date}: hrv={hrv}, hrv_7d={hrv7}, rhr={rhr}, steps={steps}")

    print(f"\n{'='*50}")
    print(f"Klaar om {len(fixed_rows)} rijen te herschrijven.")
    confirm = input("Doorgaan? (ja/nee): ")
    if confirm.strip().lower() not in ("ja", "j", "yes", "y"):
        print("Afgebroken.")
        return

    # Schrijf correcte header-rij
    import gspread as _gs
    major = int(_gs.__version__.split(".")[0])
    if major >= 6:
        ws.update([NEW_HEADERS], "A1")
    else:
        ws.update("A1", [NEW_HEADERS])
    print("  ✓ Header-rij bijgewerkt")

    # Schrijf elke data-rij terug
    for row_idx, new_row in fixed_rows:
        if major >= 6:
            ws.update([new_row], f"A{row_idx}")
        else:
            ws.update(f"A{row_idx}", [new_row])
        print(f"  ✓ Rij {row_idx} herschreven")

    # Verwijder eventuele data rechts van kolom AM (was van vóór de insert)
    # Bepaal het aantal kolommen in de sheet
    total_cols = len(all_values[0])
    if total_cols > len(NEW_HEADERS):
        extra_start_col = len(NEW_HEADERS) + 1  # 1-indexed
        col_letter = lambda n: (
            chr(64 + n) if n <= 26
            else chr(64 + (n-1)//26) + chr(65 + (n-1)%26)
        )
        start_letter = col_letter(extra_start_col)
        end_letter   = col_letter(total_cols)
        clear_range  = f"{SHEET_TAB}!{start_letter}1:{end_letter}{len(data_rows)+1}"
        ws.spreadsheet.values_clear(clear_range)
        print(f"  ✓ Kolommen {start_letter}–{end_letter} opgeschoond (oud restant)")

    print(f"\n✅ Sheet cleanup voltooid! {len(fixed_rows)} rijen hersteld.")
    print("  → Voer nu een Garmin sync uit om vandaag's rij correct bij te werken.")


if __name__ == "__main__":
    if not SHEET_ID or not SERVICE_ACCOUNT:
        print("FOUT: stel GOOGLE_SHEET_ID en GOOGLE_SERVICE_ACCOUNT_JSON in in .env")
        exit(1)
    cleanup()
