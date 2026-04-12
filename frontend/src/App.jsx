import { useState, useEffect, useCallback } from "react";

// ── Google Sheets API ─────────────────────────────────────────────────────────
const SHEET_ID   = import.meta.env.VITE_GOOGLE_SHEET_ID;
const SA_EMAIL   = import.meta.env.VITE_GOOGLE_SERVICE_ACCOUNT_EMAIL;
const SA_KEY     = import.meta.env.VITE_GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");
const CLAUDE_KEY = import.meta.env.VITE_CLAUDE_API_KEY;
const TAB        = "coach_data";
const RANGE      = `${TAB}!A:W`;

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
  const range = `${TAB}!A${rowIdx}:W${rowIdx}`;
  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
    { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ values: [row] }) }
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const HEADERS = [
  "date","weight","alcohol","bp_sys","bp_dia",
  "sleep_h","sleep_q","sleep_deep","sleep_rem",
  "hrv","rhr","stress","body_battery","steps",
  "trained","train_type","train_min","train_dist",
  "energy","mental_unrest","breathing","breathing_type","notes"
];

const today     = () => new Date().toISOString().slice(0, 10);
const fmt       = (d) => new Date(d + "T12:00:00").toLocaleDateString("nl-NL", { day: "numeric", month: "short" });
const numArr    = (entries, f) => entries.map(e => parseFloat(e[f])).filter(v => !isNaN(v) && v > 0);
const avg       = (arr) => arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1) : "—";
const daysUntil = (d) => Math.ceil((new Date(d) - new Date()) / 86400000);
const EMPTY     = HEADERS.reduce((o, h) => ({ ...o, [h]: "" }), { trained: false, mental_unrest: false, breathing: false });

// ── Claude coaching ───────────────────────────────────────────────────────────
async function fetchCoaching(entries, question) {
  const recent = entries.slice(-7);
  const prompt = `Je bent een warme maar directe personal health & performance coach. Analyseer en geef concrete coaching.

DATA (laatste 7 dagen): ${JSON.stringify(recent, null, 2)}

CONTEXT/VRAAG: ${question || "Geef mijn dagelijkse check-in analyse."}

DOELEN: hogere HRV, optimale slaap, energiek wakker, betere gezondheid, innerlijke rust.
WEDSTRIJDEN: 10km 5 juli 2026 Noordwijk · Gym-race 4 oktober 2026 Utrecht.

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
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }]
    })
  });
  const d = await res.json();
  return d.content?.find(b => b.type === "text")?.text || "Geen analyse beschikbaar.";
}

// ── Design tokens ─────────────────────────────────────────────────────────────
const C = {
  bg:          "#F0F4F8",
  card:        "#FFFFFF",
  green:       "#22C55E",
  greenLight:  "#DCFCE7",
  greenDark:   "#16A34A",
  blue:        "#3B82F6",
  blueLight:   "#DBEAFE",
  purple:      "#8B5CF6",
  purpleLight: "#EDE9FE",
  amber:       "#F59E0B",
  amberLight:  "#FEF3C7",
  red:         "#EF4444",
  redLight:    "#FEE2E2",
  text:        "#111827",
  muted:       "#6B7280",
  light:       "#9CA3AF",
  border:      "#E5E7EB",
  shadow:      "0 2px 8px rgba(0,0,0,0.06)",
};

// ── Components ────────────────────────────────────────────────────────────────
const StatPill = ({ label, value, unit, status }) => {
  const bg  = status === "good" ? C.greenLight : status === "warn" ? C.amberLight : status === "bad" ? C.redLight : "#F3F4F6";
  const col = status === "good" ? C.greenDark  : status === "warn" ? "#B45309"    : status === "bad" ? "#DC2626"  : C.muted;
  return (
    <div style={{ background: bg, borderRadius: 12, padding: "10px 8px", textAlign: "center", flex: "1 1 0" }}>
      <div style={{ fontSize: 10, color: col, fontWeight: 600, marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: col, lineHeight: 1 }}>
        {value || "—"}
        {value ? <span style={{ fontSize: 10, fontWeight: 500 }}> {unit}</span> : ""}
      </div>
    </div>
  );
};

const Sparkline = ({ data, color, height = 44 }) => {
  if (data.length < 2) return null;
  const min = Math.min(...data), max = Math.max(...data), range = max - min || 1;
  const W = 200, H = height, p = 4;
  const pts = data.map((v, i) => {
    const x = p + (i / (data.length - 1)) * (W - p * 2);
    const y = H - p - ((v - min) / range) * (H - p * 2);
    return `${x},${y}`;
  }).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height }} preserveAspectRatio="none">
      <polyline fill="none" stroke={color} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" points={pts} />
    </svg>
  );
};

const TrendCard = ({ label, entries, field, unit, color, good = "up" }) => {
  const vals = numArr(entries, field);
  if (!vals.length) return null;
  const last  = vals[vals.length - 1];
  const prev  = vals.slice(-4, -1);
  const prevA = prev.length ? prev.reduce((a, b) => a + b, 0) / prev.length : last;
  const dir   = last > prevA + 0.5 ? "up" : last < prevA - 0.5 ? "down" : "flat";
  const isGood = (good === "up" && dir === "up") || (good === "down" && dir === "down");
  const trendCol = dir === "flat" ? C.light : isGood ? C.green : C.red;
  const arrow = dir === "up" ? "↑" : dir === "down" ? "↓" : "→";
  return (
    <div style={{ background: C.card, borderRadius: 16, padding: 16, boxShadow: C.shadow }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
        <span style={{ fontSize: 13, color: C.muted, fontWeight: 500 }}>{label}</span>
        <div>
          <span style={{ fontSize: 20, fontWeight: 700, color: C.text }}>{last}</span>
          <span style={{ fontSize: 11, color: C.muted }}> {unit}</span>
          <span style={{ fontSize: 15, color: trendCol, marginLeft: 4, fontWeight: 700 }}>{arrow}</span>
        </div>
      </div>
      <Sparkline data={vals} color={color} />
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: C.light, marginTop: 6 }}>
        <span>gem. {avg(vals)} {unit}</span>
        <span>{vals.length} metingen</span>
      </div>
    </div>
  );
};

const CoachOutput = ({ text }) => {
  const sections = text.split(/###\s+/).filter(Boolean);
  const icons = {
    "Hoe sta je ervoor":         "💚",
    "3 Belangrijkste inzichten": "💡",
    "Doe dit vandaag":           "⚡",
    "Training advies":           "🏃",
    "Herstel & rust":            "😴",
    "Dit vraagt aandacht":       "⚠️",
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {sections.map((s, i) => {
        const [title, ...rest] = s.trim().split("\n");
        const isFirst = i === 0;
        return (
          <div key={i} style={{
            background: isFirst ? C.greenLight : C.card,
            border: `1px solid ${isFirst ? C.green + "44" : C.border}`,
            borderRadius: 14, padding: 16
          }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
              <span style={{ fontSize: 16 }}>{icons[title.trim()] || "•"}</span>
              <span style={{ color: isFirst ? C.greenDark : C.text, fontSize: 13, fontWeight: 700 }}>{title.trim()}</span>
            </div>
            <div style={{ color: C.text, fontSize: 14, lineHeight: 1.75, whiteSpace: "pre-wrap" }}>{rest.join("\n").trim()}</div>
          </div>
        );
      })}
    </div>
  );
};

const Toggle = ({ checked, onChange }) => (
  <label style={{ position: "relative", display: "inline-block", width: 48, height: 26, flexShrink: 0, cursor: "pointer" }}>
    <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} style={{ opacity: 0, width: 0, height: 0 }} />
    <span style={{ position: "absolute", inset: 0, borderRadius: 26, transition: "0.25s", background: checked ? C.green : C.border }}>
      <span style={{
        position: "absolute", height: 20, width: 20, left: checked ? 24 : 3, bottom: 3,
        borderRadius: "50%", background: "#FFF", transition: "0.25s", boxShadow: "0 1px 3px rgba(0,0,0,0.2)"
      }} />
    </span>
  </label>
);

const Field = ({ label, children }) => (
  <div>
    <div style={{ fontSize: 12, color: C.muted, fontWeight: 500, marginBottom: 5 }}>{label}</div>
    {children}
  </div>
);

const Section = ({ title, color, children }) => (
  <div style={{ background: C.card, borderRadius: 16, padding: 16, boxShadow: C.shadow }}>
    <div style={{ fontSize: 14, fontWeight: 700, color, marginBottom: 14 }}>{title}</div>
    {children}
  </div>
);

// ── Main App ──────────────────────────────────────────────────────────────────
export default function App() {
  const [entries,   setEntries]   = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [syncing,   setSyncing]   = useState(false);
  const [tab,       setTab]       = useState("coach");
  const [entry,     setEntry]     = useState({ ...EMPTY, date: today() });
  const [coaching,  setCoaching]  = useState("");
  const [coachLoad, setCoachLoad] = useState(false);
  const [question,  setQuestion]  = useState("");
  const [saveMsg,   setSaveMsg]   = useState("");
  const [sheetMode, setSheetMode] = useState(!!SHEET_ID);

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

  const runCoach = async () => {
    setCoachLoad(true);
    setCoaching("");
    try {
      const result = await fetchCoaching(entries.length ? entries : [entry], question);
      setCoaching(result);
    } catch {
      setCoaching("Fout bij ophalen coaching.");
    }
    setCoachLoad(false);
  };

  const set = (k, v) => setEntry(p => ({ ...p, [k]: v }));

  const last  = entries[entries.length - 1];
  const race1 = daysUntil("2026-07-05");
  const race2 = daysUntil("2026-10-04");
  const hour  = new Date().getHours();
  const greeting = hour < 12 ? "Goedemorgen" : hour < 18 ? "Goedemiddag" : "Goedenavond";

  const TABS = [
    { id: "coach",   label: "Coach",        icon: "✦" },
    { id: "checkin", label: "Vandaag",       icon: "+" },
    { id: "trends",  label: "Voortgang",     icon: "↗" },
    { id: "data",    label: "Logboek",       icon: "≡" },
    { id: "setup",   label: "Instellingen",  icon: "⚙" },
  ];

  if (loading) return (
    <div style={{ background: C.bg, minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "system-ui" }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ width: 56, height: 56, borderRadius: "50%", background: C.greenLight, margin: "0 auto 16px", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 26 }}>💚</div>
        <div style={{ color: C.muted, fontSize: 14 }}>Even laden...</div>
      </div>
    </div>
  );

  const hrvStatus    = !last?.hrv          ? "neutral" : +last.hrv > 50          ? "good" : +last.hrv > 35          ? "warn" : "bad";
  const sleepStatus  = !last?.sleep_h      ? "neutral" : +last.sleep_h >= 7.5    ? "good" : +last.sleep_h >= 6      ? "warn" : "bad";
  const energyStatus = !last?.energy       ? "neutral" : +last.energy >= 7       ? "good" : +last.energy >= 5       ? "warn" : "bad";
  const stressStatus = !last?.stress       ? "neutral" : +last.stress <= 4       ? "good" : +last.stress <= 7       ? "warn" : "bad";

  return (
    <div style={{ fontFamily: "'Inter', system-ui, -apple-system, sans-serif", background: C.bg, minHeight: "100vh", color: C.text }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        input, select, textarea {
          background: #F9FAFB !important;
          border: 1.5px solid ${C.border} !important;
          color: ${C.text} !important;
          border-radius: 10px;
          padding: 10px 12px;
          font-family: inherit;
          font-size: 15px;
          width: 100%;
          outline: none;
          transition: border-color .15s;
          -webkit-appearance: none;
          appearance: none;
        }
        input:focus, select:focus, textarea:focus {
          border-color: ${C.green} !important;
          background: #FFF !important;
        }
        @keyframes fadeUp { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes pulse  { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
        .fade { animation: fadeUp .3s ease; }
        ::-webkit-scrollbar { width: 0; }
      `}</style>

      {/* ── Header ── */}
      <div style={{ background: C.card, padding: "20px 20px 16px", boxShadow: `0 1px 0 ${C.border}` }}>
        <div style={{ maxWidth: 640, margin: "0 auto" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: last ? 14 : 0 }}>
            <div>
              <div style={{ fontSize: 12, color: C.muted, fontWeight: 500, marginBottom: 2 }}>{greeting}</div>
              <div style={{ fontSize: 24, fontWeight: 800, color: C.text, letterSpacing: "-0.5px" }}>Gkoach</div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <div style={{ background: C.greenLight, borderRadius: 10, padding: "6px 10px", textAlign: "center" }}>
                <div style={{ fontSize: 9, color: C.greenDark, fontWeight: 600, marginBottom: 1 }}>10K Noordwijk</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: C.greenDark }}>{race1}d</div>
              </div>
              <div style={{ background: C.blueLight, borderRadius: 10, padding: "6px 10px", textAlign: "center" }}>
                <div style={{ fontSize: 9, color: "#1D4ED8", fontWeight: 600, marginBottom: 1 }}>Gym-race Utrecht</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: "#1D4ED8" }}>{race2}d</div>
              </div>
            </div>
          </div>

          {last && (
            <div style={{ display: "flex", gap: 8 }}>
              <StatPill label="HRV"     value={last.hrv}      unit="ms"   status={hrvStatus} />
              <StatPill label="Slaap"   value={last.sleep_h}  unit="u"    status={sleepStatus} />
              <StatPill label="Energie" value={last.energy}   unit="/10"  status={energyStatus} />
              <StatPill label="Stress"  value={last.stress}   unit="/10"  status={stressStatus} />
            </div>
          )}

          {!sheetMode && (
            <div style={{ marginTop: 12, background: C.amberLight, border: `1px solid ${C.amber}44`, borderRadius: 10, padding: "8px 12px", fontSize: 12, color: "#92400E" }}>
              Lokale modus — configureer Google Sheets via Instellingen.
            </div>
          )}
        </div>
      </div>

      {/* ── Content ── */}
      <div style={{ maxWidth: 640, margin: "0 auto", padding: "16px 16px 90px" }}>

        {/* COACH */}
        {tab === "coach" && (
          <div className="fade" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ background: C.card, borderRadius: 18, padding: 20, boxShadow: C.shadow }}>
              <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Wat wil je weten?</div>
              <div style={{ fontSize: 13, color: C.muted, marginBottom: 12 }}>Of druk direct op coach voor een dagelijkse analyse.</div>
              <textarea rows={2} style={{ resize: "none", fontSize: 14 }}
                placeholder="bijv. 'ik voel me moe' · 'welke workout vandaag?' · 'weekoverzicht'"
                value={question} onChange={e => setQuestion(e.target.value)} />
              <button onClick={runCoach} disabled={coachLoad} style={{
                width: "100%", marginTop: 12,
                background: coachLoad ? C.border : C.green,
                color: coachLoad ? C.muted : "#FFF",
                border: "none", borderRadius: 12, padding: "14px 20px",
                fontSize: 15, fontWeight: 700, cursor: coachLoad ? "not-allowed" : "pointer", transition: "all .2s",
                fontFamily: "inherit"
              }}>
                {coachLoad ? "Analyseren..." : "Coach mij nu"}
              </button>
            </div>

            {coachLoad && (
              <div style={{ textAlign: "center", padding: "32px 20px", color: C.muted }}>
                <div style={{ fontSize: 40, marginBottom: 12, animation: "pulse 1.5s infinite" }}>🧠</div>
                <div style={{ fontSize: 14, fontWeight: 500 }}>Jouw data wordt geanalyseerd...</div>
                <div style={{ fontSize: 12, color: C.light, marginTop: 4 }}>Even geduld</div>
              </div>
            )}

            {coaching && !coachLoad && <div className="fade"><CoachOutput text={coaching} /></div>}

            {!coaching && !coachLoad && (
              <div style={{ textAlign: "center", padding: "40px 20px" }}>
                <div style={{ width: 64, height: 64, borderRadius: "50%", background: C.greenLight, margin: "0 auto 14px", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28 }}>✦</div>
                <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>Klaar voor je dagelijkse analyse</div>
                <div style={{ fontSize: 13, color: C.muted }}>Druk op "Coach mij nu" voor persoonlijk advies op basis van jouw data.</div>
              </div>
            )}
          </div>
        )}

        {/* CHECK-IN */}
        {tab === "checkin" && (
          <div className="fade" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Section title="" color={C.text}>
              <Field label="Datum">
                <input type="date" value={entry.date} onChange={e => set("date", e.target.value)} />
              </Field>
            </Section>

            <Section title="Lichaam" color={C.green}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <Field label="Gewicht (kg)"><input type="number" step="0.1" placeholder="79.5" value={entry.weight} onChange={e => set("weight", e.target.value)} /></Field>
                <Field label="Alcohol (eenheden)"><input type="number" step="0.5" placeholder="0" value={entry.alcohol} onChange={e => set("alcohol", e.target.value)} /></Field>
                <Field label="Bloeddruk sys"><input type="number" placeholder="120" value={entry.bp_sys} onChange={e => set("bp_sys", e.target.value)} /></Field>
                <Field label="Bloeddruk dia"><input type="number" placeholder="80" value={entry.bp_dia} onChange={e => set("bp_dia", e.target.value)} /></Field>
              </div>
            </Section>

            <Section title="Slaap" color={C.purple}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <Field label="Duur (uur)"><input type="number" step="0.25" placeholder="7.5" value={entry.sleep_h} onChange={e => set("sleep_h", e.target.value)} /></Field>
                <Field label="Kwaliteit (1–10)"><input type="number" placeholder="7" value={entry.sleep_q} onChange={e => set("sleep_q", e.target.value)} /></Field>
                <Field label="Diepe slaap (uur)"><input type="number" step="0.25" placeholder="1.5" value={entry.sleep_deep} onChange={e => set("sleep_deep", e.target.value)} /></Field>
                <Field label="REM (uur)"><input type="number" step="0.25" placeholder="1.5" value={entry.sleep_rem} onChange={e => set("sleep_rem", e.target.value)} /></Field>
              </div>
            </Section>

            <Section title="Vitals & herstel" color={C.blue}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <Field label="HRV (ms)"><input type="number" placeholder="45" value={entry.hrv} onChange={e => set("hrv", e.target.value)} /></Field>
                <Field label="Rusthartslag (bpm)"><input type="number" placeholder="58" value={entry.rhr} onChange={e => set("rhr", e.target.value)} /></Field>
                <Field label="Body battery (%)"><input type="number" placeholder="75" value={entry.body_battery} onChange={e => set("body_battery", e.target.value)} /></Field>
                <Field label="Stappen"><input type="number" placeholder="8000" value={entry.steps} onChange={e => set("steps", e.target.value)} /></Field>
                <Field label="Energie (1–10)"><input type="number" placeholder="7" value={entry.energy} onChange={e => set("energy", e.target.value)} /></Field>
                <Field label="Stress (1–10)"><input type="number" placeholder="4" value={entry.stress} onChange={e => set("stress", e.target.value)} /></Field>
              </div>
            </Section>

            <Section title="Training" color={C.amber}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: entry.trained ? 14 : 0 }}>
                <span style={{ fontSize: 14, flex: 1 }}>Getraind vandaag</span>
                <Toggle checked={!!entry.trained} onChange={v => set("trained", v)} />
              </div>
              {entry.trained && (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
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
            </Section>

            <Section title="Mentaal & welzijn" color={C.purple}>
              {[
                { k: "mental_unrest", l: "Mentale onrust aanwezig" },
                { k: "breathing",     l: "Ademhaling / meditatie gedaan" },
              ].map(f => (
                <div key={f.k} style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
                  <span style={{ fontSize: 14, flex: 1 }}>{f.l}</span>
                  <Toggle checked={!!entry[f.k]} onChange={v => set(f.k, v)} />
                </div>
              ))}
              {entry.breathing && (
                <div style={{ marginBottom: 12 }}>
                  <Field label="Type oefening">
                    <input placeholder="box breathing, 4-7-8, bodyscan..." value={entry.breathing_type} onChange={e => set("breathing_type", e.target.value)} />
                  </Field>
                </div>
              )}
              <Field label="Opmerkingen">
                <textarea rows={2} style={{ resize: "none" }} placeholder="Hoe voel je je? Bijzonderheden..."
                  value={entry.notes} onChange={e => set("notes", e.target.value)} />
              </Field>
            </Section>

            <button onClick={saveEntry} disabled={syncing} style={{
              width: "100%",
              background: saveMsg === "Opgeslagen!" ? C.green : saveMsg ? C.red : C.green,
              color: "#FFF", border: "none", borderRadius: 14, padding: "16px 20px",
              fontSize: 16, fontWeight: 700, cursor: syncing ? "not-allowed" : "pointer",
              opacity: syncing ? 0.7 : 1, transition: "all .2s", fontFamily: "inherit"
            }}>
              {syncing ? "Opslaan..." : saveMsg || "Opslaan"}
            </button>
          </div>
        )}

        {/* TRENDS */}
        {tab === "trends" && (
          <div className="fade" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {entries.length < 3 ? (
              <div style={{ textAlign: "center", padding: "48px 20px" }}>
                <div style={{ width: 64, height: 64, background: C.blueLight, borderRadius: "50%", margin: "0 auto 14px", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28 }}>↗</div>
                <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>Voortgang in aantocht</div>
                <div style={{ fontSize: 13, color: C.muted }}>Vul minimaal 3 dagen in om trends te zien.</div>
              </div>
            ) : (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  {[
                    { l: "Gem. HRV",   f: "hrv",     u: "ms",   c: C.green  },
                    { l: "Gem. slaap", f: "sleep_h",  u: "u",    c: C.purple },
                    { l: "Gem. RHR",   f: "rhr",      u: "bpm",  c: C.blue   },
                    { l: "Gem. stress",f: "stress",   u: "/10",  c: C.amber  },
                  ].map(m => {
                    const v = avg(numArr(entries, m.f));
                    return (
                      <div key={m.l} style={{ background: C.card, borderRadius: 14, padding: 14, boxShadow: C.shadow }}>
                        <div style={{ fontSize: 12, color: C.muted, fontWeight: 500, marginBottom: 4 }}>{m.l}</div>
                        <div style={{ fontSize: 24, fontWeight: 800, color: m.c }}>{v}<span style={{ fontSize: 12, fontWeight: 500, color: C.muted }}> {m.u}</span></div>
                      </div>
                    );
                  })}
                </div>

                {[
                  { label: "HRV (ms)",              field: "hrv",          color: C.green,  good: "up"   },
                  { label: "Rusthartslag (bpm)",     field: "rhr",          color: C.blue,   good: "down" },
                  { label: "Slaapduur (uur)",        field: "sleep_h",      color: C.purple, good: "up"   },
                  { label: "Slaapkwaliteit (1–10)",  field: "sleep_q",      color: C.purple, good: "up"   },
                  { label: "Ochtendenergie (1–10)",  field: "energy",       color: C.amber,  good: "up"   },
                  { label: "Stressniveau (1–10)",    field: "stress",       color: C.red,    good: "down" },
                  { label: "Body battery (%)",       field: "body_battery", color: C.green,  good: "up"   },
                  { label: "Stappen",                field: "steps",        color: C.blue,   good: "up"   },
                  { label: "Gewicht (kg)",           field: "weight",       color: C.muted,  good: "down" },
                  { label: "Bloeddruk sys",          field: "bp_sys",       color: C.red,    good: "down" },
                ].map(cfg => <TrendCard key={cfg.field} entries={entries} unit="" {...cfg} />)}

                <div style={{ background: C.card, borderRadius: 16, padding: 16, boxShadow: C.shadow }}>
                  <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Trainingsdagen</div>
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                    {entries.slice(-28).map(e => (
                      <div key={e.date} title={`${fmt(e.date)}: ${e.train_type || "rust"}`}
                        style={{ width: 22, height: 22, borderRadius: 5, background: e.trained ? C.green : "#F3F4F6" }} />
                    ))}
                  </div>
                  <div style={{ marginTop: 8, fontSize: 11, color: C.light }}>Laatste 28 dagen · groen = training</div>
                </div>
              </>
            )}
          </div>
        )}

        {/* LOGBOEK */}
        {tab === "data" && (
          <div className="fade" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
              <div style={{ fontSize: 13, color: C.muted }}>{entries.length} dag{entries.length !== 1 ? "en" : ""} · {sheetMode ? "Google Sheets" : "lokaal"}</div>
              <button onClick={loadData} style={{ background: C.card, border: `1px solid ${C.border}`, color: C.text, borderRadius: 10, padding: "6px 14px", fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>
                Vernieuwen
              </button>
            </div>
            {entries.length === 0 ? (
              <div style={{ textAlign: "center", padding: "40px 20px" }}>
                <div style={{ fontSize: 13, color: C.muted }}>Nog geen data. Vul je eerste check-in in.</div>
              </div>
            ) : (
              [...entries].reverse().map(e => (
                <div key={e.date} style={{ background: C.card, borderRadius: 14, padding: 14, boxShadow: C.shadow }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                    <span style={{ fontWeight: 700, fontSize: 14 }}>{fmt(e.date)}</span>
                    <div style={{ display: "flex", gap: 6 }}>
                      {e.trained && <span style={{ background: C.greenLight, color: C.greenDark, fontSize: 11, padding: "2px 8px", borderRadius: 20, fontWeight: 600 }}>{e.train_type || "training"}</span>}
                      {+e.alcohol > 0 && <span style={{ background: C.redLight, color: "#DC2626", fontSize: 11, padding: "2px 8px", borderRadius: 20, fontWeight: 600 }}>alcohol {e.alcohol}</span>}
                    </div>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 6 }}>
                    {[["HRV", e.hrv, "ms"], ["RHR", e.rhr, "bpm"], ["Slaap", e.sleep_h, "u"], ["Energie", e.energy, "/10"],
                      ["Stress", e.stress, "/10"], ["Batt.", e.body_battery, "%"],
                      ["BP", e.bp_sys && e.bp_dia ? `${e.bp_sys}/${e.bp_dia}` : "", ""], ["kg", e.weight, ""]
                    ].filter(([, v]) => v).map(([l, v, u]) => (
                      <div key={l} style={{ fontSize: 12 }}>
                        <div style={{ color: C.light, fontSize: 10 }}>{l}</div>
                        <div style={{ fontWeight: 600 }}>{v}{u ? ` ${u}` : ""}</div>
                      </div>
                    ))}
                  </div>
                  {e.notes && <div style={{ marginTop: 8, fontSize: 12, color: C.muted, fontStyle: "italic" }}>"{e.notes}"</div>}
                </div>
              ))
            )}
          </div>
        )}

        {/* INSTELLINGEN */}
        {tab === "setup" && (
          <div className="fade" style={{ display: "flex", flexDirection: "column", gap: 12 }}>

            <Section title="Verbindingsstatus" color={C.text}>
              {[
                { label: "Google Sheets", ok: !!SHEET_ID,   detail: SHEET_ID   ? `Sheet ...${SHEET_ID.slice(-6)}` : "Niet ingesteld — voeg VITE_GOOGLE_SHEET_ID toe in Vercel" },
                { label: "Claude AI",     ok: !!CLAUDE_KEY, detail: CLAUDE_KEY ? "API key aanwezig"               : "Niet ingesteld — voeg VITE_CLAUDE_API_KEY toe in Vercel" },
                { label: "Garmin sync",   ok: false,        detail: "Draait elke ochtend 06:30 via GitHub Actions" },
              ].map(s => (
                <div key={s.label} style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10, padding: "10px 12px", background: s.ok ? C.greenLight : "#F9FAFB", borderRadius: 10 }}>
                  <div style={{ width: 10, height: 10, borderRadius: "50%", background: s.ok ? C.green : C.light, flexShrink: 0 }} />
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>{s.label}</div>
                    <div style={{ fontSize: 12, color: C.muted }}>{s.detail}</div>
                  </div>
                </div>
              ))}
            </Section>

            <Section title="Vercel — environment variabelen" color={C.blue}>
              <div style={{ fontSize: 12, color: C.muted, marginBottom: 12 }}>Stel in via Vercel → Settings → Environment Variables, dan herdeployen.</div>
              {[
                { key: "VITE_CLAUDE_API_KEY",                 note: "Haal op via console.anthropic.com" },
                { key: "VITE_GOOGLE_SHEET_ID",                note: "Het ID in de URL van je Google Sheet" },
                { key: "VITE_GOOGLE_SERVICE_ACCOUNT_EMAIL",   note: '"client_email" uit service_account.json' },
                { key: "VITE_GOOGLE_PRIVATE_KEY",             note: '"private_key" uit service_account.json' },
              ].map(v => (
                <div key={v.key} style={{ marginBottom: 8, padding: "10px 12px", background: "#F9FAFB", borderRadius: 10 }}>
                  <div style={{ fontSize: 12, fontFamily: "monospace", fontWeight: 600, marginBottom: 2 }}>{v.key}</div>
                  <div style={{ fontSize: 11, color: C.muted }}>{v.note}</div>
                </div>
              ))}
            </Section>

            <Section title="GitHub Secrets — Garmin sync" color={C.amber}>
              <div style={{ fontSize: 12, color: C.muted, marginBottom: 12 }}>Stel in via GitHub → Settings → Secrets and variables → Actions.</div>
              {[
                { key: "GARMIN_EMAIL",                        note: "Je Garmin Connect e-mailadres" },
                { key: "GARMIN_PASSWORD",                     note: "Je Garmin wachtwoord" },
                { key: "GOOGLE_SHEET_ID",                     note: "Zelfde Sheet ID als hierboven" },
                { key: "GOOGLE_SERVICE_ACCOUNT_JSON_CONTENT", note: "Volledige inhoud van service_account.json" },
              ].map(v => (
                <div key={v.key} style={{ marginBottom: 8, padding: "10px 12px", background: "#F9FAFB", borderRadius: 10 }}>
                  <div style={{ fontSize: 12, fontFamily: "monospace", fontWeight: 600, marginBottom: 2 }}>{v.key}</div>
                  <div style={{ fontSize: 11, color: C.muted }}>{v.note}</div>
                </div>
              ))}
            </Section>

            <Section title="Installeren als app" color={C.purple}>
              <div style={{ fontSize: 13, lineHeight: 1.8 }}>
                <strong>iPhone (Safari):</strong> Deel-knop → "Zet op beginscherm"<br /><br />
                <strong>Android (Chrome):</strong> Menu → "Toevoegen aan startscherm"
              </div>
            </Section>
          </div>
        )}
      </div>

      {/* ── Bottom navigation ── */}
      <div style={{
        position: "fixed", bottom: 0, left: 0, right: 0,
        background: C.card, borderTop: `1px solid ${C.border}`,
        padding: "8px 0 max(8px, env(safe-area-inset-bottom))",
        display: "flex", justifyContent: "space-around", alignItems: "center"
      }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            display: "flex", flexDirection: "column", alignItems: "center", gap: 3,
            background: "none", border: "none", cursor: "pointer", padding: "4px 10px",
            color: tab === t.id ? C.green : C.muted, fontFamily: "inherit"
          }}>
            <span style={{ fontSize: 18, lineHeight: 1 }}>{t.icon}</span>
            <span style={{ fontSize: 10, fontWeight: tab === t.id ? 700 : 500 }}>{t.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
