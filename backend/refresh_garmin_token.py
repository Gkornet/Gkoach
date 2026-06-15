"""
refresh_garmin_token.py
-----------------------
Logt eenmalig in bij Garmin (met MFA) en print de GARMIN_TOKENS-waarde
die je in de GitHub secret moet plakken. Lokaal draaien op je laptop.

Gebruik:
  cd backend
  # zorg dat GARMIN_EMAIL en GARMIN_PASSWORD in ../.env of in je shell staan
  python3 refresh_garmin_token.py

Daarna: kopieer de geprinte regel en zet die in
GitHub → Settings → Secrets and variables → Actions → GARMIN_TOKENS (Update).
"""

import os
import io
import base64
import tarfile
from dotenv import load_dotenv

load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "..", ".env"))
load_dotenv()  # ook lokale backend/.env toestaan

EMAIL    = os.getenv("GARMIN_EMAIL")
PASSWORD = os.getenv("GARMIN_PASSWORD")
TOKEN_DIR = os.path.join(os.path.dirname(__file__), ".garmin_tokens")

if not EMAIL or not PASSWORD:
    print("FOUT: zet GARMIN_EMAIL en GARMIN_PASSWORD in .env of je shell")
    raise SystemExit(1)

from garminconnect import Garmin

os.makedirs(TOKEN_DIR, exist_ok=True)
print("Inloggen bij Garmin Connect... (je krijgt mogelijk een MFA-code per e-mail)")
client = Garmin(EMAIL, PASSWORD, prompt_mfa=lambda: input("  Voer je Garmin MFA-code in: "))
client.login(tokenstore=TOKEN_DIR)

# Test of de sessie echt werkt
profile = client.get_full_name()
print(f"  ✓ Ingelogd als: {profile}")

# Pak de tokenmap in zoals de workflow 'm verwacht (extract naar repo-root)
buf = io.BytesIO()
with tarfile.open(fileobj=buf, mode="w:gz") as tar:
    tar.add(TOKEN_DIR, arcname="backend/.garmin_tokens")
blob = base64.b64encode(buf.getvalue()).decode()

print("\n" + "=" * 70)
print("Kopieer ALLES hieronder en plak het als waarde van de GARMIN_TOKENS secret:")
print("=" * 70)
print(blob)
print("=" * 70)
