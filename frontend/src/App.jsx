import { useState, useEffect, useCallback } from "react";

// ── Google Sheets API ─────────────────────────────────────────────────────────
const SHEET_ID   = import.meta.env.VITE_GOOGLE_SHEET_ID;
const SA_EMAIL   = import.meta.env.VITE_GOOGLE_SERVICE_ACCOUNT_EMAIL;
const SA_KEY     = import.meta.env.VITE_GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");
const CLAUDE_KEY = import.meta.env.VITE_CLAUDE_API_KEY;
const TAB        = "coach_data";
const RANGE      = `${TAB}!A:AH`;

async function getJWT() {
  const header  = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const now     = Math.floor(Date.now() / 1000);
  const payload = btoa(JSON.stringify({
    iss: SA_EMAIL, scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token", exp: now + 3600, iat: now
  }));
  const unsigned  = `${header}.${payload}`;
  const keyData   = SA_KEY.replace(/-----BEGIN( RSA)? PRIVATE KEY-----|-----END( RSA)? PRIVATE KEY-----|\n/g, "");
  const binaryKey = Uint8Array.from(atob(keyData), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8", binaryKey.buffer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]
  );
  const sig    = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, new TextEncoder().encode(unsigned));
  const b64sig = btoa(String.fromCharCode(...new Uint8Array(sig)));
  const jwt    = `${unsigned}.${b64sig}`;
  const res    = await fetch("https://oauth2.googleapis.com/token", {
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

async function sheetsAppend(row) {
  const token = await getJWT();
  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(RANGE)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ values: [row] }) }
  );
}

async function sheetsUpdate(rowIdx, row) {
  const token = await getJWT();
  const range = `${TAB}!A${rowIdx}:AG${rowIdx}`;
  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
    { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ values: [row] }) }
  );
}

// ── Constants ─────────────────────────────────────────────────────────────────
const HEADERS = [
  "date","weight","alcohol","bp_sys","bp_dia",
  "sleep_h","sleep_q","sleep_deep","sleep_rem",
  "hrv","rhr","stress","body_battery","steps",
  "trained","train_type","train_min","train_dist",
  "avg_hr","max_hr","avg_pace","cadence",
  "ground_contact","vertical_osc","vertical_ratio","stride_length","training_effect","vo2max",
  "energy","mental_unrest","breathing","breathing_type","notes","sleep_prep"
];

// Plan item → entry field mapping (for auto-save)
const PLAN_FIELD = { breathing: "breathing", sleep: "sleep_prep" };

const today     = () => new Date().toISOString().slice(0, 10);
const fmt       = (d) => new Date(d + "T12:00:00").toLocaleDateString("nl-NL", { day: "numeric", month: "short" });
const numArr    = (entries, f) => entries.map(e => parseFloat(e[f])).filter(v => !isNaN(v) && v > 0);
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

  if (last.hrv) {
    const ratio = +last.hrv / avgHrv;
    score += (ratio - 1) * 40;
    n++;
  }
  if (last.sleep_h) {
    const s = Math.min(+last.sleep_h / 8, 1.1);
    score += (s - 0.875) * 30;
    n++;
  }
  if (last.stress) {
    score -= (+last.stress - 5) * 3;
    n++;
  }
  if (last.body_battery) {
    score += (+last.body_battery - 50) * 0.3;
    n++;
  }
  return Math.max(0, Math.min(100, Math.round(score)));
}

// ── Daily plan ────────────────────────────────────────────────────────────────
function getDailyPlan(last, entries) {
  const readiness  = calcReadiness(last, entries);
  const race1Days  = daysUntil("2026-07-05");
  const recentDays = (entries || []).slice(-3);
  const trainedRecently = recentDays.filter(e => isTrue(e.trained)).length;
  const needsRest  = trainedRecently >= 2 || (readiness !== null && readiness < 45);
  const canIntense = readiness !== null && readiness >= 70;

  // Training: als Garmin al een activiteit heeft, toon die — anders geef advies
  const garminTrained = isTrue(last?.trained);
  const typeLabel = last?.train_type
    ? last.train_type.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())
    : "";
  const isRun = (last?.train_type || "").toLowerCase().includes("run");
  const trainDone = garminTrained;

  let trainTask;
  if (garminTrained) {
    // Garmin heeft vandaag al een activiteit gesynct — toon die
    const parts = [];
    if (last?.train_min) parts.push(`${last.train_min} min`);
    if (last?.train_dist) parts.push(`${last.train_dist} km`);
    if (last?.avg_hr) parts.push(`gem. ${last.avg_hr} bpm`);
    if (isRun && last?.avg_pace) parts.push(`${last.avg_pace}/km`);
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

  // Slaap: toon gisteravond's werkelijke slaap vs doel
  const SLEEP_GOAL = 7.5;
  const sleepActual = last?.sleep_h ? +last.sleep_h : null;
  const sleepDone = sleepActual !== null && sleepActual >= SLEEP_GOAL;
  const sleepPrepped = isTrue(last?.sleep_prep);
  const sleepSub = sleepActual !== null
    ? `Gisteren: ${sleepActual}u slaap · doel ${SLEEP_GOAL}u · schermen weg 22:00`
    : `Doel ${SLEEP_GOAL}u slaap · schermen weg 22:00`;

  return [
    { id: "morning", cat: "Ochtend", icon: "🌅", label: "Ochtendmeting", sub: "HRV & body battery ophalen via Garmin", color: C.blue, auto: true, done: !!last?.hrv },
    { id: "breathing", cat: "Mindfulness", icon: "🫁", label: "Box breathing", sub: "4×4 min · 4 tellen in-hold-uit-hold", color: C.purple, done: isTrue(last?.breathing) },
    { ...trainTask, id: "training", done: trainDone },
    { id: "steps", cat: "Beweging", icon: "👟", label: "Dagelijks stappendoel", sub: `${last?.steps ? Math.round(+last.steps).toLocaleString("nl") : "—"} / 10.000 vandaag`, color: C.green, auto: true, done: +last?.steps >= 10000 },
    { id: "checkin", cat: "Check-in", icon: "📋", label: "Dagelijkse check-in", sub: "Energie, gewicht, opmerkingen invullen", color: C.blue, done: !!(last?.date === today() && last?.energy) },
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
      { icon: "📵", text: "22:00 — schermen uit of op nachtmodus. Blauw licht onderdrukt melatonine." },
      { icon: "🌡", text: "Zet de slaapkamer koel: 16–19°C is optimaal voor diepe slaap." },
      { icon: "📖", text: "10 min lezen of journalen — vermindert piekergedachten." },
      { icon: "🌬", text: "4-7-8 ademhaling: in 4, vasthouden 7, uit 8. Doe 4 ronden." },
      { icon: "⌚", text: "Laat je Garmin aan — de sleep tracking start automatisch." },
      { icon: "🎯", text: "Doel: 7,5 uur in bed. Garmin registreert diepe slaap, REM en HRV." },
    ],
    tip: "De uren voor middernacht tellen het zwaarst voor herstel. Eerder slapen verhoogt je diepe slaappercentage significant.",
  },
};

// ── Coaching ──────────────────────────────────────────────────────────────────
async function fetchCoaching(entries, question) {
  const recent = entries.slice(-7);
  const prompt = `Je bent een warme maar directe personal health & performance coach. Analyseer en geef concrete coaching.

DATA (laatste 7 dagen): ${JSON.stringify(recent, null, 2)}

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
  const [planDone,  setPlanDone]  = useState({});
  const [taskDetail, setTaskDetail] = useState(null); // task object or null

  const loadData = useCallback(async () => {
    if (!sheetMode) {
      try {
        const raw = JSON.parse(localStorage.getItem("coach_v2") || "{}");
        setEntries(Object.values(raw).sort((a, b) => a.date.localeCompare(b.date)));
      } catch {}
      setLoading(false);
      return;
    }
    try {
      const res  = await sheetsGet();
      const rows = res.values || [];
      if (rows.length < 2) { setLoading(false); return; }
      const hdrs = rows[0];
      const data = rows.slice(1).map(r => {
        const obj = {};
        hdrs.forEach((h, i) => { obj[h] = r[i] ?? ""; });
        return obj;
      }).sort((a, b) => a.date.localeCompare(b.date));
      setEntries(data);
    } catch (e) {
      console.error("Sheets load error:", e);
      setSheetMode(false);
    }
    setLoading(false);
  }, [sheetMode]);

  useEffect(() => { loadData(); }, [loadData]);

  useEffect(() => {
    const existing = entries.find(e => e.date === entry.date);
    if (existing) setEntry({ ...EMPTY, ...existing });
    else setEntry({ ...EMPTY, date: entry.date });
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

  // Auto-save a single field for the current date (used by plan item toggles)
  const autoSaveField = async (key, value) => {
    const updated = { ...entry, [key]: value };
    setEntry(updated);
    const row = HEADERS.map(h => updated[h] ?? "");
    try {
      if (sheetMode) {
        const res   = await sheetsGet();
        const rows  = res.values || [];
        const dates = rows.slice(1).map(r => r[0]);
        const idx   = dates.indexOf(updated.date);
        if (idx >= 0) await sheetsUpdate(idx + 2, row);
        else await sheetsAppend(row);
      } else {
        const raw = JSON.parse(localStorage.getItem("coach_v2") || "{}");
        raw[updated.date] = updated;
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

  const last      = entries[entries.length - 1];
  const todayEntry = entries.find(e => e.date === today());
  const race1     = daysUntil("2026-07-05");
  const race2     = daysUntil("2026-10-04");
  const readiness = calcReadiness(todayEntry || last, entries);
  const plan      = getDailyPlan(todayEntry || last, entries);
  const doneTasks = plan.filter(t => t.done || planDone[t.id]).length;

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
      display: "flex", alignItems: "flex-end", justifyContent: "center"
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: C.card, borderRadius: "20px 20px 0 0",
        width: "100%", maxWidth: 640, maxHeight: "80vh",
        overflowY: "auto", padding: "0 0 40px"
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
                await autoSaveField(field, val ? "true" : "false");
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
        <div className="fade" style={{ paddingBottom: 90 }}>
          {/* Hero header */}
          <div style={{ background: C.card, padding: "56px 20px 24px" }}>
            <div style={{ maxWidth: 640, margin: "0 auto" }}>
              <div style={{ fontSize: 15, color: C.text3, marginBottom: 2 }}>{greeting}</div>
              <div style={{ fontSize: 28, fontWeight: 700, letterSpacing: "-0.5px", marginBottom: 20 }}>Jouw dag vandaag</div>

              <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
                {/* Readiness ring */}
                <div style={{ position: "relative", flexShrink: 0 }}>
                  <Ring value={readiness ?? 0} color={readiness ? readinessColor(readiness) : C.text3} size={110} stroke={10} />
                  <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
                    <div style={{ fontSize: 26, fontWeight: 700, color: readiness ? readinessColor(readiness) : C.text3, lineHeight: 1 }}>{readiness ?? "—"}</div>
                    <div style={{ fontSize: 11, color: C.text3, marginTop: 2 }}>{readiness ? readinessLabel(readiness) : "Geen data"}</div>
                  </div>
                </div>

                {/* Today's key metrics */}
                <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 8 }}>
                  {[
                    { l: "HRV",    v: (todayEntry||last)?.hrv,          u: "ms",  c: C.green  },
                    { l: "Slaap",  v: (todayEntry||last)?.sleep_h,      u: "uur", c: C.indigo },
                    { l: "Stress", v: (todayEntry||last)?.stress,        u: "/10", c: C.orange },
                    { l: "Batt.",  v: (todayEntry||last)?.body_battery,  u: "%",   c: C.teal   },
                  ].map(m => (
                    <div key={m.l} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span style={{ fontSize: 13, color: C.text3 }}>{m.l}</span>
                      <span style={{ fontSize: 15, fontWeight: 600, color: m.v ? m.c : C.text3 }}>
                        {m.v || "—"}{m.v ? <span style={{ fontSize: 11, fontWeight: 400, color: C.text3 }}> {m.u}</span> : ""}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Race pills */}
              <div style={{ display: "flex", gap: 8, marginTop: 20 }}>
                <div style={{ flex: 1, background: C.green + "15", borderRadius: 12, padding: "10px 14px" }}>
                  <div style={{ fontSize: 11, color: C.green, fontWeight: 600 }}>10K Noordwijk</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: C.green }}>{race1} <span style={{ fontSize: 13, fontWeight: 400 }}>dagen</span></div>
                </div>
                <div style={{ flex: 1, background: C.blue + "15", borderRadius: 12, padding: "10px 14px" }}>
                  <div style={{ fontSize: 11, color: C.blue, fontWeight: 600 }}>Gym-race Utrecht</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: C.blue }}>{race2} <span style={{ fontSize: 13, fontWeight: 400 }}>dagen</span></div>
                </div>
              </div>
            </div>
          </div>

          {/* Daily plan */}
          <div style={{ maxWidth: 640, margin: "0 auto", padding: "20px 16px 0" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
              <div style={{ fontSize: 20, fontWeight: 700 }}>Dagschema</div>
              <div style={{ fontSize: 13, color: C.text3 }}>{doneTasks}/{plan.length} klaar</div>
            </div>

            {/* Progress bar */}
            <div style={{ height: 4, background: C.fill, borderRadius: 2, marginBottom: 16, overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${(doneTasks/plan.length)*100}%`, background: C.green, borderRadius: 2, transition: "width 0.4s ease" }} />
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {plan.map((task, i) => {
                const done = task.done || !!planDone[task.id];
                return (
                  <div key={task.id} onClick={() => setTaskDetail({ ...task, done })}
                    style={{
                      background: C.card, borderRadius: i === 0 ? "14px 14px 4px 4px" : i === plan.length-1 ? "4px 4px 14px 14px" : 4,
                      padding: "14px 16px", display: "flex", alignItems: "center", gap: 14,
                      cursor: "pointer", opacity: done ? 0.6 : 1,
                      transition: "opacity 0.2s"
                    }}>
                    <div style={{
                      width: 42, height: 42, borderRadius: 12, flexShrink: 0,
                      background: done ? C.fill : task.color + "18",
                      display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20
                    }}>
                      {done ? "✓" : task.icon}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 15, fontWeight: 600, color: done ? C.text3 : C.text, textDecoration: done ? "line-through" : "none" }}>{task.label}</div>
                      <div style={{ fontSize: 13, color: C.text3, marginTop: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{task.sub}</div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                      <div style={{ fontSize: 11, color: task.color, fontWeight: 600, background: task.color + "15", padding: "3px 8px", borderRadius: 20 }}>{task.cat}</div>
                      <svg width="8" height="13" viewBox="0 0 8 13" fill="none"><path d="M1 1l6 5.5L1 12" stroke={C.text3} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Latest run stats if available */}
            {last?.avg_pace && (
              <div style={{ marginTop: 20 }}>
                <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 12 }}>Laatste training</div>
                <div style={{ background: C.card, borderRadius: 14, padding: 16, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
                  {[
                    { l: "Tempo",     v: last.avg_pace,       u: "/km"  },
                    { l: "Cadans",    v: last.cadence,        u: "spm"  },
                    { l: "Afstand",   v: last.train_dist,     u: "km"   },
                    { l: "GCT",       v: last.ground_contact, u: "ms"   },
                    { l: "V. Osc.",   v: last.vertical_osc,   u: "cm"   },
                    { l: "HR gem.",   v: last.avg_hr,         u: "bpm"  },
                  ].filter(m => m.v).map(m => (
                    <div key={m.l} style={{ textAlign: "center" }}>
                      <div style={{ fontSize: 11, color: C.text3, marginBottom: 3 }}>{m.l}</div>
                      <div style={{ fontSize: 17, fontWeight: 700 }}>{m.v}<span style={{ fontSize: 10, color: C.text3, fontWeight: 400 }}> {m.u}</span></div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {!sheetMode && (
              <div style={{ marginTop: 16, background: C.orange + "15", borderRadius: 12, padding: "12px 16px", fontSize: 13, color: C.orange }}>
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
          <div style={{ fontSize: 28, fontWeight: 700, letterSpacing: "-0.5px", marginBottom: 4 }}>Invullen</div>
          <div style={{ fontSize: 15, color: C.text3, marginBottom: 20 }}>Vul aan wat Garmin niet automatisch meet</div>

          {[
            { title: "Datum", color: C.blue, fields: null, custom: (
              <Field label="Datum">
                <input type="date" value={entry.date} onChange={e => set("date", e.target.value)} />
              </Field>
            )},
            { title: "Lichaam", color: C.orange, fields: [
              { k:"weight",  l:"Gewicht (kg)",       t:"number", step:"0.1", ph:"79.5" },
              { k:"alcohol", l:"Alcohol (eenheden)",  t:"number", step:"0.5", ph:"0" },
              { k:"bp_sys",  l:"Bloeddruk sys",       t:"number", ph:"120" },
              { k:"bp_dia",  l:"Bloeddruk dia",       t:"number", ph:"80" },
            ]},
            { title: "Slaap", color: C.indigo, fields: [
              { k:"sleep_h",    l:"Duur (uur)",          t:"number", step:"0.25", ph:"7.5" },
              { k:"sleep_q",    l:"Kwaliteit (1–10)",    t:"number", ph:"7" },
              { k:"sleep_deep", l:"Diepe slaap (uur)",   t:"number", step:"0.25", ph:"1.5" },
              { k:"sleep_rem",  l:"REM (uur)",           t:"number", step:"0.25", ph:"1.5" },
            ]},
            { title: "Vitals", color: C.teal, fields: [
              { k:"hrv",          l:"HRV (ms)",             t:"number", ph:"45" },
              { k:"rhr",          l:"Rusthartslag (bpm)",   t:"number", ph:"58" },
              { k:"body_battery", l:"Body battery (%)",     t:"number", ph:"75" },
              { k:"steps",        l:"Stappen",              t:"number", ph:"8000" },
              { k:"energy",       l:"Energie (1–10)",       t:"number", ph:"7" },
              { k:"stress",       l:"Stress (1–10)",        t:"number", ph:"4" },
            ]},
          ].map(section => (
            <div key={section.title} style={{ background: C.card, borderRadius: 16, padding: 16, marginBottom: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: section.color, marginBottom: 14, textTransform: "uppercase", letterSpacing: "0.05em" }}>{section.title}</div>
              {section.custom || (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  {section.fields.map(f => (
                    <Field key={f.k} label={f.l}>
                      <input type={f.t} step={f.step} placeholder={f.ph} value={entry[f.k]} onChange={e => set(f.k, e.target.value)} />
                    </Field>
                  ))}
                </div>
              )}
            </div>
          ))}

          {/* Training */}
          <div style={{ background: C.card, borderRadius: 16, padding: 16, marginBottom: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: C.orange, marginBottom: 14, textTransform: "uppercase", letterSpacing: "0.05em" }}>Training</div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: isTrue(entry.trained) ? 14 : 0 }}>
              <span style={{ fontSize: 16 }}>Getraind vandaag</span>
              <Toggle checked={isTrue(entry.trained)} onChange={v => set("trained", v)} />
            </div>
            {isTrue(entry.trained) && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <Field label="Type">
                  <select value={entry.train_type} onChange={e => set("train_type", e.target.value)}>
                    <option value="">Kies...</option>
                    {["hardlopen","PT","kracht thuis","core","mobiliteit","herstel","cardio","anders"].map(o => <option key={o}>{o}</option>)}
                  </select>
                </Field>
                <Field label="Duur (min)"><input type="number" placeholder="45" value={entry.train_min} onChange={e => set("train_min", e.target.value)} /></Field>
                <Field label="Afstand (km)"><input type="number" step="0.1" placeholder="5.0" value={entry.train_dist} onChange={e => set("train_dist", e.target.value)} /></Field>
              </div>
            )}
          </div>

          {/* Mentaal */}
          <div style={{ background: C.card, borderRadius: 16, padding: 16, marginBottom: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: C.purple, marginBottom: 14, textTransform: "uppercase", letterSpacing: "0.05em" }}>Mentaal & welzijn</div>
            {[
              { k: "mental_unrest", l: "Mentale onrust aanwezig" },
              { k: "breathing",     l: "Ademhaling / meditatie gedaan" },
            ].map(f => (
              <div key={f.k} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
                <span style={{ fontSize: 16 }}>{f.l}</span>
                <Toggle checked={isTrue(entry[f.k])} onChange={v => set(f.k, v)} />
              </div>
            ))}
            {isTrue(entry.breathing) && (
              <div style={{ marginBottom: 12 }}>
                <Field label="Type oefening">
                  <input placeholder="box breathing, 4-7-8, bodyscan..." value={entry.breathing_type} onChange={e => set("breathing_type", e.target.value)} />
                </Field>
              </div>
            )}
            <Field label="Opmerkingen">
              <textarea rows={3} style={{ resize: "none" }} placeholder="Hoe voel je je? Bijzonderheden..."
                value={entry.notes} onChange={e => set("notes", e.target.value)} />
            </Field>
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
