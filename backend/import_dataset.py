"""
import_dataset.py
-----------------
Kopieert bp_dia (B), bp_sys (C), alcohol (D) en weight (E) uit het 'dataset'
tabblad naar de overeenkomstige rijen in 'coach_data'.

Gebruik:
  cd /Users/gertkornet/Projects/Gkoach/backend
  python3 import_dataset.py
"""

import os
from dotenv import load_dotenv

load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "..", ".env"))

SHEET_ID        = os.getenv("GOOGLE_SHEET_ID")
SERVICE_ACCOUNT = os.getenv("GOOGLE_SERVICE_ACCOUNT_JSON")
DATASET_TAB     = "dataset"
COACH_TAB       = os.getenv("SHEET_TAB_NAME", "coach_data")

# Mapping: dataset-kolomindex (0-based) → coach_data veldnaam
# A=0 datum, B=1 bp_dia, C=2 bp_sys, D=3 alcohol, E=4 weight
IMPORT_COLS = {
    1: "bp_dia",
    2: "bp_sys",
    3: "alcohol",
    4: "weight",
}


def run():
    import gspread
    from google.oauth2.service_account import Credentials

    scopes = [
        "https://www.googleapis.com/auth/spreadsheets",
        "https://www.googleapis.com/auth/drive",
    ]
    creds = Credentials.from_service_account_file(SERVICE_ACCOUNT, scopes=scopes)
    gc = gspread.authorize(creds)
    sh = gc.open_by_key(SHEET_ID)
    major = int(gspread.__version__.split(".")[0])

    # ── Lees dataset-tab ──────────────────────────────────────────────────────
    ds = sh.worksheet(DATASET_TAB)
    ds_rows = ds.get_all_values()
    print(f"Dataset-tab: {len(ds_rows)} rijen (incl. eventuele header)")
    # Bouw dict: datum → {veld: waarde}
    dataset = {}
    for row in ds_rows:
        if not row:
            continue
        raw = str(row[0]).strip()
        # Converteer D-M-YYYY naar YYYY-MM-DD
        try:
            from datetime import datetime
            date = datetime.strptime(raw, "%d-%m-%Y").strftime("%Y-%m-%d")
        except ValueError:
            continue  # sla header of ongeldige rijen over
        record = {}
        for col_idx, field in IMPORT_COLS.items():
            val = row[col_idx].strip() if col_idx < len(row) else ""
            if val:
                record[field] = val
        if record:
            dataset[date] = record

    print(f"  → {len(dataset)} datums met data gevonden in dataset-tab")

    # ── Lees coach_data-tab ───────────────────────────────────────────────────
    cd = sh.worksheet(COACH_TAB)
    headers = [h.strip().lower() for h in cd.row_values(1)]
    all_dates = cd.col_values(1)

    updates = []
    for date, record in sorted(dataset.items()):
        if date not in all_dates:
            print(f"  ⚠ {date} niet gevonden in coach_data — overgeslagen")
            continue
        row_idx = all_dates.index(date) + 1
        existing = cd.row_values(row_idx)
        existing += [""] * (len(headers) - len(existing))

        changed = []
        for field, val in record.items():
            if field in headers:
                col_idx = headers.index(field)
                if not existing[col_idx]:  # alleen invullen als leeg
                    existing[col_idx] = val
                    changed.append(f"{field}={val}")

        if changed:
            updates.append((row_idx, existing, date, changed))

    # ── Preview ───────────────────────────────────────────────────────────────
    print(f"\nBijwerken: {len(updates)} rijen")
    for row_idx, _, date, changed in updates:
        print(f"  rij {row_idx:3d}  {date}  ← {', '.join(changed)}")

    if not updates:
        print("Niets te doen.")
        return

    confirm = input("\nDoorgaan? (ja/nee): ")
    if confirm.strip().lower() not in ("ja", "j", "yes", "y"):
        print("Afgebroken.")
        return

    for row_idx, new_row, date, _ in updates:
        if major >= 6:
            cd.update([new_row], f"A{row_idx}")
        else:
            cd.update(f"A{row_idx}", [new_row])
        print(f"  ✓ {date} bijgewerkt")

    print(f"\n✅ Import klaar — {len(updates)} rijen bijgewerkt")


if __name__ == "__main__":
    if not SHEET_ID or not SERVICE_ACCOUNT:
        print("FOUT: stel GOOGLE_SHEET_ID en GOOGLE_SERVICE_ACCOUNT_JSON in in .env")
        exit(1)
    run()
