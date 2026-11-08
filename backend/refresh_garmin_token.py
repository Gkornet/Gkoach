"""
refresh_garmin_token.py
-----------------------
Logt eenmalig in bij Garmin (met MFA) en zet de nieuwe tokens direct in de
GitHub secret GARMIN_TOKENS (via `gh`). Lokaal draaien op je laptop.

Gebruik:
  cd backend
  python3 refresh_garmin_token.py

E-mail en wachtwoord komen uit ../.env of je shell; ontbreken ze, dan vraagt
het script erom (wachtwoord onzichtbaar). Is `gh` niet beschikbaar, dan print
het script de waarde zodat je 'm handmatig in de secret kunt plakken.
"""

import os
import io
import base64
import getpass
import shutil
import subprocess
import tarfile
from dotenv import load_dotenv

load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "..", ".env"))
load_dotenv()  # ook lokale backend/.env toestaan

EMAIL    = os.getenv("GARMIN_EMAIL") or input("Garmin e-mail: ").strip()
PASSWORD = os.getenv("GARMIN_PASSWORD") or getpass.getpass("Garmin wachtwoord: ")
TOKEN_DIR = os.path.join(os.path.dirname(__file__), ".garmin_tokens")

if not EMAIL or not PASSWORD:
    print("FOUT: e-mail en wachtwoord zijn verplicht")
    raise SystemExit(1)

from garminconnect import Garmin

# Oude tokens weg, zodat er echt opnieuw wordt ingelogd
shutil.rmtree(TOKEN_DIR, ignore_errors=True)
os.makedirs(TOKEN_DIR, exist_ok=True)
print("Inloggen bij Garmin Connect... (je krijgt mogelijk een MFA-code per e-mail)")
client = Garmin(EMAIL, PASSWORD, prompt_mfa=lambda: input("  Voer je Garmin MFA-code in: ").strip())
client.login(tokenstore=TOKEN_DIR)

# Test of de sessie echt werkt
profile = client.get_full_name()
print(f"  ✓ Ingelogd als: {profile}")

# Pak de tokenmap in zoals de workflow 'm verwacht (extract naar repo-root)
buf = io.BytesIO()
with tarfile.open(fileobj=buf, mode="w:gz") as tar:
    tar.add(TOKEN_DIR, arcname="backend/.garmin_tokens")
blob = base64.b64encode(buf.getvalue()).decode()

if shutil.which("gh"):
    result = subprocess.run(["gh", "secret", "set", "GARMIN_TOKENS"], input=blob, text=True)
    if result.returncode == 0:
        print("  ✓ GitHub secret GARMIN_TOKENS bijgewerkt")
        raise SystemExit(0)
    print("  ✗ `gh secret set` mislukt — plak de waarde hieronder handmatig")

print("\n" + "=" * 70)
print("Kopieer ALLES hieronder en plak het als waarde van de GARMIN_TOKENS secret:")
print("=" * 70)
print(blob)
print("=" * 70)
