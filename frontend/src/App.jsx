import { useState, useEffect, useCallback } from "react";

// ── Google Sheets API ─────────────────────────────────────────────────────────
const SHEET_ID   = import.meta.env.VITE_GOOGLE_SHEET_ID;
const SA_EMAIL   = import.meta.env.VITE_GOOGLE_SERVICE_ACCOUNT_EMAIL;
const SA_KEY     = import.meta.env.VITE_GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n").replace(/\r/g, "");
const CLAUDE_KEY = import.meta.env.VITE_CLAUDE_API_KEY;
const TAB        = "coach_data";
const RANGE      = `${TAB}!A:AH`;
const PLANNED_TAB   = "planned_workouts";
const PLANNED_RANGE = `${PLANNED_TAB}!A:D`;

const b64url = str => btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlBytes = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function getJWT() {
  const header  = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const now     = Math.floor(Date.now() / 1000);
  const payload = b64url(JSON.stringify({
    iss: SA_EMAIL, scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token", exp: now + 3600, iat: now
  }));
  const unsigned  = `${header}.${payload}`;
  const keyData   = SA_KEY.replace(/-----BEGIN( RSA)? PRIVATE KEY-----|-----END( RSA)? PRIVATE KEY-----|\n|\r/g, "").trim();
  const binaryKey = Uint8Array.from(atob(keyData), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8", binaryKey.buffer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, new TextEncoder().encode(unsigned));
  const jwt = `${unsigned}.${b64urlBytes(sig)}`;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
  });
  return (await res.json()).access_token;
}

async function sheetsGet() {
  const token = await getJWT();
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(RANGE)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return res.json();
}

async function sheetsGetPlanned() {
  const token = await getJWT();
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(PLANNED_RANGE)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const d = await res.json();
  if (!d.values || d.values.length < 2) return [];
  const hdrs = d.values[0];
  return d.values.slice(1).map(r => {
    const obj = {};
    hdrs.forEach((h, i) => { obj[h] = r[i] ?? ""; });
    return obj;
  });
}

async function sheetsAppend(row) {
  const token = await getJWT();
  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(RANGE)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ values: [row] }) }
  );
}

async function sheetsUpdate(rowIdx, row) {
  const token = await getJWT();
  // HEADERS has 36 columns (A–AJ): dynamically compute last column
  const colNum = row.length; // e.g. 36
  const lastCol = colNum <= 26
    ? String.fromCharCode(64 + colNum)
    : String.fromCharCode(64 + Math.floor((colNum - 1) / 26)) + String.fromCharCode(65 + ((colNum - 1) % 26));
  const range = `${TAB}!A${rowIdx}:${lastCol}${rowIdx}`;
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
    { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ values: [row] }) }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    console.error("sheetsUpdate error:", res.status, err);
    throw new Error(`Sheets update failed: ${res.status} ${err?.error?.message || ""}`);
  }
}

// ── Constants ─────────────────────────────────────────────────────────────────
const HEADERS = [
  "date","weight","alcohol","bp_sys","bp_dia",
  "sleep_h","sleep_q","sleep_deep","sleep_rem",
  "hrv","rhr","stress","body_battery","steps",
  "trained","train_type","train_min","train_dist",
  "avg_hr","max_hr","avg_pace","cadence",
  "ground_contact","vertical_osc","vertical_ratio","stride_length","training_effect","vo2max",
  "energy","mental_unrest","breathing","breathing_type","notes","sleep_prep",
  "koffie","mood"
];

// Plan item → entry field mapping (for auto-save)
const PLAN_FIELD = { breathing: "breathing", sleep: "sleep_prep" };

const today     = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; };
const fmt       = (d) => new Date(d + "T12:00:00").toLocaleDateString("nl-NL", { day: "numeric", month: "short" });
// Sheets can return "5,52" (Dutch locale) or "5.52" — handle both
const parseNum  = (v) => { if (v === "" || v == null) return NaN; return parseFloat(String(v).replace(",", ".")); };
const numArr    = (entries, f) => entries.map(e => parseNum(e[f])).filter(v => !isNaN(v) && v > 0);
const avg       = (arr) => arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1) : "—";
const daysUntil = (d) => Math.ceil((new Date(d) - new Date()) / 86400000);
const isTrue    = (v) => v === true || v === "true" || v === "TRUE" || v === 1 || v === "1";
const EMPTY     = HEADERS.reduce((o, h) => ({ ...o, [h]: "" }), { trained: false, mental_unrest: false, breathing: false });

// ── Readiness score ───────────────────────────────────────────────────────────
function calcReadiness(last, entries) {
  if (!last) return null;
  const hrvVals = numArr(entries || [], "hrv");
  const avgHrv  = hrvVals.length > 3 ? hrvVals.slice(-14).reduce((a,b)=>a+b,0)/Math.min(hrvVals.length,14) : 50;
  let score = 50, n = 0;

  const hrv = parseNum(last.hrv), sleepH = parseNum(last.sleep_h);
  const stress = parseNum(last.stress), battery = parseNum(last.body_battery);
  if (!isNaN(hrv) && hrv > 0) {
    score += (hrv / avgHrv - 1) * 40; n++;
  }
  if (!isNaN(sleepH) && sleepH > 0) {
    score += (Math.min(sleepH / 8, 1.1) - 0.875) * 30; n++;
  }
  if (!isNaN(stress) && stress > 0) {
    // Garmin stress is 0–100, normalize to 0–10 range
    const s10 = stress > 10 ? stress / 10 : stress;
    score -= (s10 - 5) * 3; n++;
  }
  if (!isNaN(battery) && battery > 0) {
    score += (battery - 50) * 0.3; n++;
  }
  return Math.max(0, Math.min(100, Math.round(score)));
}

// ── Daily plan ────────────────────────────────────────────────────────────────
// todayData = strict today entry (null if not synced yet)
// contextData = last known entry for readiness/HRV context
function getDailyPlan(todayData, contextData, entries) {
  const last       = contextData; // for readiness calcs
  const readiness  = calcReadiness(last, entries);
  const race1Days  = daysUntil("2026-07-05");
  const recentDays = (entries || []).slice(-3);
  const trainedRecently = recentDays.filter(e => isTrue(e.trained)).length;
  const needsRest  = trainedRecently >= 2 || (readiness !== null && readiness < 45);
  const canIntense = readiness !== null && readiness >= 70;

  // Training: alleen als vandaag echt een activiteit heeft (todayData), niet gisteren
  const garminTrained = isTrue(todayData?.trained);
  const typeLabel = todayData?.train_type
    ? todayData.train_type.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())
    : "";
  const isRun = (todayData?.train_type || "").toLowerCase().includes("run");
  const trainDone = garminTrained;

  let trainTask;
  if (garminTrained) {
    const parts = [];
    if (todayData?.train_min) parts.push(`${todayData.train_min} min`);
    if (todayData?.train_dist) parts.push(`${todayData.train_dist} km`);
    if (todayData?.avg_hr) parts.push(`gem. ${todayData.avg_hr} bpm`);
    if (isRun && todayData?.avg_pace) parts.push(`${todayData.avg_pace}/km`);
    trainTask = { icon: isRun ? "🏃" : "💪", label: typeLabel || "Training", sub: parts.join(" · ") || "Gesynchroniseerd vanuit Garmin", color: C.orange, cat: "Training" };
  } else if (needsRest) {
    trainTask = { icon: "🧘", label: "Hersteldag", sub: "Lichte wandeling of rust — HRV vraagt herstel", color: C.teal, cat: "Herstel" };
  } else if (canIntense) {
    trainTask = race1Days > 42
      ? { icon: "🏃", label: "Zone 2 duurloop", sub: `45–55 min · HR ${last?.rhr ? Math.round(+last.rhr*1.6) : 130}–${last?.rhr ? Math.round(+last.rhr*1.75) : 145} bpm`, color: C.orange, cat: "Training" }
      : { icon: "🏃", label: "Tempolopen", sub: `30 min · 5×3 min @ racetempo + warming-up`, color: C.orange, cat: "Training" };
  } else {
    trainTask = { icon: "🚶", label: "Actief herstel", sub: "30 min wandeling of mobiliteitswerk", color: C.green, cat: "Training" };
  }

  // Slaap: bedtijd terugrekenen vanuit 6:30 wekker
  const WAKE_H = 6, WAKE_M = 30;           // wekker 06:30
  const SLEEP_GOAL = 7.5;                  // doel slaap in uren
  const FALL_ASLEEP_MIN = 15;              // inslaaptijd
  const totalBedMin = SLEEP_GOAL * 60 + FALL_ASLEEP_MIN;   // 465 min
  const bedH = Math.floor(((WAKE_H * 60 + WAKE_M) - totalBedMin + 1440) % 1440 / 60);
  const bedM = ((WAKE_H * 60 + WAKE_M) - totalBedMin + 1440) % 60;
  const bedTime = `${bedH}:${String(bedM).padStart(2, "0")}`;          // "23:00" ish... wait let's calc
  // 6:30 = 390 min. 390 - 465 = -75 → +1440 = 1365 min = 22:45
  // bedH = floor(1365/60) = 22, bedM = 1365%60 = 45 → 22:45
  const screenOffMin = ((WAKE_H * 60 + WAKE_M) - totalBedMin - 15 + 1440) % 1440; // 15 min buffer
  const screenOffH = Math.floor(screenOffMin / 60);
  const screenOffM = screenOffMin % 60;
  const screenOff = `${screenOffH}:${String(screenOffM).padStart(2, "0")}`;

  // slaap van vannacht staat in vandaag's sync (garmin logt slaap bij de ochtend)
  const sleepActual = !isNaN(parseNum(todayData?.sleep_h)) ? parseNum(todayData.sleep_h) : null;
  const sleepDone = sleepActual !== null && sleepActual >= SLEEP_GOAL;
  const sleepPrepped = isTrue(todayData?.sleep_prep);
  const sleepSub = sleepActual !== null
    ? `Gisternacht ${sleepActual}u · doel ${SLEEP_GOAL}u · bed om ${bedTime}`
    : `Schermen weg ${screenOff} · in bed om ${bedTime} · wekker 06:30`;

  const todaySteps = parseNum(todayData?.steps);
  return [
    { id: "morning", cat: "Ochtend", icon: "🌅", label: "Ochtendmeting", sub: "HRV & body battery ophalen via Garmin", color: C.blue, auto: true, done: !!todayData?.hrv },
    { id: "breathing", cat: "Mindfulness", icon: "🫁", label: "Box breathing", sub: "4×4 min · 4 tellen in-hold-uit-hold", color: C.purple, done: isTrue(todayData?.breathing) },
    { ...trainTask, id: "training", done: trainDone },
    { id: "steps", cat: "Beweging", icon: "👟", label: "Dagelijks stappendoel", sub: `${!isNaN(todaySteps) ? Math.round(todaySteps).toLocaleString("nl") : "—"} / 10.000 vandaag`, color: C.green, auto: true, done: todaySteps >= 10000 },
    { id: "checkin", cat: "Check-in", icon: "📋", label: "Dagelijkse check-in", sub: "Energie, gewicht, opmerkingen invullen", color: C.blue, done: !!(todayData?.date === today() && todayData?.energy) },
    { id: "sleep", cat: "Avond", icon: "🌙", label: "Slaapvoorbereiding", sub: sleepSub, color: C.indigo, done: sleepDone || sleepPrepped },
  ];
}

// ── Task detail content ───────────────────────────────────────────────────────
const TASK_DETAILS = {
  morning: {
    title: "Ochtendmeting",
    steps: [
      { icon: "⏰", text: "Meet direct na het wakker worden — nog voor koffie of beweging." },
      { icon: "🧘", text: "Ga rustig zitten of liggen. Adem 3× diep in en uit." },
      { icon: "⌚", text: "Open de Garmin Connect app → je ziet de HRV status en body battery van de afgelopen nacht." },
      { icon: "📊", text: "Noteer of de waarden groen/normaal zijn. Groen = goed herstel." },
    ],
    tip: "HRV (hartslagvariabiliteit) is je beste maatstaf voor herstel. Hoe hoger, hoe beter je lichaam klaar is voor inspanning.",
  },
  breathing: {
    title: "Box breathing",
    steps: [
      { icon: "🪑", text: "Ga rechtop zitten. Voeten plat op de grond, handen op de knieën." },
      { icon: "4️⃣", text: "INADEMEN — tel langzaam tot 4 (neus)." },
      { icon: "⏸", text: "VASTHOUDEN — tel tot 4. Niet inademen, niet uitademen." },
      { icon: "4️⃣", text: "UITADEMEN — tel langzaam tot 4 (mond)." },
      { icon: "⏸", text: "VASTHOUDEN — tel tot 4. Dan herhaal." },
      { icon: "🔄", text: "Herhaal 16–20 rondes (±4 minuten). Bouw op naar 8–10 minuten." },
    ],
    tip: "Box breathing activeert het parasympathisch zenuwstelsel — dit verlaagt cortisol, verbetert focus en verhoogt je HRV over tijd. Ideaal in de ochtend of voor een training.",
  },
  training: {
    title: "Training",
    steps: [
      { icon: "🌡", text: "Warming-up: 10 min rustig inlopen of dynamisch stretchen." },
      { icon: "🏃", text: "Volg het trainingsplan op basis van je readiness. Zone 2 = je kunt nog praten." },
      { icon: "💓", text: "Zone 2 HR = ±60–70% van je max hartslag. Voor jou ca. 130–145 bpm." },
      { icon: "❄", text: "Cool-down: 5–10 min rustig uitlopen + statisch stretchen." },
      { icon: "📱", text: "Sla de activiteit op in Garmin — wordt automatisch gesynchroniseerd." },
    ],
    tip: "Consistentie beats intensiteit. 80% van je trainingen hoort in Zone 2 te zitten voor optimale aerobe basis en HRV verbetering.",
  },
  steps: {
    title: "Dagelijks stappendoel",
    steps: [
      { icon: "🚶", text: "10.000 stappen per dag is de basislijn voor cardiovasculaire gezondheid." },
      { icon: "🕐", text: "Stap na elke maaltijd 10 minuten — helpt bloedsuiker te reguleren." },
      { icon: "🪜", text: "Neem de trap, parkeer wat verder weg, stap tussendoor even buiten." },
      { icon: "📱", text: "Garmin telt automatisch — je ziet de voortgang live in de app." },
    ],
    tip: "Stappen tellen mee voor je dagelijkse beweging maar zijn iets anders dan een training. Beide zijn belangrijk.",
  },
  checkin: {
    title: "Dagelijkse check-in",
    steps: [
      { icon: "⚖", text: "Weeg jezelf — bij voorkeur 's ochtends na het toilet, voor het eten." },
      { icon: "⚡", text: "Beoordeel je energieniveau: 1–10. Eerlijk en intuïtief." },
      { icon: "🫀", text: "Bloeddruk meten als je een manchet hebt — ideaal <120/80 mmHg." },
      { icon: "📝", text: "Noteer iets opmerkelijks: stress, voeding, pijn, gevoel." },
      { icon: "💾", text: "Sla op — data wordt naar Google Sheets geschreven." },
    ],
    tip: "Dagelijkse check-ins bouwen over weken een patroon op. De AI-coach gebruikt deze data voor persoonlijk advies.",
  },
  sleep: {
    title: "Slaapvoorbereiding",
    steps: [
      { icon: "📵", text: "22:30 — schermen uit of op nachtmodus. Blauw licht remt melatonine 1–2 uur." },
      { icon: "🛏", text: "In bed om 22:45. Wekker staat op 06:30 → geeft je 7,5u slaap + inslaaptijd." },
      { icon: "🌡", text: "Slaapkamer koel: 16–19°C is optimaal voor diepe slaap en HRV herstel." },
      { icon: "📖", text: "10 min lezen of journalen — zet gedachten van de dag neer, ruimte je hoofd leeg." },
      { icon: "🌬", text: "4-7-8 ademhaling: inademen 4 tellen · vasthouden 7 · uitademen 8. Doe 4 ronden." },
      { icon: "⌚", text: "Laat je Garmin aan — sleep tracking start automatisch, HRV wordt 's nachts gemeten." },
    ],
    tip: "Slaap vóór middernacht telt zwaarder voor herstel. Om 22:45 slapen geeft meer diepe slaap dan om 00:45 — zelfs met dezelfde totale duur.",
  },
};

// ── Coaching ──────────────────────────────────────────────────────────────────
async function fetchCoaching(entries, question) {
  const recent = entries.slice(-7);
  const todayStr = today();
  const todayRow = recent.find(e => e.date === todayStr);
  const prompt = `Je bent een warme maar directe personal health & performance coach. Analyseer en geef concrete coaching.

VANDAAG: ${todayStr}
DATA (laatste 7 dagen): ${JSON.stringify(recent, null, 2)}
${todayRow ? `VANDAAG (${todayStr}) DATA BESCHIKBAAR: HRV=${todayRow.hrv}, slaap=${todayRow.sleep_h}u, battery=${todayRow.body_battery}, stress=${todayRow.stress}` : `VANDAAG (${todayStr}): nog geen sync — meest recente rij is van ${recent[recent.length-1]?.date}`}

CONTEXT/VRAAG: ${question || "Geef mijn dagelijkse check-in analyse."}

DOELEN: hogere HRV, optimale slaap, energiek wakker, betere gezondheid, innerlijke rust.
WEDSTRIJDEN: 10km 5 juli 2026 Noordwijk · Gym-race 4 oktober 2026 Utrecht.
HARDLOOP METRICS: avg_pace (min:sec/km), cadence (ideaal ~180), ground_contact (ideaal <250ms), vertical_osc (ideaal <9cm), vertical_ratio (ideaal <8%), stride_length. Analyseer loopefficiëntie als beschikbaar.

Antwoord in EXACT deze structuur:
### Hoe sta je ervoor
### 3 Belangrijkste inzichten
### Doe dit vandaag
### Training advies
### Herstel & rust
### Dit vraagt aandacht

Warm, bemoedigend maar eerlijk. Concreet en persoonlijk. Max 350 woorden.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": CLAUDE_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1000, messages: [{ role: "user", content: prompt }] })
  });
  const d = await res.json();
  return d.content?.find(b => b.type === "text")?.text || "Geen analyse beschikbaar.";
}

// ── Design tokens ─────────────────────────────────────────────────────────────
const C = {
  bg:      "#F2F2F7",
  card:    "#FFFFFF",
  blue:    "#007AFF",
  green:   "#34C759",
  red:     "#FF3B30",
  orange:  "#FF9500",
  purple:  "#AF52DE",
  teal:    "#5AC8FA",
  indigo:  "#5856D6",
  yellow:  "#FFCC00",
  text:    "#000000",
  text2:   "#3C3C43",
  text3:   "#8E8E93",
  border:  "rgba(60,60,67,0.12)",
  fill:    "rgba(120,120,128,0.08)",
};

const readinessColor = (s) => s >= 75 ? C.green : s >= 50 ? C.orange : C.red;
const readinessLabel = (s) => s >= 75 ? "Klaar" : s >= 50 ? "Matig" : "Herstel";

// ── Event performance score ───────────────────────────────────────────────────
// Combineert: HRV trend, trainingsvolume, gemiddelde slaap, VO2max
function calcEventScore(entries) {
  if (!entries || entries.length < 3) return null;
  const recent = entries.slice(-21); // laatste 3 weken

  // 1. HRV trend: stijgend = goed
  const hrvVals = numArr(recent, "hrv");
  let hrvScore = 50;
  if (hrvVals.length >= 4) {
    const half = Math.floor(hrvVals.length / 2);
    const firstHalf = hrvVals.slice(0, half).reduce((a,b) => a+b, 0) / half;
    const secondHalf = hrvVals.slice(half).reduce((a,b) => a+b, 0) / (hrvVals.length - half);
    hrvScore = 50 + Math.min(30, Math.max(-30, (secondHalf - firstHalf) / firstHalf * 150));
  }

  // 2. Trainingsvolume: aantal trainingsdagen in 3 weken (doel 9–12)
  const trainDays = recent.filter(e => isTrue(e.trained)).length;
  const volScore = Math.min(100, (trainDays / 10) * 100);

  // 3. Slaapkwaliteit gemiddeld vs doel 7.5u
  const sleepVals = numArr(recent, "sleep_h");
  const avgSleep = sleepVals.length ? sleepVals.reduce((a,b) => a+b,0) / sleepVals.length : 7;
  const sleepScore = Math.min(100, (avgSleep / 7.5) * 100);

  // 4. VO2max als beschikbaar
  const vo2Vals = numArr(entries.slice(-30), "vo2max").filter(v => v > 30);
  const vo2Score = vo2Vals.length ? Math.min(100, ((vo2Vals[vo2Vals.length-1] - 35) / 25) * 100) : 50;

  const score = Math.round(hrvScore * 0.35 + volScore * 0.35 + sleepScore * 0.2 + vo2Score * 0.1);
  return Math.max(0, Math.min(100, score));
}

// Drempels schalen op basis van resterende dagen:
// - >120 dagen: ruim de tijd, wees soepeler (score 35+ = ok)
// - 60–120 dagen: opbouwfase, gemiddeld streng (score 45+ = ok)
// - <60 dagen: peaking, streng (score 60+ nodig voor groen)
function eventScoreThresholds(daysLeft) {
  if (daysLeft > 120) return { green: 60, orange: 35 };
  if (daysLeft > 60)  return { green: 65, orange: 45 };
  return                     { green: 70, orange: 55 };
}
const eventScoreColor = (s, daysLeft) => {
  const t = eventScoreThresholds(daysLeft ?? 999);
  return s >= t.green ? C.green : s >= t.orange ? C.orange : C.red;
};
const eventScoreLabel = (s, daysLeft) => {
  const t = eventScoreThresholds(daysLeft ?? 999);
  return s >= t.green ? "Op schema" : s >= t.orange ? "Bijsturen" : "Aandacht";
};

// ── Sub-components ────────────────────────────────────────────────────────────
const Ring = ({ value, max = 100, color, size = 120, stroke = 10 }) => {
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const pct = Math.min(Math.max(value || 0, 0), max) / max;
  return (
    <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color + "22"} strokeWidth={stroke} />
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth={stroke}
        strokeDasharray={circ} strokeDashoffset={circ * (1 - pct)} strokeLinecap="round"
        style={{ transition: "stroke-dashoffset 0.6s ease" }} />
    </svg>
  );
};

const Sparkline = ({ data, color, height = 40 }) => {
  if (!data || data.length < 2) return null;
  const min = Math.min(...data), max = Math.max(...data), range = max - min || 1;
  const W = 200, H = height, p = 3;
  const pts = data.map((v, i) => {
    const x = p + (i / (data.length - 1)) * (W - p * 2);
    const y = H - p - ((v - min) / range) * (H - p * 2);
    return `${x},${y}`;
  }).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height }} preserveAspectRatio="none">
      <polyline fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" points={pts} />
    </svg>
  );
};

const Toggle = ({ checked, onChange }) => (
  <label style={{ position: "relative", display: "inline-block", width: 51, height: 31, flexShrink: 0, cursor: "pointer" }}>
    <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} style={{ opacity: 0, width: 0, height: 0 }} />
    <span style={{ position: "absolute", inset: 0, borderRadius: 31, transition: "0.2s", background: checked ? C.green : "rgba(120,120,128,0.3)" }}>
      <span style={{
        position: "absolute", height: 27, width: 27, left: checked ? 21 : 2, top: 2,
        borderRadius: "50%", background: "#FFF", transition: "0.2s",
        boxShadow: "0 2px 6px rgba(0,0,0,0.25)"
      }} />
    </span>
  </label>
);

const Stepper = ({ label, value, onChange, step = 1, min = 0, max = 99, unit = "" }) => {
  const val = isNaN(parseFloat(value)) ? 0 : parseFloat(value);
  const dec = String(step).includes(".") ? String(step).split(".")[1].length : 0;
  return (
    <div style={{ background: C.fill, borderRadius: 16, padding: "16px 20px" }}>
      <div style={{ fontSize: 13, color: C.text3, marginBottom: 10 }}>{label}</div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <button onPointerDown={() => onChange(Math.max(min, parseFloat((val - step).toFixed(dec))))}
          style={{ width: 48, height: 48, borderRadius: 24, background: C.card, border: `1px solid ${C.border}`, fontSize: 26, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 300, color: C.text, flexShrink: 0 }}>−</button>
        <div style={{ textAlign: "center", flex: 1 }}>
          <span style={{ fontSize: 32, fontWeight: 700, letterSpacing: "-0.5px" }}>{dec > 0 ? val.toFixed(dec) : val}</span>
          {unit && <span style={{ fontSize: 14, color: C.text3, marginLeft: 4 }}>{unit}</span>}
        </div>
        <button onPointerDown={() => onChange(Math.min(max, parseFloat((val + step).toFixed(dec))))}
          style={{ width: 48, height: 48, borderRadius: 24, background: C.card, border: `1px solid ${C.border}`, fontSize: 26, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 300, color: C.text, flexShrink: 0 }}>+</button>
      </div>
    </div>
  );
};

const MOOD_OPTIONS = [
  { v: 1, emoji: "😔", label: "Slecht" },
  { v: 2, emoji: "😕", label: "Matig" },
  { v: 3, emoji: "😐", label: "Oké" },
  { v: 4, emoji: "🙂", label: "Goed" },
  { v: 5, emoji: "😊", label: "Top" },
];
const MoodPicker = ({ value, onChange }) => (
  <div style={{ display: "flex", gap: 8, justifyContent: "space-between" }}>
    {MOOD_OPTIONS.map(m => {
      const sel = String(value) === String(m.v);
      return (
        <button key={m.v} onPointerDown={() => onChange(m.v)}
          style={{ flex: 1, background: sel ? C.blue + "18" : C.fill, border: sel ? `2px solid ${C.blue}` : "2px solid transparent", borderRadius: 14, padding: "10px 4px", cursor: "pointer", textAlign: "center" }}>
          <div style={{ fontSize: 26 }}>{m.emoji}</div>
          <div style={{ fontSize: 10, color: sel ? C.blue : C.text3, marginTop: 3, fontWeight: sel ? 600 : 400 }}>{m.label}</div>
        </button>
      );
    })}
  </div>
);

const Field = ({ label, children }) => (
  <div>
    <div style={{ fontSize: 13, color: C.text3, fontWeight: 400, marginBottom: 6 }}>{label}</div>
    {children}
  </div>
);

// ── Main App ──────────────────────────────────────────────────────────────────
export default function App() {
  const [entries,   setEntries]   = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [syncing,   setSyncing]   = useState(false);
  const [tab,       setTab]       = useState("vandaag");
  const [entry,     setEntry]     = useState({ ...EMPTY, date: today() });
  const [coaching,  setCoaching]  = useState("");
  const [coachLoad, setCoachLoad] = useState(false);
  const [question,  setQuestion]  = useState("");
  const [saveMsg,   setSaveMsg]   = useState("");
  const [sheetMode, setSheetMode] = useState(!!SHEET_ID);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [planDone,    setPlanDone]    = useState({});
  const [taskDetail,  setTaskDetail]  = useState(null);
  const [viewDate,    setViewDate]    = useState(today());
  const [planned,     setPlanned]     = useState([]);
  const [touchStartX, setTouchStartX] = useState(null);

  const loadData = useCallback(async () => {
    if (!sheetMode) {
      try {
        const raw = JSON.parse(localStorage.getItem("coach_v2") || "{}");
        setEntries(Object.values(raw).sort((a, b) => a.date.localeCompare(b.date)));
      } catch {}
      setLoading(false);
      setLastRefresh(new Date());
      return;
    }
    try {
      const [res, plannedData] = await Promise.all([sheetsGet(), sheetsGetPlanned().catch(() => [])]);
      const rows = res.values || [];
      if (rows.length >= 2) {
        const hdrs = rows[0];
        const data = rows.slice(1).map(r => {
          const obj = {};
          hdrs.forEach((h, i) => { obj[h] = r[i] ?? ""; });
          return obj;
        }).sort((a, b) => a.date.localeCompare(b.date));
        setEntries(data);
      }
      setPlanned(plannedData);
      setLastRefresh(new Date());
    } catch (e) {
      console.error("Sheets load error:", e);
      setSheetMode(false);
    }
    setLoading(false);
  }, [sheetMode]);

  useEffect(() => { loadData(); }, [loadData]);

  // Auto-refresh: elke 5 minuten én bij terugkeren naar de app
  useEffect(() => {
    const interval = setInterval(loadData, 5 * 60 * 1000);
    const onVisible = () => { if (document.visibilityState === "visible") loadData(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [loadData]);

  // Prefill checkin form: bestaande data of gisteren's waarden voor handmatige velden
  const PREFILL_FIELDS = ["weight", "alcohol", "bp_sys", "bp_dia", "energy", "stress", "mental_unrest", "notes"];
  useEffect(() => {
    const existing = entries.find(e => e.date === entry.date);
    if (existing) {
      setEntry({ ...EMPTY, ...existing });
    } else {
      const prev = [...entries].filter(e => e.date < entry.date).slice(-1)[0];
      const base = { ...EMPTY, date: entry.date };
      if (prev) PREFILL_FIELDS.forEach(k => { if (prev[k] !== "" && prev[k] != null) base[k] = prev[k]; });
      setEntry(base);
    }
  }, [entry.date, entries]);

  const saveEntry = async () => {
    setSyncing(true);
    const row = HEADERS.map(h => entry[h] ?? "");
    try {
      if (sheetMode) {
        const res    = await sheetsGet();
        const rows   = res.values || [];
        const dates  = rows.slice(1).map(r => r[0]);
        const rowIdx = dates.indexOf(entry.date);
        if (rowIdx >= 0) await sheetsUpdate(rowIdx + 2, row);
        else await sheetsAppend(row);
      } else {
        const raw = JSON.parse(localStorage.getItem("coach_v2") || "{}");
        raw[entry.date] = entry;
        localStorage.setItem("coach_v2", JSON.stringify(raw));
      }
      await loadData();
      setSaveMsg("Opgeslagen!");
    } catch {
      setSaveMsg("Fout bij opslaan");
    }
    setSyncing(false);
    setTimeout(() => setSaveMsg(""), 2500);
  };

  // Auto-save a single field for the viewed date (used by plan item toggles)
  const autoSaveField = async (key, value, targetDate) => {
    const date = targetDate || today();
    const base = entries.find(e => e.date === date) || { ...EMPTY, date };
    const updated = { ...base, [key]: value };
    if (entry.date === date) setEntry(updated);
    const row = HEADERS.map(h => updated[h] ?? "");
    try {
      if (sheetMode) {
        const res   = await sheetsGet();
        const rows  = res.values || [];
        const dates = rows.slice(1).map(r => r[0]);
        const idx   = dates.indexOf(date);
        if (idx >= 0) await sheetsUpdate(idx + 2, row);
        else await sheetsAppend(row);
      } else {
        const raw = JSON.parse(localStorage.getItem("coach_v2") || "{}");
        raw[date] = updated;
        localStorage.setItem("coach_v2", JSON.stringify(raw));
      }
      await loadData();
    } catch (e) { console.error("autoSave error:", e); }
  };

  const runCoach = async () => {
    setCoachLoad(true); setCoaching("");
    try {
      const result = await fetchCoaching(entries.length ? entries : [entry], question);
      setCoaching(result);
    } catch { setCoaching("Fout bij ophalen coaching."); }
    setCoachLoad(false);
  };

  const set = (k, v) => setEntry(p => ({ ...p, [k]: v }));

  const last        = entries[entries.length - 1];
  const todayEntry  = entries.find(e => e.date === today());
  // Navigation: entry dates + always include today as last option
  const entryDates  = [...new Set(entries.map(e => e.date))].sort();
  const sortedDates = entryDates.includes(today()) ? entryDates : [...entryDates, today()];
  // effectiveViewDate defaults to today, regardless of whether there's a Sheets row
  const effectiveViewDate = sortedDates.includes(viewDate) ? viewDate : today();
  // displayEntry: alleen werkelijke data van die dag (geen fallback naar gisteren)
  const displayEntry = entries.find(e => e.date === effectiveViewDate) || null;
  // contextEntry: voor readiness/plan mag je de laatste bekende data gebruiken
  const contextEntry = displayEntry || (effectiveViewDate === today() ? last : null);
  const viewIdx     = sortedDates.indexOf(effectiveViewDate);
  const prevDate    = viewIdx > 0 ? sortedDates[viewIdx - 1] : null;
  const nextDate    = viewIdx < sortedDates.length - 1 ? sortedDates[viewIdx + 1] : null;
  const isToday     = effectiveViewDate === today();

  const race1      = daysUntil("2026-07-05");
  const race2      = daysUntil("2026-10-04");
  const readiness  = calcReadiness(contextEntry, entries);
  const eventScore = calcEventScore(entries);
  const plan       = getDailyPlan(displayEntry, contextEntry, entries);
  const doneTasks  = plan.filter(t => t.done || planDone[t.id]).length;

  const hour = new Date().getHours();
  const greeting = hour < 6 ? "Goedenacht" : hour < 12 ? "Goedemorgen" : hour < 18 ? "Goedemiddag" : "Goedenavond";

  const TABS = [
    { id: "vandaag",  icon: "house",    label: "Vandaag"  },
    { id: "coach",    icon: "brain",    label: "Coach"    },
    { id: "checkin",  icon: "plus",     label: "Invullen" },
    { id: "trends",   icon: "chart",    label: "Trends"   },
    { id: "setup",    icon: "gear",     label: "Meer"     },
  ];

  if (loading) return (
    <div style={{ background: C.bg, minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "system-ui" }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ position: "relative", width: 80, height: 80, margin: "0 auto 20px" }}>
          <Ring value={75} color={C.green} size={80} stroke={7} />
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28 }}>💚</div>
        </div>
        <div style={{ color: C.text3, fontSize: 15 }}>Laden...</div>
      </div>
    </div>
  );

  // ── Task detail modal ─────────────────────────────────────────────────────
  const detail = taskDetail ? (TASK_DETAILS[taskDetail.id] || { title: taskDetail.label, steps: [], tip: null }) : null;
  const TaskModal = detail && (
    <div onClick={() => setTaskDetail(null)} style={{
      position: "fixed", inset: 0, zIndex: 999,
      background: "rgba(0,0,0,0.45)", backdropFilter: "blur(4px)",
      display: "flex", alignItems: "flex-end", justifyContent: "center",
      cursor: "pointer"
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: C.card, borderRadius: "20px 20px 0 0",
        width: "100%", maxWidth: 640, maxHeight: "80vh",
        overflowY: "auto", padding: "0 0 40px", cursor: "default"
      }}>
        {/* Handle */}
        <div style={{ display: "flex", justifyContent: "center", padding: "12px 0 0" }}>
          <div style={{ width: 36, height: 4, borderRadius: 2, background: C.fill }} />
        </div>
        {/* Header */}
        <div style={{ padding: "16px 20px 20px", borderBottom: `1px solid ${C.separator}`, display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ width: 48, height: 48, borderRadius: 14, background: taskDetail.color + "18", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24, flexShrink: 0 }}>
            {taskDetail.icon}
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 18, fontWeight: 700 }}>{detail.title}</div>
            <div style={{ fontSize: 13, color: C.text3, marginTop: 2 }}>{taskDetail.sub}</div>
          </div>
          <button onClick={() => setTaskDetail(null)} style={{ width: 32, height: 32, borderRadius: 16, background: C.fill, border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, color: C.text3, flexShrink: 0 }}>✕</button>
        </div>
        {/* Steps */}
        <div style={{ padding: "20px 20px 0" }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: C.text3, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 12 }}>Hoe doe je het</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {detail.steps.map((s, i) => (
              <div key={i} style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                <div style={{ width: 36, height: 36, borderRadius: 10, background: C.fill, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, flexShrink: 0 }}>{s.icon}</div>
                <div style={{ fontSize: 15, color: C.text, lineHeight: 1.5, paddingTop: 7 }}>{s.text}</div>
              </div>
            ))}
          </div>
          {detail.tip && (
            <div style={{ marginTop: 20, background: taskDetail.color + "12", borderRadius: 12, padding: "12px 16px" }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: taskDetail.color, marginBottom: 4 }}>WAAROM DIT WERKT</div>
              <div style={{ fontSize: 14, color: C.text, lineHeight: 1.5 }}>{detail.tip}</div>
            </div>
          )}
          {/* Mark done / undone buttons */}
          {!taskDetail.auto && (() => {
            const isDone = taskDetail.done || !!planDone[taskDetail.id];
            const field  = PLAN_FIELD[taskDetail.id]; // mapped Sheets field, or undefined

            const markDone = async (val) => {
              if (field) {
                await autoSaveField(field, val ? "true" : "false", today());
              } else {
                setPlanDone(p => ({ ...p, [taskDetail.id]: val }));
              }
              setTaskDetail(null);
            };

            return isDone ? (
              <div style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, background: C.green + "15", borderRadius: 12, padding: "12px 16px" }}>
                  <span style={{ fontSize: 18 }}>✅</span>
                  <span style={{ fontSize: 15, color: C.green, fontWeight: 600 }}>Gedaan vandaag · {field ? "Opgeslagen in Sheets" : "Lokaal"}</span>
                </div>
                <button onClick={() => markDone(false)}
                  style={{ width: "100%", background: C.fill, color: C.text3, border: "none", borderRadius: 14, padding: "14px", fontSize: 15, fontWeight: 600, cursor: "pointer" }}>
                  Toch niet gedaan
                </button>
              </div>
            ) : (
              <button onClick={() => markDone(true)}
                style={{ marginTop: 20, width: "100%", background: taskDetail.color, color: "#fff", border: "none", borderRadius: 14, padding: "14px", fontSize: 16, fontWeight: 600, cursor: "pointer" }}>
                Markeer als gedaan ✓
              </button>
            );
          })()}
        </div>
      </div>
    </div>
  );

  return (
    <div style={{ fontFamily: "-apple-system, 'SF Pro Display', system-ui, sans-serif", background: C.bg, minHeight: "100vh", color: C.text }}>
      {TaskModal}
      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
        input, select, textarea {
          background: ${C.fill} !important;
          border: none !important;
          color: ${C.text} !important;
          border-radius: 10px;
          padding: 11px 14px;
          font-family: inherit;
          font-size: 16px;
          width: 100%;
          outline: none;
          -webkit-appearance: none;
          appearance: none;
        }
        input:focus, select:focus, textarea:focus { background: rgba(120,120,128,0.14) !important; }
        @keyframes fadeUp { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes pulse  { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
        .fade { animation: fadeUp .3s ease; }
        ::-webkit-scrollbar { display: none; }
      `}</style>

      {/* ── VANDAAG ── */}
      {tab === "vandaag" && (
        <div className="fade" style={{ paddingBottom: 90 }}
          onTouchStart={e => setTouchStartX(e.touches[0].clientX)}
          onTouchEnd={e => {
            if (touchStartX === null) return;
            const dx = e.changedTouches[0].clientX - touchStartX;
            setTouchStartX(null);
            if (dx > 60 && prevDate) setViewDate(prevDate);
            if (dx < -60 && nextDate) setViewDate(nextDate);
          }}
        >
          {/* Header */}
          <div style={{ background: C.card, paddingTop: "env(safe-area-inset-top, 44px)", borderBottom: `1px solid ${C.border}` }}>
            <div style={{ maxWidth: 640, margin: "0 auto" }}>
              {/* Sync status bar */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", padding: "6px 16px 0", gap: 6 }}>
                <div style={{
                  width: 7, height: 7, borderRadius: "50%",
                  background: isToday && displayEntry ? C.green : isToday && !displayEntry ? C.orange : C.text3,
                  flexShrink: 0
                }} />
                <span style={{ fontSize: 11, color: C.text3 }}>
                  {isToday && displayEntry
                    ? `Garmin sync ${fmt(displayEntry.date)}`
                    : isToday && contextEntry
                    ? `Laatste sync ${fmt(contextEntry.date)}`
                    : fmt(effectiveViewDate)}
                  {lastRefresh ? ` · ${lastRefresh.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" })}` : ""}
                </span>
                <button onClick={loadData} style={{ background: "none", border: "none", cursor: "pointer", padding: "2px 4px", color: C.text3, fontSize: 13, lineHeight: 1 }}>↻</button>
              </div>
              {/* Day nav row */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 16px 14px" }}>
                <button onClick={() => prevDate && setViewDate(prevDate)}
                  style={{ width: 36, height: 36, borderRadius: 18, background: "transparent", border: "none", cursor: prevDate ? "pointer" : "default", display: "flex", alignItems: "center", justifyContent: "center", opacity: prevDate ? 1 : 0, flexShrink: 0 }}>
                  <svg width="9" height="15" viewBox="0 0 9 15" fill="none"><path d="M8 1L2 7.5 8 14" stroke={C.text3} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>
                </button>
                <div style={{ textAlign: "center", flex: 1 }}>
                  <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.5px", lineHeight: 1.2 }}>
                    {new Date(effectiveViewDate + "T12:00:00").toLocaleDateString("nl-NL", { weekday: "long" }).replace(/^\w/, c => c.toUpperCase())}
                  </div>
                  <div style={{ fontSize: 13, color: C.text3, marginTop: 1 }}>
                    {new Date(effectiveViewDate + "T12:00:00").toLocaleDateString("nl-NL", { day: "numeric", month: "long", year: "numeric" })}
                  </div>
                  <div style={{ fontSize: 12, color: C.blue, marginTop: 2, fontWeight: 500, opacity: isToday ? 1 : 0 }}>{greeting}</div>
                </div>
                <button onClick={() => nextDate && setViewDate(nextDate)}
                  style={{ width: 36, height: 36, borderRadius: 18, background: "transparent", border: "none", cursor: nextDate ? "pointer" : "default", display: "flex", alignItems: "center", justifyContent: "center", opacity: nextDate ? 1 : 0, flexShrink: 0 }}>
                  <svg width="9" height="15" viewBox="0 0 9 15" fill="none"><path d="M1 1l6 6.5L1 14" stroke={C.text3} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>
                </button>
              </div>
            </div>
          </div>

          <div style={{ maxWidth: 640, margin: "0 auto", padding: "16px 16px 0" }}>


            {/* Readiness card */}
            <div style={{ background: C.card, borderRadius: 16, padding: "20px", marginBottom: 12, display: "flex", alignItems: "center", gap: 20 }}>
              <div style={{ position: "relative", flexShrink: 0 }}>
                <Ring value={readiness != null && !isNaN(readiness) ? readiness : 0} color={readiness != null && !isNaN(readiness) ? readinessColor(readiness) : C.text3} size={96} stroke={9} />
                <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
                  <div style={{ fontSize: 22, fontWeight: 700, color: readiness != null && !isNaN(readiness) ? readinessColor(readiness) : C.text3, lineHeight: 1 }}>{readiness != null && !isNaN(readiness) ? readiness : "—"}</div>
                  <div style={{ fontSize: 10, color: C.text3, marginTop: 1 }}>{readiness != null && !isNaN(readiness) ? readinessLabel(readiness) : "Geen data"}</div>
                </div>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 10 }}>Readiness</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 16px" }}>
                  {[
                    { l: "HRV",    v: contextEntry?.hrv,          u: " ms",  c: C.green  },
                    { l: "Slaap",  v: contextEntry?.sleep_h,      u: " u",   c: C.indigo },
                    { l: "Stress", v: contextEntry?.stress,       u: "",     c: C.orange },
                    { l: "Battery",v: contextEntry?.body_battery, u: "%",    c: C.teal   },
                  ].map(m => {
                    const val = parseNum(m.v);
                    return (
                      <div key={m.l} style={{ display: "flex", justifyContent: "space-between" }}>
                        <span style={{ fontSize: 12, color: C.text3 }}>{m.l}</span>
                        <span style={{ fontSize: 13, fontWeight: 600, color: !isNaN(val) ? m.c : C.text3 }}>{!isNaN(val) ? `${m.v}${m.u}` : "—"}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Daily plan */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
              <div style={{ fontSize: 17, fontWeight: 600 }}>Plan voor vandaag</div>
              <div style={{ fontSize: 13, color: C.text3 }}>{doneTasks}/{plan.length}</div>
            </div>
            <div style={{ height: 3, background: C.fill, borderRadius: 2, marginBottom: 12, overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${(doneTasks/plan.length)*100}%`, background: C.green, borderRadius: 2, transition: "width 0.4s ease" }} />
            </div>

            <div style={{ background: C.card, borderRadius: 16, overflow: "hidden", marginBottom: 12 }}>
              {plan.map((task, i) => {
                const done = task.done || !!planDone[task.id];
                return (
                  <div key={task.id} onClick={() => setTaskDetail({ ...task, done })}
                    style={{
                      padding: "14px 16px", display: "flex", alignItems: "center", gap: 14,
                      cursor: "pointer",
                      borderBottom: i < plan.length - 1 ? `1px solid ${C.border}` : "none",
                    }}>
                    {/* Check circle */}
                    <div style={{
                      width: 28, height: 28, borderRadius: 14, flexShrink: 0,
                      background: done ? task.color : "transparent",
                      border: done ? "none" : `2px solid ${C.border}`,
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}>
                      {done && <svg width="14" height="11" viewBox="0 0 14 11" fill="none"><path d="M1 5l4 4 8-8" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 15, fontWeight: 500, color: done ? C.text3 : C.text, textDecoration: done ? "line-through" : "none" }}>{task.label}</div>
                      <div style={{ fontSize: 12, color: C.text3, marginTop: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{task.sub}</div>
                    </div>
                    <svg width="7" height="12" viewBox="0 0 7 12" fill="none"><path d="M1 1l5 5-5 5" stroke={C.text3} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  </div>
                );
              })}
            </div>

            {/* Run stats for displayed entry */}
            {displayEntry?.avg_pace && (
              <div style={{ background: C.card, borderRadius: 16, padding: 16, marginBottom: 12 }}>
                <div style={{ fontSize: 13, color: C.text3, fontWeight: 600, marginBottom: 12, textTransform: "uppercase", letterSpacing: "0.04em" }}>Hardlooptraining</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
                  {[
                    { l: "Tempo",   v: displayEntry.avg_pace,       u: "/km" },
                    { l: "Cadans",  v: displayEntry.cadence,        u: "spm" },
                    { l: "Afstand", v: displayEntry.train_dist,     u: "km"  },
                    { l: "GCT",     v: displayEntry.ground_contact, u: "ms"  },
                    { l: "V. Osc.", v: displayEntry.vertical_osc,   u: "cm"  },
                    { l: "HR gem.", v: displayEntry.avg_hr,         u: "bpm" },
                  ].filter(m => m.v).map(m => (
                    <div key={m.l} style={{ textAlign: "center" }}>
                      <div style={{ fontSize: 11, color: C.text3, marginBottom: 3 }}>{m.l}</div>
                      <div style={{ fontSize: 16, fontWeight: 700 }}>{m.v}<span style={{ fontSize: 10, color: C.text3, fontWeight: 400 }}> {m.u}</span></div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Aankomende events */}
            {(() => {
              const sc = eventScore;
              const events = [
                { name: "10K Noordwijk", date: "2026-07-05", days: race1, icon: "🏃" },
                { name: "Gym-race Utrecht", date: "2026-10-04", days: race2, icon: "💪" },
              ];
              return (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 10 }}>Aankomende events</div>
                  <div style={{ background: C.card, borderRadius: 16, overflow: "hidden" }}>
                    {events.map((ev, i) => {
                      const urgency = ev.days < 14 ? C.red : ev.days < 42 ? C.orange : C.green;
                      const scColor = sc != null ? eventScoreColor(sc, ev.days) : C.text3;
                      const scLabel = sc != null ? eventScoreLabel(sc, ev.days) : "Geen data";
                      return (
                        <div key={ev.name} style={{ padding: "16px", borderBottom: i < events.length - 1 ? `1px solid ${C.border}` : "none" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                            <div style={{ width: 42, height: 42, borderRadius: 12, background: urgency + "15", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, flexShrink: 0 }}>
                              {ev.icon}
                            </div>
                            <div style={{ flex: 1 }}>
                              <div style={{ fontSize: 15, fontWeight: 600 }}>{ev.name}</div>
                              <div style={{ fontSize: 12, color: C.text3, marginTop: 2 }}>
                                {new Date(ev.date + "T12:00:00").toLocaleDateString("nl-NL", { day: "numeric", month: "long", year: "numeric" })}
                              </div>
                            </div>
                            <div style={{ textAlign: "right" }}>
                              <div style={{ fontSize: 22, fontWeight: 700, color: urgency, lineHeight: 1 }}>{ev.days}</div>
                              <div style={{ fontSize: 11, color: C.text3 }}>dagen</div>
                            </div>
                          </div>
                          {/* Performance indicator — drempels schalen op resterende tijd */}
                          {sc != null && (
                            <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 10 }}>
                              <div style={{ flex: 1, height: 6, background: C.fill, borderRadius: 3, overflow: "hidden" }}>
                                <div style={{ height: "100%", width: `${sc}%`, background: scColor, borderRadius: 3, transition: "width 0.6s ease" }} />
                              </div>
                              <div style={{ fontSize: 12, fontWeight: 600, color: scColor, minWidth: 70, textAlign: "right" }}>
                                {scLabel} · {sc}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}

            {/* Geplande trainingen uit Garmin coach plan */}
            {planned.length > 0 && (() => {
              const upcoming = planned.filter(p => p.date >= today()).slice(0, 7);
              if (!upcoming.length) return null;
              const sportIcon = (s) => s?.includes("run") ? "🏃" : s?.includes("cycl") ? "🚴" : s?.includes("swim") ? "🏊" : "💪";
              const dayLabel = (d) => {
                const diff = Math.ceil((new Date(d) - new Date(today())) / 86400000);
                if (diff === 0) return "Vandaag";
                if (diff === 1) return "Morgen";
                return new Date(d + "T12:00:00").toLocaleDateString("nl-NL", { weekday: "short", day: "numeric", month: "short" });
              };
              return (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 10 }}>Garmin trainingsplan</div>
                  <div style={{ background: C.card, borderRadius: 16, overflow: "hidden" }}>
                    {upcoming.map((p, i) => (
                      <div key={p.date + p.title} style={{ padding: "13px 16px", display: "flex", alignItems: "center", gap: 14, borderBottom: i < upcoming.length - 1 ? `1px solid ${C.border}` : "none" }}>
                        <div style={{ width: 36, height: 36, borderRadius: 10, background: C.orange + "15", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, flexShrink: 0 }}>
                          {sportIcon(p.sport)}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 15, fontWeight: 500 }}>{p.title}</div>
                          <div style={{ fontSize: 12, color: C.text3, marginTop: 1 }}>{dayLabel(p.date)}</div>
                        </div>
                        {p.date === today() && (
                          <div style={{ fontSize: 11, fontWeight: 600, color: C.orange, background: C.orange + "15", padding: "3px 8px", borderRadius: 20 }}>Vandaag</div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}

            {sheetMode && (
              <button onClick={loadData} style={{ width: "100%", background: C.fill, border: "none", borderRadius: 12, padding: "12px 16px", fontSize: 14, color: C.text3, cursor: "pointer", marginBottom: 4, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                <span>↻</span>
                <span>Ververs data{lastRefresh ? ` · ${lastRefresh.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" })}` : ""}</span>
              </button>
            )}
            {!sheetMode && (
              <div style={{ background: C.orange + "15", borderRadius: 12, padding: "12px 16px", fontSize: 13, color: C.orange }}>
                Lokale modus — configureer Google Sheets via Meer → Instellingen.
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── COACH ── */}
      {tab === "coach" && (
        <div className="fade" style={{ maxWidth: 640, margin: "0 auto", padding: "56px 16px 90px" }}>
          <div style={{ fontSize: 28, fontWeight: 700, letterSpacing: "-0.5px", marginBottom: 4 }}>Coach</div>
          <div style={{ fontSize: 15, color: C.text3, marginBottom: 20 }}>Persoonlijke analyse op basis van jouw data</div>

          <div style={{ background: C.card, borderRadius: 16, padding: 16, marginBottom: 12 }}>
            <textarea rows={2} style={{ resize: "none", fontSize: 15 }}
              placeholder="Stel een vraag of beschrijf hoe je je voelt..."
              value={question} onChange={e => setQuestion(e.target.value)} />
            <button onClick={runCoach} disabled={coachLoad} style={{
              width: "100%", marginTop: 12, background: coachLoad ? C.fill : C.blue,
              color: coachLoad ? C.text3 : "#FFF", border: "none", borderRadius: 12,
              padding: "14px", fontSize: 16, fontWeight: 600, cursor: coachLoad ? "not-allowed" : "pointer",
              fontFamily: "inherit", transition: "all .2s"
            }}>
              {coachLoad ? "Analyseren..." : "Coach mij nu"}
            </button>
          </div>

          {coachLoad && (
            <div style={{ textAlign: "center", padding: "40px 0", color: C.text3 }}>
              <div style={{ fontSize: 44, marginBottom: 12, animation: "pulse 1.5s infinite" }}>🧠</div>
              <div style={{ fontSize: 15, fontWeight: 500 }}>Data wordt geanalyseerd</div>
            </div>
          )}

          {coaching && !coachLoad && (
            <div className="fade">
              {coaching.split(/###\s+/).filter(Boolean).map((s, i) => {
                const [title, ...rest] = s.trim().split("\n");
                const icons = { "Hoe sta je ervoor":"💚","3 Belangrijkste inzichten":"💡","Doe dit vandaag":"⚡","Training advies":"🏃","Herstel & rust":"😴","Dit vraagt aandacht":"⚠️" };
                return (
                  <div key={i} style={{ background: C.card, borderRadius: 16, padding: 16, marginBottom: 8 }}>
                    <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10 }}>
                      <div style={{ width: 36, height: 36, borderRadius: 10, background: i===0 ? C.green+"20" : C.fill, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>
                        {icons[title.trim()] || "•"}
                      </div>
                      <span style={{ fontSize: 14, fontWeight: 700, color: i===0 ? C.green : C.text }}>{title.trim()}</span>
                    </div>
                    <div style={{ fontSize: 15, color: C.text2, lineHeight: 1.7, whiteSpace: "pre-wrap" }}>{rest.join("\n").trim()}</div>
                  </div>
                );
              })}
            </div>
          )}

          {!coaching && !coachLoad && (
            <div style={{ textAlign: "center", padding: "48px 20px" }}>
              <div style={{ width: 72, height: 72, borderRadius: "50%", background: C.blue+"15", margin: "0 auto 16px", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 32 }}>✦</div>
              <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 6 }}>Klaar voor analyse</div>
              <div style={{ fontSize: 15, color: C.text3 }}>Druk op "Coach mij nu" voor persoonlijk advies.</div>
            </div>
          )}
        </div>
      )}

      {/* ── CHECK-IN ── */}
      {tab === "checkin" && (
        <div className="fade" style={{ maxWidth: 640, margin: "0 auto", padding: "56px 16px 90px" }}>
          {/* Header met datum */}
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 20 }}>
            <div>
              <div style={{ fontSize: 28, fontWeight: 700, letterSpacing: "-0.5px" }}>Dagelijkse meting</div>
              <div style={{ fontSize: 14, color: C.text3, marginTop: 2 }}>
                {new Date(entry.date + "T12:00:00").toLocaleDateString("nl-NL", { weekday: "long", day: "numeric", month: "long" })}
              </div>
            </div>
            <input type="date" value={entry.date} onChange={e => set("date", e.target.value)}
              style={{ fontSize: 13, color: C.text3, background: "none", border: "none", padding: 0, cursor: "pointer", outline: "none", textAlign: "right" }} />
          </div>

          {/* Tellers: Gewicht, Alcohol, Koffie */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 10 }}>
            <Stepper label="Gewicht" value={entry.weight || 0} onChange={v => set("weight", v)} step={0.1} min={40} max={200} unit="kg" />
            <Stepper label="Alcohol" value={entry.alcohol || 0} onChange={v => set("alcohol", v)} step={1} min={0} max={20} unit="gl" />
            <Stepper label="Koffie" value={entry.koffie || 0} onChange={v => set("koffie", v)} step={1} min={0} max={15} unit="kp" />
          </div>

          {/* Bloeddruk */}
          <div style={{ background: C.card, borderRadius: 16, padding: 16, marginBottom: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: C.red, marginBottom: 14, textTransform: "uppercase", letterSpacing: "0.05em" }}>Bloeddruk</div>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ flex: 1 }}>
                <Field label="Systolisch">
                  <input type="number" placeholder="120" value={entry.bp_sys} onChange={e => set("bp_sys", e.target.value)} />
                </Field>
              </div>
              <div style={{ fontSize: 22, color: C.text3, paddingTop: 20 }}>/</div>
              <div style={{ flex: 1 }}>
                <Field label="Diastolisch">
                  <input type="number" placeholder="80" value={entry.bp_dia} onChange={e => set("bp_dia", e.target.value)} />
                </Field>
              </div>
            </div>
          </div>

          {/* Hoe voel ik me */}
          <div style={{ background: C.card, borderRadius: 16, padding: 16, marginBottom: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: C.purple, marginBottom: 14, textTransform: "uppercase", letterSpacing: "0.05em" }}>Hoe voel ik me</div>
            <MoodPicker value={entry.mood} onChange={v => set("mood", v)} />
          </div>

          {/* Notities */}
          <div style={{ background: C.card, borderRadius: 16, padding: 16, marginBottom: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: C.text3, marginBottom: 10, textTransform: "uppercase", letterSpacing: "0.05em" }}>Notities</div>
            <textarea rows={3} style={{ resize: "none" }} placeholder="Bijzonderheden, opmerkingen..."
              value={entry.notes} onChange={e => set("notes", e.target.value)} />
          </div>

          <button onClick={saveEntry} disabled={syncing} style={{
            width: "100%", background: saveMsg === "Opgeslagen!" ? C.green : saveMsg ? C.red : C.blue,
            color: "#FFF", border: "none", borderRadius: 14, padding: "16px",
            fontSize: 17, fontWeight: 600, cursor: syncing ? "not-allowed" : "pointer",
            opacity: syncing ? 0.7 : 1, transition: "all .2s", fontFamily: "inherit"
          }}>
            {syncing ? "Opslaan..." : saveMsg || "Opslaan"}
          </button>
        </div>
      )}

      {/* ── TRENDS ── */}
      {tab === "trends" && (
        <div className="fade" style={{ maxWidth: 640, margin: "0 auto", padding: "56px 16px 90px" }}>
          <div style={{ fontSize: 28, fontWeight: 700, letterSpacing: "-0.5px", marginBottom: 4 }}>Trends</div>
          <div style={{ fontSize: 15, color: C.text3, marginBottom: 20 }}>Jouw voortgang over tijd</div>

          {entries.length < 3 ? (
            <div style={{ textAlign: "center", padding: "48px 0" }}>
              <div style={{ fontSize: 44, marginBottom: 12 }}>📈</div>
              <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 6 }}>Voortgang in aantocht</div>
              <div style={{ fontSize: 15, color: C.text3 }}>Vul minimaal 3 dagen in.</div>
            </div>
          ) : (
            <>
              {/* Summary row */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 12 }}>
                {[
                  { l: "HRV gem.",   f: "hrv",     u: "ms",  c: C.green  },
                  { l: "Slaap gem.", f: "sleep_h",  u: "u",   c: C.indigo },
                  { l: "RHR gem.",   f: "rhr",      u: "bpm", c: C.teal   },
                  { l: "Stress gem.",f: "stress",   u: "/10", c: C.orange },
                ].map(m => {
                  const v = avg(numArr(entries, m.f));
                  return (
                    <div key={m.l} style={{ background: C.card, borderRadius: 14, padding: 14 }}>
                      <div style={{ fontSize: 12, color: C.text3, marginBottom: 4 }}>{m.l}</div>
                      <div style={{ fontSize: 26, fontWeight: 700, color: m.c }}>{v}<span style={{ fontSize: 12, color: C.text3, fontWeight: 400 }}> {m.u}</span></div>
                    </div>
                  );
                })}
              </div>

              {/* Trend cards */}
              {[
                { label: "HRV (ms)",             field: "hrv",          color: C.green,  good: "up"   },
                { label: "Rusthartslag (bpm)",    field: "rhr",          color: C.teal,   good: "down" },
                { label: "Slaapduur (uur)",       field: "sleep_h",      color: C.indigo, good: "up"   },
                { label: "Slaapkwaliteit (1–10)", field: "sleep_q",      color: C.indigo, good: "up"   },
                { label: "Energie (1–10)",        field: "energy",       color: C.yellow, good: "up"   },
                { label: "Stressniveau (1–10)",   field: "stress",       color: C.orange, good: "down" },
                { label: "Body battery (%)",      field: "body_battery", color: C.teal,   good: "up"   },
                { label: "Stappen",               field: "steps",        color: C.green,  good: "up"   },
                { label: "Gewicht (kg)",          field: "weight",       color: C.text3,  good: "down" },
                { label: "VO2max",                field: "vo2max",       color: C.blue,   good: "up"   },
              ].map(cfg => {
                const vals = numArr(entries, cfg.field);
                if (!vals.length) return null;
                const last = vals[vals.length - 1];
                const prev = vals.slice(-4, -1);
                const prevA = prev.length ? prev.reduce((a,b)=>a+b,0)/prev.length : last;
                const dir = last > prevA + 0.5 ? "up" : last < prevA - 0.5 ? "down" : "flat";
                const isGood = (cfg.good==="up"&&dir==="up")||(cfg.good==="down"&&dir==="down");
                const trendCol = dir==="flat" ? C.text3 : isGood ? C.green : C.red;
                return (
                  <div key={cfg.field} style={{ background: C.card, borderRadius: 16, padding: 16, marginBottom: 8 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
                      <span style={{ fontSize: 14, color: C.text3 }}>{cfg.label}</span>
                      <div>
                        <span style={{ fontSize: 22, fontWeight: 700 }}>{last}</span>
                        <span style={{ fontSize: 13, color: trendCol, marginLeft: 4, fontWeight: 600 }}>
                          {dir==="up"?"↑":dir==="down"?"↓":"→"}
                        </span>
                      </div>
                    </div>
                    <Sparkline data={vals} color={cfg.color} />
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: C.text3, marginTop: 6 }}>
                      <span>gem. {avg(vals)}</span>
                      <span>{vals.length} metingen</span>
                    </div>
                  </div>
                );
              })}

              {/* Training heatmap */}
              <div style={{ background: C.card, borderRadius: 16, padding: 16, marginBottom: 8 }}>
                <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>Trainingsdagen</div>
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                  {entries.slice(-28).map(e => (
                    <div key={e.date} title={`${fmt(e.date)}: ${e.train_type || "rust"}`}
                      style={{ width: 24, height: 24, borderRadius: 6, background: isTrue(e.trained) ? C.orange : C.fill }} />
                  ))}
                </div>
                <div style={{ marginTop: 8, fontSize: 12, color: C.text3 }}>Laatste 28 dagen · oranje = training</div>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── MEER / SETUP ── */}
      {tab === "setup" && (
        <div className="fade" style={{ maxWidth: 640, margin: "0 auto", padding: "56px 16px 90px" }}>
          <div style={{ fontSize: 28, fontWeight: 700, letterSpacing: "-0.5px", marginBottom: 20 }}>Meer</div>

          {/* Logboek */}
          <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 10 }}>Logboek</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 2, marginBottom: 24 }}>
            <div style={{ background: C.card, borderRadius: "14px 14px 4px 4px", padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 16 }}>{entries.length} dagen data</span>
              <span style={{ color: C.text3, fontSize: 14 }}>{sheetMode ? "Google Sheets" : "lokaal"}</span>
            </div>
            <div onClick={loadData} style={{ background: C.card, borderRadius: "4px 4px 14px 14px", padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }}>
              <span style={{ fontSize: 16, color: C.blue }}>Vernieuwen</span>
            </div>
          </div>

          {[...entries].reverse().slice(0, 10).map((e, i, arr) => (
            <div key={e.date} style={{ background: C.card, borderRadius: i===0?"14px 14px 4px 4px":i===arr.length-1?"4px 4px 14px 14px":4, padding: "12px 16px", marginBottom: 2 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                <span style={{ fontWeight: 600 }}>{fmt(e.date)}</span>
                <div style={{ display: "flex", gap: 6 }}>
                  {isTrue(e.trained) && <span style={{ background: C.orange+"20", color: C.orange, fontSize: 11, padding: "2px 8px", borderRadius: 20, fontWeight: 600 }}>{e.train_type||"training"}</span>}
                  {+e.alcohol > 0 && <span style={{ background: C.red+"20", color: C.red, fontSize: 11, padding: "2px 8px", borderRadius: 20, fontWeight: 600 }}>{e.alcohol} eenheden</span>}
                </div>
              </div>
              <div style={{ display: "flex", gap: 12, fontSize: 13, color: C.text3, flexWrap: "wrap" }}>
                {[["HRV", e.hrv, "ms"],["Slaap", e.sleep_h, "u"],["HR", e.rhr, "bpm"],["Stress", e.stress, "/10"]].filter(([,v])=>v).map(([l,v,u]) => (
                  <span key={l}>{l}: <span style={{ color: C.text, fontWeight: 500 }}>{v}{u}</span></span>
                ))}
              </div>
            </div>
          ))}

          {/* Status */}
          <div style={{ fontSize: 17, fontWeight: 600, margin: "24px 0 10px" }}>Verbindingen</div>
          <div style={{ background: C.card, borderRadius: 16, padding: 16, marginBottom: 8 }}>
            {[
              { label: "Google Sheets", ok: !!SHEET_ID,   detail: SHEET_ID ? `Sheet ...${SHEET_ID.slice(-6)}` : "Niet ingesteld" },
              { label: "Claude AI",     ok: !!CLAUDE_KEY, detail: CLAUDE_KEY ? "API key aanwezig" : "Niet ingesteld" },
              { label: "Garmin sync",   ok: false,        detail: "06:30 dagelijks via GitHub Actions" },
            ].map((s, i, arr) => (
              <div key={s.label} style={{ display: "flex", alignItems: "center", gap: 12, paddingBottom: i<arr.length-1?14:0, marginBottom: i<arr.length-1?14:0, borderBottom: i<arr.length-1?`1px solid ${C.border}`:0 }}>
                <div style={{ width: 10, height: 10, borderRadius: "50%", background: s.ok ? C.green : C.text3, flexShrink: 0 }} />
                <div>
                  <div style={{ fontSize: 15, fontWeight: 500 }}>{s.label}</div>
                  <div style={{ fontSize: 13, color: C.text3 }}>{s.detail}</div>
                </div>
              </div>
            ))}
          </div>

          {/* App installeren */}
          <div style={{ fontSize: 17, fontWeight: 600, margin: "24px 0 10px" }}>App installeren</div>
          <div style={{ background: C.card, borderRadius: 16, padding: 16, fontSize: 15, lineHeight: 1.8 }}>
            <strong>iPhone (Safari):</strong> Deel-knop → "Zet op beginscherm"<br />
            <strong>Android (Chrome):</strong> Menu → "Toevoegen aan startscherm"
          </div>
        </div>
      )}

      {/* ── Bottom nav ── */}
      <div style={{
        position: "fixed", bottom: 0, left: 0, right: 0,
        background: "rgba(255,255,255,0.92)", backdropFilter: "blur(20px)",
        borderTop: `1px solid ${C.border}`,
        padding: "8px 0 max(8px, env(safe-area-inset-bottom))",
        display: "flex", justifyContent: "space-around"
      }}>
        {[
          { id: "vandaag", label: "Vandaag",  emoji: "🏠" },
          { id: "coach",   label: "Coach",    emoji: "✦"  },
          { id: "checkin", label: "Invullen", emoji: "+"  },
          { id: "trends",  label: "Trends",   emoji: "↗"  },
          { id: "setup",   label: "Meer",     emoji: "⋯"  },
        ].map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            display: "flex", flexDirection: "column", alignItems: "center", gap: 3,
            background: "none", border: "none", cursor: "pointer", padding: "4px 12px",
            color: tab === t.id ? C.blue : C.text3, fontFamily: "inherit", minWidth: 60
          }}>
            <span style={{ fontSize: 22, lineHeight: 1 }}>{t.emoji}</span>
            <span style={{ fontSize: 10, fontWeight: tab === t.id ? 600 : 400 }}>{t.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
