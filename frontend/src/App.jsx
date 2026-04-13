import { useState, useEffect, useCallback, useRef } from "react";

// ── Google Sheets API ─────────────────────────────────────────────────────────
const SHEET_ID   = import.meta.env.VITE_GOOGLE_SHEET_ID;
const SA_EMAIL   = import.meta.env.VITE_GOOGLE_SERVICE_ACCOUNT_EMAIL;
const SA_KEY     = import.meta.env.VITE_GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n").replace(/\r/g, "");
const CLAUDE_KEY = import.meta.env.VITE_CLAUDE_API_KEY;
const TAB        = "coach_data";
const RANGE      = `${TAB}!A:AN`; // AN = kolom 40 (incl. step_goal), moet overeenkomen met HEADERS.length
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
// Kolom A–J: datum t/m hrv, dan K=hrv_7d L=hrv_5min (door gebruiker aangemaakt),
// dan M=rhr N=stress O=body_battery P=steps, enz. — moet overeenkomen met Google Sheet.
const HEADERS = [
  "date","weight","alcohol","bp_sys","bp_dia",                // A–E
  "sleep_h","sleep_q","sleep_deep","sleep_rem",               // F–I
  "hrv","hrv_7d","hrv_5min",                                  // J–L  ← nieuw
  "rhr","stress","body_battery","steps",                      // M–P
  "trained","train_type","train_min","train_dist",            // Q–T
  "avg_hr","max_hr","avg_pace","cadence",                     // U–X
  "ground_contact","vertical_osc","vertical_ratio",           // Y–AA
  "stride_length","training_effect","vo2max",                 // AB–AD
  "energy","mental_unrest","breathing","breathing_type",      // AE–AH
  "notes","sleep_prep","koffie","mood",                       // AI–AL
  "activities",                                               // AM
  "step_goal",                                               // AN
];

// Plan item → entry field mapping (for auto-save)
const PLAN_FIELD = { breathing: "breathing", sleep: "sleep_prep" };

// ── Kracht & soepelheid oefeningen ───────────────────────────────────────────
const STRENGTH_EXERCISES = [
  {
    id: "squat", name: "Squat", sets: "3 sets", reps: "12 herhalingen",
    target: "Benen & billen", color: "#FF9500",
    cue: "Zak door je knieën alsof je op een stoel gaat zitten. Rug recht, knieën boven je tenen.",
    steps: [
      "Sta schouderbreed, tenen iets naar buiten gedraaid",
      "Armen gestrekt voor je of gevouwen voor borst",
      "Zak langzaam (3 tellen) tot dijen parallel aan de grond",
      "Duw via je hielen omhoog — adem uit bij het opstaan",
    ]
  },
  {
    id: "bridge", name: "Glute bridge", sets: "3 sets", reps: "15 herhalingen",
    target: "Billen & onderrug", color: "#34C759",
    cue: "Lig op je rug, voeten plat op de grond. Druk heupen omhoog tot een rechte lijn. Essentieel bij zittend werk.",
    steps: [
      "Lig op je rug, knieën gebogen, voeten plat heupbreed op de grond",
      "Armen langs je lichaam, handpalmen naar beneden",
      "Druk heupen omhoog — knijp je billen samen bovenaan",
      "Houd 1 seconde vast en zak langzaam — zonder de grond te raken",
    ]
  },
  {
    id: "pushup", name: "Push-up", sets: "3 sets", reps: "10 herhalingen",
    target: "Borst, schouders & armen", color: "#007AFF",
    cue: "Begin op knieën als het te zwaar is. Lichaam als een rechte plank — core aangespannen.",
    steps: [
      "Handen iets breder dan schouders, op knieën of op de tenen",
      "Lichaam in één rechte lijn — core aanspannen",
      "Zak langzaam (3 tellen) naar beneden, ellebogen 45° van je lichaam",
      "Duw krachtig omhoog — adem uit bij het opstaan",
    ]
  },
  {
    id: "hipflex", name: "Heupflexor rek", sets: "2 sets", reps: "30 sec per kant",
    target: "Heupen — essentieel bij zittend werk", color: "#AF52DE",
    cue: "Heupflexoren korten in bij veel zitten. Deze rek herstelt de balans en voorkomt lage rugpijn.",
    steps: [
      "Neem een grote stap vooruit — achterste knie op de grond",
      "Kantel je bekken licht naar achteren (holle rug wegnemen)",
      "Voel de diepe rek voorin je achterste heup",
      "Houd 30 seconden vast, adem rustig door — wissel van been",
    ]
  },
  {
    id: "catcow", name: "Kat-koe", sets: "2 sets", reps: "10 herhalingen",
    target: "Rugmobiliteit & wervelkolom", color: "#5AC8FA",
    cue: "Beweeg de hele wervelkolom. Inademen = koe (rug hol), uitademen = kat (rug bol). Langzaam en bewust.",
    steps: [
      "Op handen en knieën — handen onder schouders, knieën onder heupen",
      "INADEMEN (koe): rug hol, hoofd en staartbeen omhoog",
      "UITADEMEN (kat): rug bol omhoog, hoofd omlaag, navel optrekken",
      "Wissel vloeiend met je ademhaling — 10 langzame herhalingen",
    ]
  },
  {
    id: "hamstring", name: "Hamstring rek", sets: "2 sets", reps: "30 sec per kant",
    target: "Achterkant benen", color: "#FF3B30",
    cue: "Zachte constante rek — geen pijn. Hamstrings worden stijf bij zitten en zijn cruciaal voor hardlopen.",
    steps: [
      "Lig op je rug",
      "Hef één been gestrekt omhoog",
      "Trek met beide handen (of een band) het been richting je borst",
      "Voel de rek achter je dijbeen — houd 30 sec — wissel van been",
    ]
  },
];

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
function getDailyPlan(todayData, contextData, entries, plannedWorkouts = [], stepGoal = 10000) {
  const last       = contextData;
  const readiness  = calcReadiness(last, entries);
  const race1Days  = daysUntil("2026-07-05");
  const todayStr   = today();

  // Trainingsbelasting: hoeveel dagen getraind van afgelopen 7
  const recent7    = (entries || []).slice(-7);
  const recent3    = (entries || []).slice(-3);
  const trainedLast7 = recent7.filter(e => isTrue(e.trained)).length;
  const trainedLast3 = recent3.filter(e => isTrue(e.trained)).length;
  const needsRest  = trainedLast3 >= 2 || (readiness !== null && readiness < 45);
  const canIntense = readiness !== null && readiness >= 65;
  const isRecovery = readiness !== null && readiness < 55;

  // Training: alleen als vandaag echt een activiteit heeft (todayData), niet gisteren
  const trainType = (todayData?.train_type || "").toLowerCase();
  const isWalking = trainType === "walking" || trainType === "casual_walking";
  const garminTrained = isTrue(todayData?.trained) && !isWalking;
  const typeLabel = todayData?.train_type
    ? todayData.train_type.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())
    : "";
  const isRun = trainType.includes("run");
  const trainDone = garminTrained;

  // Geplande workout voor vandaag (uit Garmin Coach)
  const todayPlanned = plannedWorkouts.find(p => p.date === todayStr);
  const rhr = parseNum(last?.rhr);
  const z2lo = rhr > 0 ? Math.round(rhr * 1.6) : 130;
  const z2hi = rhr > 0 ? Math.round(rhr * 1.75) : 145;

  let trainTask;
  if (garminTrained) {
    // ✓ Activiteit al gesynchroniseerd vanuit Garmin
    const parts = [];
    if (todayData?.train_min) parts.push(`${todayData.train_min} min`);
    if (todayData?.train_dist) parts.push(`${todayData.train_dist} km`);
    if (todayData?.avg_hr) parts.push(`gem. ${todayData.avg_hr} bpm`);
    if (isRun && todayData?.avg_pace) parts.push(`${todayData.avg_pace}/km`);
    trainTask = { icon: isRun ? "🏃" : "💪", label: typeLabel || "Training", sub: parts.join(" · ") || "Gesynchroniseerd vanuit Garmin", color: C.orange, cat: "Training" };
  } else if (todayPlanned) {
    // Gepland workout in Garmin Coach
    const planSport = todayPlanned.sport || "";
    const planIsRun = planSport.toLowerCase().includes("run");
    if (needsRest || isRecovery) {
      // Lage readiness → adviseer herstel in plaats van geplande training
      trainTask = {
        icon: "🔄", cat: "Training", color: C.teal,
        label: `Herstel i.p.v. ${todayPlanned.title || "gepland"}`,
        sub: `Readiness ${readiness}% — sla over of doe 20 min lichte wandeling`,
      };
    } else {
      // Goed herstel → voer geplande training uit
      trainTask = {
        icon: planIsRun ? "🏃" : "💪", cat: "Training", color: C.orange,
        label: todayPlanned.title || (planIsRun ? "Hardlooptraining" : "Training"),
        sub: `Gepland via Garmin Coach · ${planSport}`,
      };
    }
  } else if (needsRest) {
    // Geen plan, laag herstel
    trainTask = { icon: "🧘", label: "Hersteldag", sub: `Readiness ${readiness ?? "?"}% — rust of lichte wandeling`, color: C.teal, cat: "Herstel" };
  } else if (canIntense) {
    // Geen plan, goed herstel, hoge readiness
    const weeksToRace = Math.floor(race1Days / 7);
    if (race1Days > 42) {
      trainTask = { icon: "🏃", label: "Zone 2 duurloop", sub: `40–50 min · HR ${z2lo}–${z2hi} bpm · ${trainedLast7}/7 dagen actief`, color: C.orange, cat: "Training" };
    } else {
      trainTask = { icon: "🏃", label: "Tempo-interval", sub: `${weeksToRace} weken tot 10km Noordwijk · 5×3 min @ racetempo`, color: C.orange, cat: "Training" };
    }
  } else {
    // Geen plan, matig herstel
    trainTask = { icon: "🚶", label: "Actief herstel", sub: `30 min wandeling · ${trainedLast7}/7 dagen actief deze week`, color: C.green, cat: "Training" };
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
    { id: "steps", cat: "Beweging", icon: "👟", label: "Dagelijks stappendoel",
      sub: `${!isNaN(todaySteps) ? Math.round(todaySteps).toLocaleString("nl") : "—"} / ${stepGoal.toLocaleString("nl")} vandaag`,
      color: C.green, auto: true, done: todaySteps >= stepGoal },
    { id: "kracht", cat: "Training", icon: "🏋️", label: "Kracht & soepelheid", sub: `${STRENGTH_EXERCISES.length} oefeningen · ${STRENGTH_EXERCISES.slice(0,3).map(e=>e.name).join(", ")} +meer`, color: "#FF9500", done: !!localStorage.getItem(`kracht_done_${today()}`) },
    { id: "checkin", cat: "Check-in", icon: "📋", label: "Dagelijkse check-in", sub: "Gewicht, bloeddruk, stemming invullen", color: C.blue, done: !!(todayData?.date === today() && (todayData?.mood || todayData?.bp_sys || todayData?.weight)) },
    { id: "sleep", cat: "Avond", icon: "🌙", label: "Slaapvoorbereiding", sub: sleepSub, color: C.indigo, done: sleepPrepped },
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
      { icon: "🫀", text: "Bloeddruk meten als je een manchet hebt — ideaal <120/80 mmHg." },
      { icon: "😊", text: "Geef aan hoe je je voelt — van slecht tot top." },
      { icon: "☕", text: "Noteer je koffie en alcohol — helpt patronen in slaap en HRV zichtbaar maken." },
      { icon: "📝", text: "Optioneel: schrijf iets bijzonders op in notities." },
    ],
    tip: "Dagelijkse check-ins bouwen over weken een patroon op. De AI-coach gebruikt deze data voor persoonlijk advies.",
    action: "invullen",
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
async function fetchDailyTip({ todayData, contextData, plan, planned, readiness }) {
  const now = new Date();
  const hour = now.getHours();
  const timeLabel = hour < 9 ? "vroege ochtend" : hour < 12 ? "ochtend" : hour < 14 ? "middag" : hour < 17 ? "namiddag" : hour < 20 ? "avond" : "late avond";

  const pending = plan.filter(t => !t.done).map(t => t.label);
  const done    = plan.filter(t => t.done).map(t => t.label);
  const todayWorkout = planned.find(p => p.date === today());

  const metrics = contextData ? [
    (contextData.hrv || contextData.hrv_7d) && `HRV nacht ${contextData.hrv||"?"}ms / 7d ${contextData.hrv_7d||computedHrv7d||"?"}ms / 5min ${contextData.hrv_5min||"?"}ms`,
    contextData.sleep_h    && `slaap ${contextData.sleep_h}u`,
    contextData.body_battery && `battery ${contextData.body_battery}%`,
    contextData.stress     && `stress ${contextData.stress}`,
  ].filter(Boolean).join(", ") : "geen data";

  const prompt = `Je bent een personal coach. Geef één concreet advies voor dit moment.

TIJDSTIP: ${timeLabel} (${hour}:${String(now.getMinutes()).padStart(2,"0")})
READINESS SCORE: ${readiness ?? "onbekend"}
BIOMETRICS VANDAAG: ${metrics}
AL GEDAAN VANDAAG: ${done.length ? done.join(", ") : "nog niets"}
NOG TE DOEN: ${pending.length ? pending.join(", ") : "alles gedaan"}
GEPLANDE WORKOUT VANDAAG: ${todayWorkout ? `${todayWorkout.title} (${todayWorkout.sport})` : "geen gepland"}
ACHTERGROND: Geen ervaren sporter — leert hardlopen, zittend beroep, herstelt van intensieve periode (faillissement bedrijf). Mentaal herstel is minstens even belangrijk als fysiek. Opbouwend en zacht is het devies.
DOELEN: 10km Noordwijk 5 juli 2026 · Gym-race Utrecht 4 oktober 2026 (aspirationeel, niet professioneel schema)

Geef één tip van maximaal 2 zinnen. Geen opsommingstekens. Geen headers. Geen opmaak. Gewoon een directe, warme zin die nu het meest relevant is — gebaseerd op het tijdstip en wat er nog op de planning staat. Spreek de gebruiker direct aan met "je/jij". Wees bemoedigend, niet prestatiegericht.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": CLAUDE_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 120, messages: [{ role: "user", content: prompt }] })
  });
  const d = await res.json();
  return d.content?.find(b => b.type === "text")?.text?.trim() || "";
}

async function fetchCoaching(entries, question) {
  const recent = entries.slice(-7);
  const todayStr = today();
  const todayRow = recent.find(e => e.date === todayStr);
  const prompt = `Je bent een warme maar directe personal health & performance coach. Analyseer en geef concrete coaching.

VANDAAG: ${todayStr}
DATA (laatste 7 dagen): ${JSON.stringify(recent, null, 2)}
${todayRow ? `VANDAAG (${todayStr}) DATA BESCHIKBAAR: HRV=${todayRow.hrv}, slaap=${todayRow.sleep_h}u, battery=${todayRow.body_battery}, stress=${todayRow.stress}` : `VANDAAG (${todayStr}): nog geen sync — meest recente rij is van ${recent[recent.length-1]?.date}`}

CONTEXT/VRAAG: ${question || "Geef mijn dagelijkse check-in analyse."}

ACHTERGROND GEBRUIKER: Geen ervaren sporter — leert hardlopen, zittend beroep, herstelt van intensieve periode (bedrijf failliet). Mentaal herstel even belangrijk als fysiek. Kleine stappen zijn successen. Bouw voorzichtig op.
DOELEN: meer beweging, hogere HRV, betere slaap, meer energie, innerlijke rust.
EVENTS (aspirationeel): 10km Noordwijk 5 juli 2026 · Gym-race Utrecht 4 oktober 2026.
HARDLOOP METRICS (als beschikbaar): avg_pace, cadence (ideaal ~180 spm), ground_contact (<250ms), vertical_osc (<9cm).

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

async function fetchDailyCoaching(entries) {
  const recent = entries.slice(-14);
  const todayStr = today();
  const todayRow = recent.find(e => e.date === todayStr) || recent[recent.length - 1];

  const prompt = `Je bent een directe, praktische personal coach. Geef dagelijks advies op basis van de data.

VANDAAG: ${todayStr}
RECENTE DATA (tot 14 dagen): ${JSON.stringify(recent.map(e => ({
  date: e.date, sleep_h: e.sleep_h, sleep_q: e.sleep_q,
  hrv: e.hrv, hrv_7d: e.hrv_7d, rhr: e.rhr,
  stress: e.stress, body_battery: e.body_battery,
  trained: e.trained, train_type: e.train_type, train_min: e.train_min,
  steps: e.steps, weight: e.weight, mood: e.mood, alcohol: e.alcohol,
})), null, 2)}

ACHTERGROND: Geen ervaren sporter — leert hardlopen, zittend beroep, herstelt van intensieve periode (bedrijf failliet gegaan). Kleine stappen zijn successen. Mentaal herstel even belangrijk als fysiek. Heeft events: 10km Noordwijk 5 juli 2026, Gym-race Utrecht 4 oktober 2026.

Geef coaching in EXACT deze 3 secties (gebruik ### als scheidingsteken):
### Goed bezig
Noem 1-2 concrete dingen die goed gaan in de data van de afgelopen dagen. Specifiek en persoonlijk.

### Doe dit vandaag
Geef 2-3 concrete, direct uitvoerbare acties voor vandaag. Praktisch en realistisch voor iemand met een zittend beroep.

### Aandachtspunt
Noem 1 ding dat aandacht verdient. Direct en eerlijk, maar constructief. Geen vage adviezen.

Toon: direct, concreet, geen wolligheid. Max 180 woorden totaal.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": CLAUDE_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 400, messages: [{ role: "user", content: prompt }] })
  });
  const d2 = await res.json();
  return d2.content?.find(b => b.type === "text")?.text || "";
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

const Sparkline = ({ data, color, height = 40, fill = false, refLine = null }) => {
  if (!data || data.length < 2) return null;
  const min = Math.min(...data), max = Math.max(...data), range = max - min || 1;
  const W = 200, H = height, p = 3;
  const pts = data.map((v, i) => {
    const x = p + (i / (data.length - 1)) * (W - p * 2);
    const y = H - p - ((v - min) / range) * (H - p * 2);
    return [x, y];
  });
  const ptsStr = pts.map(([x, y]) => `${x},${y}`).join(" ");
  const fillPts = `${pts[0][0]},${H} ` + ptsStr + ` ${pts[pts.length-1][0]},${H}`;
  const refY = refLine != null ? H - p - ((refLine - min) / range) * (H - p * 2) : null;
  const id = `g${Math.random().toString(36).slice(2,7)}`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height }} preserveAspectRatio="none">
      {fill && (
        <>
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.18" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          <polygon fill={`url(#${id})`} points={fillPts} />
        </>
      )}
      {refY != null && <line x1={p} y1={refY} x2={W-p} y2={refY} stroke={color} strokeWidth="1" strokeDasharray="3,3" opacity="0.4" />}
      <polyline fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" points={ptsStr} />
      <circle cx={pts[pts.length-1][0]} cy={pts[pts.length-1][1]} r="3" fill={color} />
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
  const btnStyle = { width: 44, height: 44, borderRadius: 22, background: C.card, border: `1px solid ${C.border}`, fontSize: 24, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 300, color: C.text, flexShrink: 0, touchAction: "manipulation" };
  return (
    <div style={{ background: C.fill, borderRadius: 16, padding: "14px 12px" }}>
      <div style={{ fontSize: 13, color: C.text3, marginBottom: 8 }}>{label}</div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 4 }}>
        <button onPointerDown={e => { e.preventDefault(); onChange(Math.max(min, parseFloat((val - step).toFixed(dec)))); }} style={btnStyle}>−</button>
        <div style={{ textAlign: "center", flex: 1, minWidth: 0 }}>
          <span style={{ fontSize: 26, fontWeight: 700, letterSpacing: "-0.5px" }}>{dec > 0 ? val.toFixed(dec) : val}</span>
          {unit && <span style={{ fontSize: 13, color: C.text3, marginLeft: 3 }}>{unit}</span>}
        </div>
        <button onPointerDown={e => { e.preventDefault(); onChange(Math.min(max, parseFloat((val + step).toFixed(dec)))); }} style={btnStyle}>+</button>
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
// ── Exercise animation SVGs ───────────────────────────────────────────────────
const ExerciseAnim = ({ id, color: c }) => {
  const sp = { stroke: c, strokeWidth: 3.5, strokeLinecap: "round", strokeLinejoin: "round", fill: "none" };
  switch (id) {
    case "squat": return (
      <svg viewBox="0 0 80 100" width="80" height="100" style={{ display: "block", margin: "0 auto" }}>
        <style>{`@keyframes exsq{0%,100%{transform:scaleY(1)}50%{transform:scaleY(.78)}}`}</style>
        <g {...sp} style={{ animation: "exsq 2.2s ease-in-out infinite", transformOrigin: "40px 93px" }}>
          <circle cx="40" cy="11" r="9" fill={c + "25"} stroke={c} />
          <line x1="40" y1="20" x2="40" y2="52" />
          <line x1="40" y1="31" x2="24" y2="45" />
          <line x1="40" y1="31" x2="56" y2="45" />
          <line x1="40" y1="52" x2="26" y2="72" />
          <line x1="26" y1="72" x2="20" y2="93" />
          <line x1="40" y1="52" x2="54" y2="72" />
          <line x1="54" y1="72" x2="60" y2="93" />
        </g>
      </svg>
    );
    case "bridge": return (
      <svg viewBox="0 0 140 80" width="140" height="80" style={{ display: "block", margin: "0 auto" }}>
        <style>{`@keyframes exbr{0%,100%{transform:translateY(0)}50%{transform:translateY(-14px)}}`}</style>
        <line {...sp} x1="8" y1="70" x2="135" y2="70" strokeOpacity="0.2" />
        <circle {...sp} cx="14" cy="56" r="8" fill={c + "25"} />
        <line {...sp} x1="22" y1="56" x2="55" y2="56" />
        <g style={{ animation: "exbr 2.2s ease-in-out infinite", transformOrigin: "72px 56px" }}>
          <line {...sp} x1="55" y1="56" x2="72" y2="42" />
          <line {...sp} x1="72" y1="42" x2="90" y2="56" />
        </g>
        <line {...sp} x1="90" y1="56" x2="102" y2="70" />
        <line {...sp} x1="102" y1="70" x2="125" y2="56" />
      </svg>
    );
    case "pushup": return (
      <svg viewBox="0 0 140 80" width="140" height="80" style={{ display: "block", margin: "0 auto" }}>
        <style>{`@keyframes expu{0%,100%{transform:translateY(0)}50%{transform:translateY(14px)}}`}</style>
        <line {...sp} x1="26" y1="68" x2="130" y2="68" strokeOpacity="0.2" />
        <g {...sp} style={{ animation: "expu 2.2s ease-in-out infinite", transformOrigin: "75px 68px" }}>
          <circle cx="16" cy="34" r="8" fill={c + "25"} stroke={c} />
          <line x1="24" y1="34" x2="110" y2="34" />
          <line x1="36" y1="34" x2="32" y2="58" />
          <line x1="55" y1="34" x2="50" y2="58" />
          <line x1="110" y1="34" x2="118" y2="52" />
          <line x1="118" y1="52" x2="128" y2="44" />
        </g>
      </svg>
    );
    case "hipflex": return (
      <svg viewBox="0 0 120 110" width="120" height="110" style={{ display: "block", margin: "0 auto" }}>
        <style>{`@keyframes exhf{0%,100%{transform:scale(1)}50%{transform:scale(1.05)}}`}</style>
        <line {...sp} x1="10" y1="98" x2="112" y2="98" strokeOpacity="0.2" />
        <g {...sp} style={{ animation: "exhf 3s ease-in-out infinite", transformOrigin: "58px 55px" }}>
          <circle cx="58" cy="10" r="9" fill={c + "25"} stroke={c} />
          <line x1="58" y1="19" x2="58" y2="52" />
          <line x1="58" y1="52" x2="32" y2="76" />
          <line x1="32" y1="76" x2="18" y2="98" />
          <line x1="58" y1="52" x2="82" y2="76" />
          <line x1="82" y1="76" x2="90" y2="98" />
          <circle cx="82" cy="76" r="5" fill={c + "40"} stroke={c} strokeWidth="2.5" />
        </g>
      </svg>
    );
    case "catcow": return (
      <svg viewBox="0 0 140 80" width="140" height="80" style={{ display: "block", margin: "0 auto" }}>
        <style>{`@keyframes excc1{0%,100%{opacity:1}45%,55%{opacity:0}}@keyframes excc2{0%,100%{opacity:0}45%,55%{opacity:1}}`}</style>
        <line {...sp} x1="22" y1="68" x2="118" y2="68" strokeOpacity="0.2" />
        <circle {...sp} cx="14" cy="48" r="7" fill={c + "25"} />
        <line {...sp} x1="20" y1="42" x2="130" y2="42" strokeOpacity="0" />
        <path {...sp} d="M 20 48 Q 70 20 125 48" style={{ animation: "excc1 2.5s ease-in-out infinite" }} />
        <path {...sp} d="M 20 48 Q 70 62 125 48" style={{ animation: "excc2 2.5s ease-in-out infinite" }} />
        <line {...sp} x1="35" y1="50" x2="32" y2="68" />
        <line {...sp} x1="52" y1="46" x2="50" y2="68" />
        <line {...sp} x1="80" y1="46" x2="78" y2="68" />
        <line {...sp} x1="97" y1="50" x2="100" y2="68" />
        <line {...sp} x1="125" y1="48" x2="135" y2="38" />
      </svg>
    );
    case "hamstring": return (
      <svg viewBox="0 0 140 80" width="140" height="80" style={{ display: "block", margin: "0 auto" }}>
        <style>{`@keyframes exhs{0%,100%{transform:rotate(-10deg)}50%{transform:rotate(-40deg)}}`}</style>
        <line {...sp} x1="8" y1="70" x2="135" y2="70" strokeOpacity="0.2" />
        <circle {...sp} cx="14" cy="58" r="8" fill={c + "25"} />
        <line {...sp} x1="22" y1="58" x2="85" y2="58" />
        <g style={{ animation: "exhs 2.5s ease-in-out infinite", transformOrigin: "75px 58px" }}>
          <line {...sp} x1="75" y1="58" x2="108" y2="28" />
        </g>
        <line {...sp} x1="75" y1="58" x2="118" y2="63" />
        <line {...sp} x1="48" y1="54" x2="66" y2="35" strokeOpacity="0.35" strokeDasharray="5 4" />
      </svg>
    );
    default: return null;
  }
};

// ── Exercise modal ─────────────────────────────────────────────────────────────
const ExerciseModal = ({ onClose, onDone }) => {
  const [idx, setIdx] = useState(0);
  const [stepsOpen, setStepsOpen] = useState(false);
  const ex = STRENGTH_EXERCISES[idx];
  const isLast = idx === STRENGTH_EXERCISES.length - 1;

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, zIndex: 999,
      background: "rgba(0,0,0,0.5)", backdropFilter: "blur(6px)",
      display: "flex", alignItems: "flex-end", justifyContent: "center",
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: "#1C1C1E", borderRadius: "24px 24px 0 0",
        width: "100%", maxWidth: 640, maxHeight: "92vh",
        overflowY: "auto", paddingBottom: 40,
        fontFamily: "system-ui, -apple-system, sans-serif",
      }}>
        {/* Handle + close */}
        <div style={{ display: "flex", justifyContent: "center", padding: "14px 0 0" }}>
          <div style={{ width: 36, height: 4, borderRadius: 2, background: "rgba(255,255,255,0.2)" }} />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 20px 0" }}>
          <div style={{ fontSize: 13, color: "rgba(255,255,255,0.5)" }}>Kracht & soepelheid</div>
          <button onClick={onClose} style={{ width: 30, height: 30, borderRadius: 15, background: "rgba(255,255,255,0.12)", border: "none", cursor: "pointer", color: "rgba(255,255,255,0.7)", fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button>
        </div>

        {/* Progress dots */}
        <div style={{ display: "flex", justifyContent: "center", gap: 6, padding: "16px 0 0" }}>
          {STRENGTH_EXERCISES.map((_, i) => (
            <div key={i} onClick={() => { setIdx(i); setStepsOpen(false); }} style={{
              width: i === idx ? 20 : 7, height: 7, borderRadius: 4,
              background: i === idx ? ex.color : "rgba(255,255,255,0.2)",
              transition: "all .3s", cursor: "pointer",
            }} />
          ))}
        </div>

        {/* Animation area */}
        <div style={{ padding: "28px 20px 20px", display: "flex", justifyContent: "center", alignItems: "center", minHeight: 140 }}>
          <ExerciseAnim id={ex.id} color={ex.color} />
        </div>

        {/* Exercise info */}
        <div style={{ padding: "0 20px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
            <div style={{ fontSize: 22, fontWeight: 700, color: "#FFF", flex: 1 }}>{ex.name}</div>
            <div style={{ background: ex.color + "30", borderRadius: 10, padding: "4px 10px", fontSize: 12, fontWeight: 700, color: ex.color, flexShrink: 0, marginLeft: 12 }}>
              {ex.sets} · {ex.reps}
            </div>
          </div>
          <div style={{ fontSize: 12, color: ex.color, fontWeight: 600, marginBottom: 10 }}>{ex.target}</div>
          <div style={{ fontSize: 15, color: "rgba(255,255,255,0.8)", lineHeight: 1.6, marginBottom: 20 }}>{ex.cue}</div>

          {/* Expandable steps */}
          <button onClick={() => setStepsOpen(o => !o)} style={{
            width: "100%", background: "rgba(255,255,255,0.08)", border: "none", borderRadius: 14,
            padding: "13px 16px", color: "rgba(255,255,255,0.85)", fontSize: 15, fontWeight: 600,
            cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center",
            marginBottom: stepsOpen ? 0 : 16,
          }}>
            <span>Hoe doe je het</span>
            <span style={{ fontSize: 12, transform: stepsOpen ? "rotate(180deg)" : "none", transition: "transform .2s" }}>▼</span>
          </button>
          {stepsOpen && (
            <div style={{ background: "rgba(255,255,255,0.05)", borderRadius: "0 0 14px 14px", padding: "12px 16px", marginBottom: 16 }}>
              {ex.steps.map((s, i) => (
                <div key={i} style={{ display: "flex", gap: 12, alignItems: "flex-start", marginBottom: i < ex.steps.length - 1 ? 12 : 0 }}>
                  <div style={{ width: 22, height: 22, borderRadius: 11, background: ex.color, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: "#FFF", flexShrink: 0, marginTop: 1 }}>{i + 1}</div>
                  <div style={{ fontSize: 14, color: "rgba(255,255,255,0.8)", lineHeight: 1.5 }}>{s}</div>
                </div>
              ))}
            </div>
          )}

          {/* Navigation */}
          <div style={{ display: "flex", gap: 10 }}>
            {idx > 0 && (
              <button onClick={() => { setIdx(i => i - 1); setStepsOpen(false); }} style={{
                flex: 1, background: "rgba(255,255,255,0.1)", border: "none", borderRadius: 14,
                padding: "14px", fontSize: 16, fontWeight: 600, color: "rgba(255,255,255,0.7)", cursor: "pointer",
              }}>← Vorige</button>
            )}
            {!isLast ? (
              <button onClick={() => { setIdx(i => i + 1); setStepsOpen(false); }} style={{
                flex: 2, background: ex.color, border: "none", borderRadius: 14,
                padding: "14px", fontSize: 16, fontWeight: 600, color: "#FFF", cursor: "pointer",
              }}>Volgende →</button>
            ) : (
              <button onClick={onDone} style={{
                flex: 2, background: "#34C759", border: "none", borderRadius: 14,
                padding: "14px", fontSize: 16, fontWeight: 700, color: "#FFF", cursor: "pointer",
              }}>✓ Klaar!</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

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
  const [coaching,       setCoaching]       = useState("");
  const [coachLoad,      setCoachLoad]      = useState(false);
  const [dailyCoaching,  setDailyCoaching]  = useState("");
  const [dailyCoachLoad, setDailyCoachLoad] = useState(false);
  const [dailyTip,       setDailyTip]       = useState("");
  const [dailyTipLoad,   setDailyTipLoad]   = useState(false);
  const [question,  setQuestion]  = useState("");
  const [saveMsg,   setSaveMsg]   = useState("");
  const [sheetMode, setSheetMode] = useState(!!SHEET_ID);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [ghSyncing,   setGhSyncing]   = useState(false); // GitHub Actions sync bezig
  const [planDone,    setPlanDone]    = useState({});
  const [taskDetail,  setTaskDetail]  = useState(null);
  const [showExercise, setShowExercise] = useState(false);
  const [viewDate,    setViewDate]    = useState(today());
  const [planned,     setPlanned]     = useState([]);
  const [stepGoal,    setStepGoal]    = useState(() => parseInt(localStorage.getItem("step_goal") || "10000", 10));
  const [planActivityDetail, setPlanActivityDetail] = useState(null); // modal voor Garmin plan activiteit
  const [touchStartX, setTouchStartX] = useState(null);
  const skipPrefillRef = useRef(false);

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
        // Gebruik de werkelijke sheet-headers (rij 1) als primaire mapping
        // zodat kolom-volgorde in de sheet leidend is. Val terug op HEADERS-index
        // als de sheet-header niet in HEADERS voorkomt.
        const sheetHeaders = rows[0].map(h => String(h).trim().toLowerCase());
        const data = rows.slice(1).map(r => {
          const obj = {};
          sheetHeaders.forEach((h, i) => {
            if (h) obj[h] = r[i] ?? "";
          });
          // Zorg dat alle HEADERS-velden altijd aanwezig zijn (ook als sheet-header ontbreekt)
          HEADERS.forEach((h, i) => { if (!(h in obj)) obj[h] = r[i] ?? ""; });
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

  // Triggert de GitHub Actions garmin_sync workflow via Vercel API-route
  // + herlaadt altijd meteen de data uit de sheet
  const triggerGarminSync = useCallback(async () => {
    setGhSyncing(true);
    // Herlaad direct (pikt laatste sheet-data op, ongeacht sync)
    await loadData();
    try {
      const res = await fetch("/api/trigger-sync", { method: "POST" });
      if (res.ok) {
        // Sync gestart — wacht 25s en laad dan opnieuw (verse Garmin data)
        setTimeout(async () => { await loadData(); setGhSyncing(false); }, 25000);
      } else {
        const err = await res.text().catch(() => "onbekende fout");
        console.warn("Garmin sync trigger mislukt:", err);
        setGhSyncing(false);
      }
    } catch (e) {
      console.warn("Garmin sync trigger fout:", e);
      setGhSyncing(false);
    }
  }, [loadData]);

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
  const PREFILL_FIELDS = ["weight", "bp_sys", "bp_dia"];
  useEffect(() => {
    // Sla prefill over na opslaan — form staat al correct
    if (skipPrefillRef.current) { skipPrefillRef.current = false; return; }
    const existing = entries.find(e => e.date === entry.date);
    // Laatste bekende gewicht (Garmin sync schrijft geen gewicht)
    const lastWeight = [...entries].filter(e => e.date <= entry.date && parseNum(e.weight) > 0).slice(-1)[0]?.weight;
    if (existing) {
      const base = { ...EMPTY, ...existing };
      if (!parseNum(base.weight) && lastWeight) base.weight = lastWeight;
      setEntry(base);
    } else {
      const prev = [...entries].filter(e => e.date < entry.date).slice(-1)[0];
      const base = { ...EMPTY, date: entry.date };
      PREFILL_FIELDS.forEach(k => { if (prev?.[k] !== "" && prev?.[k] != null) base[k] = prev[k]; });
      if (!parseNum(base.weight) && lastWeight) base.weight = lastWeight;
      setEntry(base);
    }
  }, [entry.date, entries]);

  const saveEntry = async () => {
    setSyncing(true);
    const savedEntry = { ...entry }; // snapshot vóór async
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
      skipPrefillRef.current = true; // voorkom dat prefill form overschrijft na loadData
      await loadData();
      setEntry(savedEntry); // herstel opgeslagen waarden (sheet kan iets achter zijn)
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

  const runDailyTip = useCallback(async (planArg, plannedArg, readinessArg, todayDataArg, contextDataArg) => {
    const cacheKey = `daily_tip_${today()}_${new Date().getHours()}`;
    const cached = localStorage.getItem(cacheKey);
    if (cached) { setDailyTip(cached); return; }
    setDailyTipLoad(true);
    try {
      const tip = await fetchDailyTip({ todayData: todayDataArg, contextData: contextDataArg, plan: planArg, planned: plannedArg, readiness: readinessArg });
      if (tip) { setDailyTip(tip); localStorage.setItem(cacheKey, tip); }
    } catch { /* stil falen */ }
    setDailyTipLoad(false);
  }, []);

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
  // Step goal: gebruik Garmin-waarde uit sheet als beschikbaar, anders localStorage instelling
  const effectiveStepGoal = parseNum(todayEntry?.step_goal) > 0
    ? parseNum(todayEntry.step_goal)
    : stepGoal;
  const plan       = getDailyPlan(displayEntry, contextEntry, entries, planned, effectiveStepGoal);
  // HRV display: elk veld onafhankelijk zoeken in meest recente entry met die waarde
  // (vandaag kan hrv-nacht leeg zijn terwijl hrv_7d en hrv_5min wel gevuld zijn)
  const rev = [...entries].reverse();
  const hrvNachtEntry = rev.find(e => parseNum(e.hrv)     > 0) || contextEntry;
  const hrv7dEntry    = rev.find(e => parseNum(e.hrv_7d)  > 0) || null;
  const hrv5minEntry  = rev.find(e => parseNum(e.hrv_5min)> 0) || null;
  // hrv_7d fallback: bereken zelf als Garmin-waarde ontbreekt (heb je ≥2 nacht-waarden nodig)
  const computedHrv7d = (() => {
    if (parseNum(hrv7dEntry?.hrv_7d) > 0) return String(parseNum(hrv7dEntry.hrv_7d));
    const vals = numArr(entries.slice(-14), "hrv").filter(v => v > 0);
    return vals.length >= 2 ? String(Math.round(vals.reduce((a, b) => a + b, 0) / vals.length)) : null;
  })();
  const doneTasks  = plan.filter(t => t.done || planDone[t.id]).length;

  const hour = new Date().getHours();
  const greeting = hour < 6 ? "Goedenacht" : hour < 12 ? "Goedemorgen" : hour < 18 ? "Goedemiddag" : "Goedenavond";

  // Auto-fetch daily tip when on vandaag tab + today + data loaded
  useEffect(() => {
    if (tab === "vandaag" && isToday && !loading && CLAUDE_KEY && entries.length > 0) {
      runDailyTip(plan, planned, readiness, displayEntry, contextEntry);
    }
  }, [tab, isToday, loading, entries.length, planDone]); // eslint-disable-line

  // Auto-fetch dagelijkse coaching als coach tab opent
  useEffect(() => {
    if (tab !== "coach" || loading || !CLAUDE_KEY || entries.length === 0) return;
    const cacheKey = `daily_coaching_${today()}`;
    const cached = localStorage.getItem(cacheKey);
    if (cached) { setDailyCoaching(cached); return; }
    setDailyCoachLoad(true);
    fetchDailyCoaching(entries)
      .then(result => { if (result) { setDailyCoaching(result); localStorage.setItem(cacheKey, result); } })
      .catch(() => {})
      .finally(() => setDailyCoachLoad(false));
  }, [tab, loading, entries.length]); // eslint-disable-line

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

            // Checkin task: navigate to invullen tab instead of generic markeer
            if (detail?.action === "invullen") {
              return isDone ? (
                <div style={{ marginTop: 20, display: "flex", alignItems: "center", gap: 10, background: C.green + "15", borderRadius: 12, padding: "12px 16px" }}>
                  <span style={{ fontSize: 18 }}>✅</span>
                  <span style={{ fontSize: 15, color: C.green, fontWeight: 600 }}>Ingevuld vandaag · Opgeslagen in Sheets</span>
                </div>
              ) : (
                <button onClick={() => { setTaskDetail(null); setTab("checkin"); }}
                  style={{ marginTop: 20, width: "100%", background: taskDetail.color, color: "#fff", border: "none", borderRadius: 14, padding: "14px", fontSize: 16, fontWeight: 600, cursor: "pointer" }}>
                  Ga naar invullen →
                </button>
              );
            }

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
      {showExercise && (
        <ExerciseModal
          onClose={() => setShowExercise(false)}
          onDone={() => {
            localStorage.setItem(`kracht_done_${today()}`, "true");
            setPlanDone(p => ({ ...p, kracht: true }));
            setShowExercise(false);
          }}
        />
      )}
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
        @keyframes spin   { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
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
            <div style={{ background: C.card, borderRadius: 16, padding: "14px 16px", marginBottom: 12, display: "flex", alignItems: "center", gap: 16 }}>
              <div style={{ position: "relative", flexShrink: 0 }}>
                <Ring value={readiness != null && !isNaN(readiness) ? readiness : 0} color={readiness != null && !isNaN(readiness) ? readinessColor(readiness) : C.text3} size={80} stroke={8} />
                <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
                  <div style={{ fontSize: 19, fontWeight: 700, color: readiness != null && !isNaN(readiness) ? readinessColor(readiness) : C.text3, lineHeight: 1 }}>{readiness != null && !isNaN(readiness) ? readiness : "—"}</div>
                  <div style={{ fontSize: 9, color: C.text3, marginTop: 1 }}>{readiness != null && !isNaN(readiness) ? readinessLabel(readiness) : "—"}</div>
                </div>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>Readiness</div>
                {/* HRV rij — alles rechts uitgelijnd */}
                <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", marginBottom: 6 }}>
                  <div style={{ display: "flex", gap: 12, alignItems: "baseline" }}>
                    <span style={{ fontSize: 11, color: C.text3, alignSelf: "center" }}>HRV</span>
                    {[
                      { l: "nacht", v: hrvNachtEntry?.hrv  },
                      { l: "7d",    v: computedHrv7d        },
                      { l: "5min",  v: hrv5minEntry?.hrv_5min },
                    ].map(m => {
                      const val = parseNum(m.v);
                      return (
                        <div key={m.l} style={{ textAlign: "center" }}>
                          <div style={{ fontSize: 14, fontWeight: 700, color: !isNaN(val) ? C.green : C.text3, lineHeight: 1 }}>{!isNaN(val) ? val : "—"}</div>
                          <div style={{ fontSize: 9, color: C.text3, marginTop: 1 }}>{m.l}</div>
                        </div>
                      );
                    })}
                    <span style={{ fontSize: 11, color: C.text3 }}>ms</span>
                  </div>
                </div>
                {/* Overige metrics */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 12px" }}>
                  {[
                    { l: "Slaap",        v: contextEntry?.sleep_h,      u: " u",  c: C.indigo },
                    { l: "Stress",       v: contextEntry?.stress,        u: "",    c: C.orange },
                    { l: "Battery",      v: contextEntry?.body_battery,  u: "%",   c: C.teal   },
                    { l: "RHR",          v: contextEntry?.rhr,           u: " bpm",c: C.text3  },
                  ].map(m => {
                    const val = parseNum(m.v);
                    return (
                      <div key={m.l}>
                        <div style={{ fontSize: 10, color: C.text3, marginBottom: 1 }}>{m.l}</div>
                        <div style={{ fontSize: 13, fontWeight: 700, color: !isNaN(val) ? m.c : C.text3, lineHeight: 1.2 }}>{!isNaN(val) ? `${m.v}${m.u}` : "—"}</div>
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
                  <div key={task.id} onClick={() => task.id === "kracht" ? setShowExercise(true) : setTaskDetail({ ...task, done })}
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

            {/* Activiteiten vandaag — alleen uit displayEntry (=vandaag), NOOIT gisteren als fallback */}
            {(() => {
              // Alleen vandaag's activiteiten tonen — geen contextEntry fallback (dat is gisteren!)
              const raw = displayEntry?.activities;
              if (!raw) return null;
              let acts = [];
              try { acts = JSON.parse(raw); } catch { return null; }
              if (!acts.length) return null;
              const sportIcon = t => {
                const s = (t||"").toLowerCase();
                if (s.includes("run"))      return "🏃";
                if (s.includes("walk"))     return "🚶";
                if (s.includes("cycl") || s.includes("bike")) return "🚴";
                if (s.includes("swim"))     return "🏊";
                if (s.includes("strength") || s.includes("gym") || s.includes("weight")) return "🏋️";
                if (s.includes("yoga"))     return "🧘";
                if (s.includes("breath"))   return "🫁";
                if (s.includes("cardio") || s.includes("hiit")) return "⚡";
                return "🏅";
              };
              const typeLabel = t => (t||"").replace(/_/g," ").replace(/\b\w/g, c=>c.toUpperCase());
              const isWalkType = t => (t||"").includes("walk");
              return (
                <div style={{ background: C.card, borderRadius: 16, overflow: "hidden", marginBottom: 12 }}>
                  <div style={{ padding: "14px 16px 10px", fontSize: 13, fontWeight: 600, color: C.text3, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                    Activiteiten vandaag
                  </div>
                  {acts.map((a, i) => {
                    const done = true; // als het in de sheet staat, is het gedaan
                    return (
                    <div key={i} style={{ padding: "10px 16px", display: "flex", alignItems: "center", gap: 14,
                      borderTop: `1px solid ${C.border}`, opacity: done ? 1 : 0.6 }}>
                      <div style={{ width: 36, height: 36, borderRadius: 18, background: C.orange + "20",
                        display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, flexShrink: 0, position: "relative" }}>
                        {sportIcon(a.type)}
                        <div style={{ position: "absolute", bottom: -3, right: -3, width: 16, height: 16, borderRadius: 8,
                          background: C.orange, display: "flex", alignItems: "center", justifyContent: "center" }}>
                          <svg width="9" height="7" viewBox="0 0 9 7" fill="none">
                            <path d="M1 3.5L3.5 6L8 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        </div>
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 14, fontWeight: 500, textDecoration: "line-through", color: C.text3 }}>
                          {a.name || typeLabel(a.type)}
                        </div>
                        <div style={{ fontSize: 12, color: C.text3, marginTop: 2 }}>
                          {[a.min && `${a.min} min`, a.dist && `${a.dist} km`, a.hr && `${a.hr} bpm gem.`].filter(Boolean).join(" · ")}
                        </div>
                      </div>
                    </div>
                    );
                  })}
                </div>
              );
            })()}

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
                      const smiley  = sc == null  ? "😐"
                                    : scColor === C.green  ? "😊"
                                    : scColor === C.orange ? "😐"
                                    : "😔";
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
                            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                              <div style={{ fontSize: 22 }}>{smiley}</div>
                              <div style={{ textAlign: "right" }}>
                                <div style={{ fontSize: 22, fontWeight: 700, color: urgency, lineHeight: 1 }}>{ev.days}</div>
                                <div style={{ fontSize: 11, color: C.text3 }}>dagen</div>
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}

            {/* Coach tip — boven trainingsplan */}
            {isToday && CLAUDE_KEY && (dailyTip || dailyTipLoad) && (
              <div style={{ background: C.card, borderRadius: 16, padding: "14px 16px", marginBottom: 12, display: "flex", gap: 12, alignItems: "flex-start" }}>
                <div style={{ fontSize: 22, flexShrink: 0, marginTop: 1 }}>
                  {hour < 9 ? "☀️" : hour < 14 ? "⚡" : hour < 19 ? "🎯" : "🌙"}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: C.blue, marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.05em" }}>Coach advies</div>
                  {dailyTipLoad
                    ? <div style={{ height: 14, background: C.fill, borderRadius: 7, width: "80%", animation: "pulse 1.5s ease-in-out infinite" }} />
                    : <div style={{ fontSize: 14, color: C.text, lineHeight: 1.55 }}>{dailyTip}</div>
                  }
                </div>
                {!dailyTipLoad && (
                  <button onClick={() => { localStorage.removeItem(`daily_tip_${today()}_${new Date().getHours()}`); runDailyTip(plan, planned, readiness, displayEntry, contextEntry); }}
                    style={{ background: "none", border: "none", cursor: "pointer", color: C.text3, fontSize: 13, padding: "2px 0", flexShrink: 0, marginTop: 2 }}>↻</button>
                )}
              </div>
            )}

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
              // Training vandaag gedaan als Garmin sync trained=true toont voor vandaag
              const trainedToday = plan.find(t => t.id === "training")?.done || false;
              return (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 10 }}>Garmin trainingsplan</div>
                  <div style={{ background: C.card, borderRadius: 16, overflow: "hidden" }}>
                    {upcoming.map((p, i) => {
                      const isToday = p.date === today();
                      const isDone  = isToday && trainedToday;
                      // Zoek bijpassende entry data voor deze datum
                      const entryForDate = entries.find(e => e.date === p.date);
                      return (
                      <div key={p.date + p.title}
                        onClick={() => setPlanActivityDetail({ planned: p, entry: entryForDate, isDone })}
                        style={{ padding: "13px 16px", display: "flex", alignItems: "center", gap: 14,
                          borderBottom: i < upcoming.length - 1 ? `1px solid ${C.border}` : "none",
                          opacity: isDone ? 0.85 : 1, cursor: "pointer" }}>
                        <div style={{ width: 36, height: 36, borderRadius: 10,
                          background: isDone ? C.green + "20" : C.orange + "15",
                          display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, flexShrink: 0 }}>
                          {isDone ? "✅" : sportIcon(p.sport)}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 15, fontWeight: 500, textDecoration: isDone ? "line-through" : "none", color: isDone ? C.text3 : C.text }}>
                            {p.title}
                          </div>
                          <div style={{ fontSize: 12, color: C.text3, marginTop: 1 }}>
                            {isDone
                              ? `✓ Voltooid · ${entryForDate?.train_dist ? entryForDate.train_dist + " km" : ""} ${entryForDate?.avg_hr ? "· " + entryForDate.avg_hr + " bpm" : ""} ${entryForDate?.avg_pace ? "· " + entryForDate.avg_pace + "/km" : ""}`.trim()
                              : dayLabel(p.date)}
                          </div>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          {isToday && !isDone && (
                            <div style={{ fontSize: 11, fontWeight: 600, color: C.orange, background: C.orange + "15", padding: "3px 8px", borderRadius: 20 }}>Vandaag</div>
                          )}
                          {isDone && (
                            <div style={{ fontSize: 11, fontWeight: 600, color: C.green, background: C.green + "15", padding: "3px 8px", borderRadius: 20 }}>✓ Gedaan</div>
                          )}
                          <svg width="7" height="12" viewBox="0 0 7 12" fill="none"><path d="M1 1l5 5-5 5" stroke={C.text3} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>
                        </div>
                      </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}

            {/* Modal: Garmin plan activiteit detail */}
            {planActivityDetail && (() => {
              const { planned: p, entry: e, isDone } = planActivityDetail;
              const sportIcon = (s) => s?.includes("run") ? "🏃" : s?.includes("cycl") ? "🚴" : s?.includes("swim") ? "🏊" : "💪";
              const isRun = (e?.train_type || p.sport || "").toLowerCase().includes("run");
              return (
                <div onClick={() => setPlanActivityDetail(null)} style={{
                  position: "fixed", inset: 0, zIndex: 999,
                  background: "rgba(0,0,0,0.45)", backdropFilter: "blur(4px)",
                  display: "flex", alignItems: "flex-end", justifyContent: "center", cursor: "pointer"
                }}>
                  <div onClick={ev => ev.stopPropagation()} style={{
                    background: C.card, borderRadius: "20px 20px 0 0",
                    width: "100%", maxWidth: 640, maxHeight: "80vh", overflowY: "auto",
                    padding: "0 0 40px", cursor: "default"
                  }}>
                    <div style={{ display: "flex", justifyContent: "center", padding: "12px 0 0" }}>
                      <div style={{ width: 36, height: 4, borderRadius: 2, background: C.fill }} />
                    </div>
                    {/* Header */}
                    <div style={{ padding: "16px 20px 20px", borderBottom: `1px solid ${C.separator}`, display: "flex", alignItems: "center", gap: 14 }}>
                      <div style={{ width: 48, height: 48, borderRadius: 14,
                        background: isDone ? C.green + "18" : C.orange + "18",
                        display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24, flexShrink: 0 }}>
                        {isDone ? "✅" : sportIcon(p.sport)}
                      </div>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 18, fontWeight: 700 }}>{p.title}</div>
                        <div style={{ fontSize: 13, color: C.text3, marginTop: 2 }}>
                          {new Date(p.date + "T12:00:00").toLocaleDateString("nl-NL", { weekday: "long", day: "numeric", month: "long" })}
                          {p.sport && ` · ${p.sport.replace(/_/g, " ")}`}
                        </div>
                      </div>
                      <button onClick={() => setPlanActivityDetail(null)}
                        style={{ width: 32, height: 32, borderRadius: 16, background: C.fill, border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, color: C.text3, flexShrink: 0 }}>✕</button>
                    </div>

                    <div style={{ padding: "20px 20px 0" }}>
                      {/* Garmin resultaten (als gedaan + entry beschikbaar) */}
                      {isDone && e && (
                        <>
                          <div style={{ fontSize: 13, fontWeight: 600, color: C.green, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 12 }}>
                            ✓ Voltooid — Garmin resultaten
                          </div>
                          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 20 }}>
                            {[
                              { l: "Afstand",  v: e.train_dist,     u: "km"  },
                              { l: "Duur",     v: e.train_min,      u: "min" },
                              { l: "HR gem.",  v: e.avg_hr,         u: "bpm" },
                              { l: "HR max",   v: e.max_hr,         u: "bpm" },
                              ...(isRun ? [
                                { l: "Tempo",  v: e.avg_pace,       u: "/km" },
                                { l: "Cadans", v: e.cadence,        u: "spm" },
                                { l: "GCT",    v: e.ground_contact, u: "ms"  },
                                { l: "V. Osc", v: e.vertical_osc,   u: "cm"  },
                                { l: "Stride", v: e.stride_length,  u: "m"   },
                                { l: "Trng Eff", v: e.training_effect, u: "" },
                              ] : []),
                            ].filter(m => m.v && m.v !== "").map(m => (
                              <div key={m.l} style={{ background: C.fill, borderRadius: 12, padding: "12px 10px", textAlign: "center" }}>
                                <div style={{ fontSize: 11, color: C.text3, marginBottom: 4 }}>{m.l}</div>
                                <div style={{ fontSize: 18, fontWeight: 700, color: C.text }}>
                                  {m.v}<span style={{ fontSize: 11, color: C.text3, fontWeight: 400 }}> {m.u}</span>
                                </div>
                              </div>
                            ))}
                          </div>
                          {/* HRV van die dag */}
                          {e.hrv && (
                            <div style={{ background: C.fill, borderRadius: 12, padding: "12px 16px", marginBottom: 16, display: "flex", gap: 20 }}>
                              <div style={{ textAlign: "center" }}>
                                <div style={{ fontSize: 10, color: C.text3, marginBottom: 2 }}>HRV nacht</div>
                                <div style={{ fontSize: 16, fontWeight: 700, color: C.green }}>{e.hrv} ms</div>
                              </div>
                              {e.hrv_7d && <div style={{ textAlign: "center" }}>
                                <div style={{ fontSize: 10, color: C.text3, marginBottom: 2 }}>7d gem.</div>
                                <div style={{ fontSize: 16, fontWeight: 700 }}>{e.hrv_7d} ms</div>
                              </div>}
                              {e.sleep_h && <div style={{ textAlign: "center" }}>
                                <div style={{ fontSize: 10, color: C.text3, marginBottom: 2 }}>Slaap</div>
                                <div style={{ fontSize: 16, fontWeight: 700 }}>{e.sleep_h} u</div>
                              </div>}
                              {e.body_battery && <div style={{ textAlign: "center" }}>
                                <div style={{ fontSize: 10, color: C.text3, marginBottom: 2 }}>Battery</div>
                                <div style={{ fontSize: 16, fontWeight: 700 }}>{e.body_battery}%</div>
                              </div>}
                            </div>
                          )}
                        </>
                      )}

                      {/* Gepland maar nog niet gedaan */}
                      {!isDone && (
                        <>
                          <div style={{ fontSize: 13, fontWeight: 600, color: C.text3, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 12 }}>
                            Geplande training
                          </div>
                          <div style={{ background: C.fill, borderRadius: 12, padding: "14px 16px", marginBottom: 16 }}>
                            <div style={{ fontSize: 14, color: C.text, lineHeight: 1.6 }}>
                              {p.sport && <div>🏃 Sport: <strong>{p.sport.replace(/_/g, " ")}</strong></div>}
                              <div style={{ marginTop: 8, color: C.text3, fontSize: 13 }}>
                                Volg het Garmin Coach plan en sla de activiteit op in je Garmin horloge — data wordt automatisch gesynchroniseerd.
                              </div>
                            </div>
                          </div>
                        </>
                      )}

                      <button onClick={() => setPlanActivityDetail(null)}
                        style={{ width: "100%", background: isDone ? C.green + "15" : C.fill, border: "none", borderRadius: 12, padding: "14px", fontSize: 15, fontWeight: 600, color: isDone ? C.green : C.text3, cursor: "pointer" }}>
                        Sluiten
                      </button>
                    </div>
                  </div>
                </div>
              );
            })()}

            {sheetMode && (
              <button
                onClick={triggerGarminSync}
                disabled={ghSyncing}
                style={{ width: "100%", background: ghSyncing ? C.green + "20" : C.fill, border: "none", borderRadius: 12, padding: "12px 16px", fontSize: 14, color: ghSyncing ? C.green : C.text3, cursor: ghSyncing ? "default" : "pointer", marginBottom: 4, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, transition: "all .3s" }}>
                <span style={{ display: "inline-block", animation: ghSyncing ? "spin 1s linear infinite" : "none" }}>↻</span>
                <span>
                  {ghSyncing
                    ? "Garmin sync bezig…"
                    : `Ververs data${lastRefresh ? ` · ${lastRefresh.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" })}` : ""}`}
                </span>
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
          <div style={{ fontSize: 15, color: C.text3, marginBottom: 20 }}>
            {new Date().toLocaleDateString("nl-NL", { weekday: "long", day: "numeric", month: "long" })}
          </div>

          {/* Dagelijks advies — auto-geladen */}
          {dailyCoachLoad && (
            <div style={{ textAlign: "center", padding: "40px 0", color: C.text3 }}>
              <div style={{ fontSize: 40, marginBottom: 10, animation: "pulse 1.5s infinite" }}>🧠</div>
              <div style={{ fontSize: 14 }}>Dagadvies laden...</div>
            </div>
          )}

          {dailyCoaching && !dailyCoachLoad && (() => {
            const sectionIcons = { "Goed bezig": "✅", "Doe dit vandaag": "⚡", "Aandachtspunt": "🎯" };
            const sectionColors = { "Goed bezig": C.green, "Doe dit vandaag": C.blue, "Aandachtspunt": C.orange };
            return (
              <div className="fade" style={{ marginBottom: 20 }}>
                {dailyCoaching.split(/###\s+/).filter(Boolean).map((s, i) => {
                  const [title, ...rest] = s.trim().split("\n");
                  const t = title.trim();
                  const color = sectionColors[t] || C.text3;
                  return (
                    <div key={i} style={{ background: C.card, borderRadius: 16, padding: "14px 16px", marginBottom: 8 }}>
                      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 8 }}>
                        <span style={{ fontSize: 18 }}>{sectionIcons[t] || "•"}</span>
                        <span style={{ fontSize: 14, fontWeight: 700, color }}>{t}</span>
                      </div>
                      <div style={{ fontSize: 15, color: C.text2, lineHeight: 1.65, whiteSpace: "pre-wrap" }}>{rest.join("\n").trim()}</div>
                    </div>
                  );
                })}
                <div style={{ textAlign: "right", marginTop: 4 }}>
                  <button onClick={() => {
                    localStorage.removeItem(`daily_coaching_${today()}`);
                    setDailyCoaching("");
                    setDailyCoachLoad(true);
                    fetchDailyCoaching(entries)
                      .then(r => { if (r) { setDailyCoaching(r); localStorage.setItem(`daily_coaching_${today()}`, r); } })
                      .catch(() => {})
                      .finally(() => setDailyCoachLoad(false));
                  }} style={{ fontSize: 12, color: C.text3, background: "none", border: "none", cursor: "pointer", padding: "4px 0" }}>
                    ↻ vernieuw
                  </button>
                </div>
              </div>
            );
          })()}

          {/* Stel een vraag */}
          <div style={{ fontSize: 13, fontWeight: 600, color: C.text3, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 8 }}>Stel een vraag</div>
          <div style={{ background: C.card, borderRadius: 16, padding: 16, marginBottom: 12 }}>
            <textarea rows={2} style={{ resize: "none", fontSize: 15 }}
              placeholder="Hoe voel je je? Of stel een specifieke vraag..."
              value={question} onChange={e => setQuestion(e.target.value)} />
            <button onClick={runCoach} disabled={coachLoad} style={{
              width: "100%", marginTop: 12, background: coachLoad ? C.fill : C.blue,
              color: coachLoad ? C.text3 : "#FFF", border: "none", borderRadius: 12,
              padding: "14px", fontSize: 16, fontWeight: 600, cursor: coachLoad ? "not-allowed" : "pointer",
              fontFamily: "inherit", transition: "all .2s"
            }}>
              {coachLoad ? "Analyseren..." : "Analyseer"}
            </button>
          </div>

          {coachLoad && (
            <div style={{ textAlign: "center", padding: "32px 0", color: C.text3 }}>
              <div style={{ fontSize: 40, marginBottom: 10, animation: "pulse 1.5s infinite" }}>🧠</div>
              <div style={{ fontSize: 14 }}>Data wordt geanalyseerd</div>
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

          {/* Tellers */}
          <div style={{ marginBottom: 10 }}>
            <Stepper label="Gewicht" value={entry.weight || 0} onChange={v => set("weight", v)} step={0.1} min={40} max={200} unit="kg" />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
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
      {tab === "trends" && (() => {
        const n = entries.length;
        const last7  = entries.slice(-7);
        const prev7  = entries.slice(-14, -7);
        const last30 = entries.slice(-30);

        // Compute insights
        const insights = [];

        // 1. HRV week-over-week — gebruik hrv_7d (Garmin's eigen 7d rolling avg) voor juiste waarde
        const latestHrvWeekly = [...last7].reverse().find(e => parseNum(e.hrv_7d) > 0);
        const prevHrvWeekly   = [...prev7].reverse().find(e => parseNum(e.hrv_7d) > 0);
        const hrv7a  = latestHrvWeekly ? parseNum(latestHrvWeekly.hrv_7d) : null;
        const hrvP7a = prevHrvWeekly   ? parseNum(prevHrvWeekly.hrv_7d)   : null;
        if (hrv7a != null) {
          if (hrvP7a != null && Math.abs(hrv7a - hrvP7a) > 1) {
            const d = hrv7a - hrvP7a;
            insights.push({ icon: "💚", color: d>0?C.green:C.red,
              title: d>0 ? "HRV verbetert" : "HRV daalt",
              body: `7d gemiddeld ${Math.abs(d).toFixed(1)} ms ${d>0?"hoger":"lager"} dan vorige week (${hrv7a.toFixed(0)} vs ${hrvP7a.toFixed(0)} ms).` });
          } else {
            insights.push({ icon: "💚", color: C.text3,
              title: "HRV stabiel",
              body: `7d gemiddeld ${hrv7a.toFixed(0)} ms deze week.` });
          }
        }

        // 2. Slaap consistentie
        const sleep7 = numArr(last7, "sleep_h");
        if (sleep7.length >= 2) {
          const below = sleep7.filter(v => v < 7.5).length;
          const sleepAvg = sleep7.reduce((a,b)=>a+b,0)/sleep7.length;
          insights.push({ icon: "🌙", color: below<=1?C.green:below<=3?C.orange:C.red,
            title: below===0 ? "Slaap op schema" : `${below}× onder slaapdoel`,
            body: `Gemiddeld ${sleepAvg.toFixed(1)}u · doel 7.5u · ${sleep7.length-below} van ${sleep7.length} nachten gehaald.` });
        }

        // 3. Training frequentie
        const trainDays7 = last7.filter(e => isTrue(e.trained)).length;
        const trainPrev  = prev7.filter(e => isTrue(e.trained)).length;
        if (n >= 3) {
          const delta = prev7.length ? trainDays7 - trainPrev : null;
          insights.push({ icon: "🏃", color: trainDays7>=4?C.green:trainDays7>=2?C.orange:C.text3,
            title: `${trainDays7} van 7 dagen getraind`,
            body: delta!=null && delta!==0
              ? `${Math.abs(delta)} dag${Math.abs(delta)>1?"en":""} ${delta>0?"meer":"minder"} dan vorige week (${trainPrev} dagen).`
              : trainDays7>=4 ? "Goede frequentie — houd dit vast." : trainDays7>=2 ? "Solide basis, ruimte voor meer." : "Laag volume — bewust herstel of mis je trainingen?" });
        }

        // 4. Slaap→HRV correlatie (min 6 paired punten)
        const paired = entries.slice(1).map((e, i) => ({
          hrv: parseNum(e.hrv), sleep: parseNum(entries[i].sleep_h)
        })).filter(p => !isNaN(p.hrv) && p.hrv>0 && !isNaN(p.sleep) && p.sleep>0);
        if (paired.length >= 6) {
          const good = paired.filter(p=>p.sleep>=7.5).map(p=>p.hrv);
          const poor = paired.filter(p=>p.sleep<7).map(p=>p.hrv);
          if (good.length>=2 && poor.length>=2) {
            const ga = good.reduce((a,b)=>a+b,0)/good.length;
            const pa = poor.reduce((a,b)=>a+b,0)/poor.length;
            if (ga - pa > 2) insights.push({ icon: "🔗", color: C.indigo,
              title: "Slaap verhoogt je HRV",
              body: `Na ≥7.5u slaap is je HRV ${(ga-pa).toFixed(0)} ms hoger (${ga.toFixed(0)} vs ${pa.toFixed(0)} ms na <7u).` });
          }
        }

        // 5. Gewicht trend
        const wVals = numArr(entries.slice(-21), "weight").filter(v=>v>40);
        if (wVals.length >= 3) {
          const wFirst = wVals[0], wLast = wVals[wVals.length-1];
          const diff = wLast - wFirst;
          if (Math.abs(diff) > 0.2) insights.push({ icon: "⚖️", color: C.text3,
            title: diff<0 ? `−${Math.abs(diff).toFixed(1)} kg afgenomen` : `+${diff.toFixed(1)} kg toegenomen`,
            body: `Van ${wFirst.toFixed(1)} naar ${wLast.toFixed(1)} kg in ${wVals.length} metingen.` });
        }

        // 6. Body battery trend
        const bat7 = numArr(last7, "body_battery");
        const batP = numArr(prev7, "body_battery");
        if (bat7.length>=2 && batP.length>=2) {
          const b7a = bat7.reduce((a,b)=>a+b,0)/bat7.length;
          const bPa = batP.reduce((a,b)=>a+b,0)/batP.length;
          const d = b7a - bPa;
          if (Math.abs(d) > 3) insights.push({ icon: "🔋", color: d>0?C.green:C.orange,
            title: d>0 ? "Battery neemt toe" : "Battery daalt",
            body: `Gemiddeld ${b7a.toFixed(0)}% deze week vs ${bPa.toFixed(0)}% vorige week.` });
        }

        // Week-over-week tiles
        const wkTiles = [
          { l: "HRV",      f: "hrv",          u: "ms", c: C.green,  good:"up"   },
          { l: "Slaap",    f: "sleep_h",       u: "u",  c: C.indigo, good:"up"   },
          { l: "Battery",  f: "body_battery",  u: "%",  c: C.teal,   good:"up"   },
          { l: "Stress",   f: "stress",        u: "",   c: C.orange, good:"down" },
        ].map(m => {
          const c7  = numArr(last7, m.f);  const ca = c7.length  ? c7.reduce((a,b)=>a+b,0)/c7.length   : null;
          const p7  = numArr(prev7, m.f);  const pa = p7.length  ? p7.reduce((a,b)=>a+b,0)/p7.length   : null;
          const delta = ca!=null&&pa!=null ? ca-pa : null;
          const good = delta==null ? null : (m.good==="up" ? delta>0.5 : delta<-0.5);
          return { ...m, val: ca!=null?ca.toFixed(1):null, delta, good };
        });

        return (
          <div className="fade" style={{ maxWidth: 640, margin: "0 auto", padding: "56px 16px 90px" }}>
            <div style={{ fontSize: 28, fontWeight: 700, letterSpacing: "-0.5px", marginBottom: 2 }}>Trends</div>
            <div style={{ fontSize: 14, color: C.text3, marginBottom: 20 }}>
              {n} dagen data · {n>0?fmt(entries[0].date):""}{n>1?" t/m "+fmt(entries[n-1].date):""}
            </div>

            {n < 2 ? (
              <div style={{ textAlign: "center", padding: "48px 0" }}>
                <div style={{ fontSize: 44, marginBottom: 12 }}>📈</div>
                <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 6 }}>Voortgang in aantocht</div>
                <div style={{ fontSize: 15, color: C.text3 }}>Sync meer dagen voor inzichten.</div>
              </div>
            ) : (
              <>
                {/* Week tiles */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 16 }}>
                  {wkTiles.map(m => (
                    <div key={m.l} style={{ background: C.card, borderRadius: 14, padding: "14px 16px" }}>
                      <div style={{ fontSize: 12, color: C.text3, marginBottom: 6 }}>{m.l} · 7 dagen gem.</div>
                      <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                        <span style={{ fontSize: 26, fontWeight: 700, color: m.c }}>{m.val ?? "—"}</span>
                        <span style={{ fontSize: 12, color: C.text3 }}>{m.u}</span>
                      </div>
                      {m.delta != null && (
                        <div style={{ fontSize: 12, marginTop: 4, color: m.good?C.green:m.good===false?C.red:C.text3, fontWeight: 500 }}>
                          {m.delta>0?"+":""}{m.delta.toFixed(1)} vs vorige week
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                {/* Inzichten */}
                {insights.length > 0 && (
                  <div style={{ marginBottom: 16 }}>
                    <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 10 }}>Inzichten</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      {insights.map((ins, i) => (
                        <div key={i} style={{ background: C.card, borderRadius: 14, padding: "14px 16px", display: "flex", gap: 14, alignItems: "flex-start" }}>
                          <div style={{ fontSize: 20, marginTop: 1, flexShrink: 0 }}>{ins.icon}</div>
                          <div>
                            <div style={{ fontSize: 14, fontWeight: 600, color: ins.color, marginBottom: 2 }}>{ins.title}</div>
                            <div style={{ fontSize: 13, color: C.text3, lineHeight: 1.5 }}>{ins.body}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* HRV chart */}
                {numArr(last30, "hrv").length >= 2 && (() => {
                  const hrvVals = numArr(last30,"hrv");
                  const latestWeekly = [...last30].reverse().find(e => parseNum(e.hrv_7d) > 0);
                  const displayHrv = latestWeekly ? parseNum(latestWeekly.hrv_7d) : hrvVals.slice(-1)[0];
                  return (
                  <div style={{ background: C.card, borderRadius: 16, padding: 16, marginBottom: 10 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
                      <div style={{ fontSize: 15, fontWeight: 600 }}>HRV</div>
                      <div style={{ fontSize: 22, fontWeight: 700, color: C.green }}>
                        {displayHrv}
                        <span style={{ fontSize: 12, color: C.text3, fontWeight: 400 }}> ms</span>
                      </div>
                    </div>
                    <div style={{ fontSize: 12, color: C.text3, marginBottom: 10 }}>
                      7d gem. · nacht gem. {avg(hrvVals)} ms · {hrvVals.length} metingen
                    </div>
                    <Sparkline data={hrvVals} color={C.green} height={56} fill />
                    <div style={{ display:"flex", justifyContent:"space-between", fontSize:11, color:C.text3, marginTop:4 }}>
                      <span>min {Math.min(...hrvVals)}</span>
                      <span>max {Math.max(...hrvVals)}</span>
                    </div>
                  </div>
                  );
                })()}

                {/* Slaap + Battery charts */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
                  {[
                    { l: "Slaap", f: "sleep_h", u: "u",  c: C.indigo, ref: 7.5 },
                    { l: "Battery", f: "body_battery", u: "%", c: C.teal, ref: null },
                  ].map(m => {
                    const vals = numArr(last30, m.f);
                    if (vals.length < 2) return null;
                    return (
                      <div key={m.l} style={{ background: C.card, borderRadius: 16, padding: 14 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>{m.l}</div>
                        <div style={{ fontSize: 20, fontWeight: 700, color: m.c }}>
                          {vals.slice(-1)[0]}<span style={{ fontSize: 11, color: C.text3, fontWeight:400 }}>{m.u}</span>
                        </div>
                        <div style={{ fontSize: 11, color: C.text3, marginBottom: 8 }}>gem. {avg(vals)}{m.u}</div>
                        <Sparkline data={vals} color={m.c} height={44} fill refLine={m.ref} />
                      </div>
                    );
                  })}
                </div>

                {/* Gewicht */}
                {wVals.length >= 2 && (
                  <div style={{ background: C.card, borderRadius: 16, padding: 16, marginBottom: 10 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
                      <div style={{ fontSize: 15, fontWeight: 600 }}>Gewicht</div>
                      <div style={{ fontSize: 20, fontWeight: 700 }}>
                        {wVals.slice(-1)[0].toFixed(1)}<span style={{ fontSize: 12, color: C.text3, fontWeight:400 }}> kg</span>
                      </div>
                    </div>
                    <Sparkline data={wVals} color={C.text3} height={44} fill />
                  </div>
                )}

                {/* Trainingsoverzicht */}
                <div style={{ background: C.card, borderRadius: 16, padding: 16, marginBottom: 10 }}>
                  <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Trainingen — laatste 4 weken</div>
                  {/* Weekly bars */}
                  {(() => {
                    const weeks = [3,2,1,0].map(w => {
                      const start = -28 + w*7, end = start + 7;
                      const slice = entries.slice(start, end || undefined);
                      const days = slice.filter(e=>isTrue(e.trained)).length;
                      const types = slice.filter(e=>isTrue(e.trained)).map(e=>e.train_type||"training");
                      return { label: `W${4-w}`, days, total: slice.length, types };
                    });
                    const maxDays = Math.max(...weeks.map(w=>w.days), 1);
                    return (
                      <div style={{ display:"flex", gap:8, alignItems:"flex-end", marginBottom:16, height:60 }}>
                        {weeks.map((w,i) => (
                          <div key={i} style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", gap:4 }}>
                            <div style={{ fontSize:11, fontWeight:600, color:C.text3 }}>{w.days}</div>
                            <div style={{ width:"100%", background:C.fill, borderRadius:6, overflow:"hidden", height:36 }}>
                              <div style={{ width:"100%", height:`${(w.days/maxDays)*100}%`, background:w.days>=4?C.green:w.days>=2?C.orange:C.fill, borderRadius:6, transition:"height 0.4s", marginTop:`${(1-w.days/maxDays)*100}%` }} />
                            </div>
                            <div style={{ fontSize:11, color:C.text3 }}>{w.label}</div>
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                  {/* Dot heatmap */}
                  <div style={{ display:"flex", gap:4, flexWrap:"wrap" }}>
                    {entries.slice(-28).map(e => (
                      <div key={e.date}
                        style={{ width:22, height:22, borderRadius:5, display:"flex", alignItems:"center", justifyContent:"center", fontSize:11,
                          background: isTrue(e.trained) ? C.orange+"22" : C.fill }}
                        title={`${fmt(e.date)}: ${e.train_type||"rust"}`}>
                        {isTrue(e.trained) && <div style={{ width:8, height:8, borderRadius:4, background:C.orange }} />}
                      </div>
                    ))}
                  </div>
                  <div style={{ marginTop:8, fontSize:12, color:C.text3 }}>
                    {entries.slice(-28).filter(e=>isTrue(e.trained)).length} trainingen in 28 dagen
                  </div>
                </div>

                {/* Readiness history */}
                {(() => {
                  const rVals = entries.slice(-21).map(e => calcReadiness(e, entries)).filter(v=>v!=null);
                  if (rVals.length < 2) return null;
                  return (
                    <div style={{ background: C.card, borderRadius: 16, padding: 16, marginBottom: 10 }}>
                      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", marginBottom:4 }}>
                        <div style={{ fontSize:15, fontWeight:600 }}>Readiness</div>
                        <div style={{ fontSize:20, fontWeight:700, color:readinessColor(rVals.slice(-1)[0]) }}>
                          {rVals.slice(-1)[0]}
                        </div>
                      </div>
                      <div style={{ fontSize:12, color:C.text3, marginBottom:10 }}>gem. {avg(rVals)} · {rVals.length} berekeningen</div>
                      <Sparkline data={rVals} color={C.blue} height={44} fill />
                    </div>
                  );
                })()}
              </>
            )}
          </div>
        );
      })()}

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

          {/* Stappendoel */}
          <div style={{ fontSize: 17, fontWeight: 600, margin: "24px 0 10px" }}>Dagelijks stappendoel</div>
          <div style={{ background: C.card, borderRadius: 16, padding: 16, marginBottom: 8 }}>
            <div style={{ fontSize: 13, color: C.text3, marginBottom: 10 }}>
              Stel je Garmin stappendoel in. Garmin past dit automatisch aan op basis van je vorige week.
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <input
                type="number"
                min="1000" max="30000" step="100"
                value={stepGoal}
                onChange={e => {
                  const v = parseInt(e.target.value, 10);
                  if (!isNaN(v) && v > 0) {
                    setStepGoal(v);
                    localStorage.setItem("step_goal", String(v));
                  }
                }}
                style={{ flex: 1, background: C.fill, border: "none", borderRadius: 10, padding: "10px 14px", fontSize: 16, fontWeight: 600, color: C.text, outline: "none" }}
              />
              <span style={{ fontSize: 14, color: C.text3 }}>stappen</span>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
              {[6000, 8000, 9000, 9110, 10000, 12000].map(g => (
                <button key={g} onClick={() => { setStepGoal(g); localStorage.setItem("step_goal", String(g)); }}
                  style={{ background: stepGoal === g ? C.blue : C.fill, color: stepGoal === g ? "#fff" : C.text3, border: "none", borderRadius: 20, padding: "4px 12px", fontSize: 13, cursor: "pointer", fontWeight: stepGoal === g ? 600 : 400 }}>
                  {g.toLocaleString("nl")}
                </button>
              ))}
            </div>
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
