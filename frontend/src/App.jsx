import { useState, useEffect, useCallback } from "react";

// ── Google Sheets API helpers ─────────────────────────────────────────────────
const SHEET_ID  = import.meta.env.VITE_GOOGLE_SHEET_ID;
const SA_EMAIL  = import.meta.env.VITE_GOOGLE_SERVICE_ACCOUNT_EMAIL;
const SA_KEY    = import.meta.env.VITE_GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");
const TAB       = "coach_data";
const RANGE     = `${TAB}!A:W`;

async function getJWT() {
  const header  = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const now     = Math.floor(Date.now() / 1000);
  const payload = btoa(JSON.stringify({
    iss: SA_EMAIL, scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token", exp: now + 3600, iat: now
  }));
  const unsigned = `${header}.${payload}`;
  const keyData  = SA_KEY.replace(/-----BEGIN RSA PRIVATE KEY-----|-----END RSA PRIVATE KEY-----|\n/g, "");
  const binaryKey = Uint8Array.from(atob(keyData), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8", binaryKey.buffer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey,
    new TextEncoder().encode(unsigned));
  const b64sig = btoa(String.fromCharCode(...new Uint8Array(sig)));
  const jwt = `${unsigned}.${b64sig}`;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
  });
  const d = await res.json();
  return d.access_token;
}

async function sheetsGet() {
  const token = await getJWT();
  const url   = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(RANGE)}`;
  const res   = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  return res.json();
}

async function sheetsAppend(row) {
  const token = await getJWT();
  const url   = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(RANGE)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  await fetch(url, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values: [row] })
  });
}

async function sheetsUpdate(rowIdx, row) {
  const token = await getJWT();
  const range = `${TAB}!A${rowIdx}:W${rowIdx}`;
  const url   = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;
  await fetch(url, {
    method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values: [row] })
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const HEADERS = [
  "date","weight","alcohol","bp_sys","bp_dia",
  "sleep_h","sleep_q","sleep_deep","sleep_rem",
  "hrv","rhr","stress","body_battery","steps",
  "trained","train_type","train_min","train_dist",
  "energy","mental_unrest","breathing","breathing_type","notes"
];

const today    = () => new Date().toISOString().slice(0, 10);
const fmt      = (d) => new Date(d + "T12:00:00").toLocaleDateString("nl-NL", { day: "numeric", month: "short" });
const numArr   = (entries, f) => entries.map(e => parseFloat(e[f])).filter(v => !isNaN(v) && v > 0);
const avg      = (arr) => arr.length ? (arr.reduce((a,b)=>a+b,0)/arr.length).toFixed(1) : "—";
const daysUntil= (d) => Math.ceil((new Date(d) - new Date()) / 86400000);

const EMPTY = HEADERS.reduce((o,h) => ({ ...o, [h]: "" }), { trained: false, mental_unrest: false, breathing: false });

// ── Claude coaching ───────────────────────────────────────────────────────────
async function fetchCoaching(entries, question) {
  const recent = entries.slice(-7);
  const prompt = `Je bent een data-gedreven personal health & performance coach. Analyseer en geef concrete coaching.

DATA (laatste 7 dagen): ${JSON.stringify(recent, null, 2)}

CONTEXT/VRAAG: ${question || "Geef mijn dagelijkse check-in analyse."}

DOELEN: hogere HRV, optimale slaap, energiek wakker, betere gezondheid, innerlijke rust.
WEDSTRIJDEN: 10km 5 juli 2026 Noordwijk · Gym-race 4 oktober 2026 Utrecht.

Antwoord in EXACT deze structuur:
### Korte analyse
### 3 Belangrijkste inzichten
### Actie voor vandaag
### Workoutadvies
### Ademhaling of meditatie
### Grootste aandachtspunt

Nuchter, concreet, eerlijk. Geen clichés. Max 350 woorden.`;

  const res  = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514", max_tokens: 1000,
      messages: [{ role: "user", content: prompt }]
    })
  });
  const d = await res.json();
  return d.content?.find(b => b.type === "text")?.text || "Geen analyse beschikbaar.";
}

// ── Sub-components ────────────────────────────────────────────────────────────
const MetricBadge = ({ label, value, unit, color }) => {
  const c = { lime: "#C8F04D", blue: "#7DD3FC", red: "#FCA5A5", muted: "#4B5563" };
  return (
    <div style={{ background: "#1A1F2E", border: "1px solid #2A3040", borderRadius: 10, padding: "8px 14px", minWidth: 72, flex: "0 0 auto" }}>
      <div style={{ fontSize: 9, color: "#6B7280", textTransform: "uppercase", letterSpacing: "0.12em" }}>{label}</div>
      <div style={{ fontSize: 19, fontWeight: 700, color: c[color] || c.blue, lineHeight: 1.2 }}>
        {value || "—"}{value ? <span style={{ fontSize: 10, opacity: 0.6 }}> {unit}</span> : ""}
      </div>
    </div>
  );
};

const Sparkline = ({ data, color = "#C8F04D", height = 48 }) => {
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
      <polyline fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" points={pts} />
      {data.map((v, i) => {
        const x = p + (i / (data.length - 1)) * (W - p * 2);
        const y = H - p - ((v - min) / range) * (H - p * 2);
        return <circle key={i} cx={x} cy={y} r="2.5" fill={color} />;
      })}
    </svg>
  );
};

const TrendCard = ({ label, entries, field, unit, color, good = "up" }) => {
  const vals = numArr(entries, field);
  if (!vals.length) return null;
  const last  = vals[vals.length - 1];
  const prev  = vals.slice(-4, -1);
  const prevA = prev.length ? prev.reduce((a,b)=>a+b,0)/prev.length : last;
  const dir   = last > prevA + 0.5 ? "up" : last < prevA - 0.5 ? "down" : "flat";
  const good_ = good === "up" ? "up" : "down";
  const col   = dir === "flat" ? "#6B7280" : dir === good_ ? "#C8F04D" : "#FCA5A5";
  const arrow = dir === "up" ? "↑" : dir === "down" ? "↓" : "→";
  return (
    <div style={{ background: "#1A1F2E", border: "1px solid #2A3040", borderRadius: 12, padding: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <span style={{ fontSize: 11, color: "#6B7280", textTransform: "uppercase", letterSpacing: "0.1em" }}>{label}</span>
        <span style={{ fontSize: 16, fontWeight: 700, color: col }}>{arrow} {last}{unit}</span>
      </div>
      <Sparkline data={vals} color={color} />
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#4B5563", marginTop: 4 }}>
        <span>{fmt(entries.filter(e => e[field]).at(0)?.date)}</span>
        <span>gem {avg(vals)}{unit}</span>
        <span>{fmt(entries.filter(e => e[field]).at(-1)?.date)}</span>
      </div>
    </div>
  );
};

const CoachOutput = ({ text }) => {
  const sections = text.split(/###\s+/).filter(Boolean);
  const icons = { "Korte analyse":"📊","3 Belangrijkste inzichten":"💡","Actie voor vandaag":"⚡","Workoutadvies":"🏋️","Ademhaling of meditatie":"🫁","Grootste aandachtspunt":"🎯" };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {sections.map((s, i) => {
        const [title, ...rest] = s.trim().split("\n");
        return (
          <div key={i} style={{ background: "#1A1F2E", border: "1px solid #2A3040", borderRadius: 12, padding: 14 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
              <span>{icons[title.trim()] || "•"}</span>
              <span style={{ color: "#C8F04D", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em" }}>{title.trim()}</span>
            </div>
            <div style={{ color: "#CBD5E1", fontSize: 13, lineHeight: 1.7, whiteSpace: "pre-wrap" }}>{rest.join("\n").trim()}</div>
          </div>
        );
      })}
    </div>
  );
};

const Toggle = ({ checked, onChange }) => (
  <label style={{ position: "relative", display: "inline-block", width: 44, height: 24, flexShrink: 0 }}>
    <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} style={{ opacity: 0, width: 0, height: 0 }} />
    <span style={{
      position: "absolute", inset: 0, borderRadius: 24, cursor: "pointer", transition: "0.3s",
      background: checked ? "#C8F04D" : "#2A3040"
    }}>
      <span style={{
        position: "absolute", height: 18, width: 18, left: 3, bottom: 3, borderRadius: "50%",
        background: checked ? "#0D1117" : "#6B7280", transition: "0.3s",
        transform: checked ? "translateX(20px)" : "none"
      }} />
    </span>
  </label>
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
  const [sheetMode, setSheetMode] = useState(!!SHEET_ID); // false = local storage mode

  // ── Load data ──────────────────────────────────────────────────────────────
  const loadData = useCallback(async () => {
    if (!sheetMode) {
      try {
        const raw = JSON.parse(localStorage.getItem("coach_v2") || "{}");
        setEntries(Object.values(raw).sort((a,b) => a.date.localeCompare(b.date)));
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
      }).sort((a,b) => a.date.localeCompare(b.date));
      setEntries(data);
    } catch (e) {
      console.error("Sheets load error:", e);
      setSheetMode(false); // fallback naar localStorage
    }
    setLoading(false);
  }, [sheetMode]);

  useEffect(() => { loadData(); }, [loadData]);

  // Pre-fill entry van bestaande dag
  useEffect(() => {
    const existing = entries.find(e => e.date === entry.date);
    if (existing) setEntry({ ...EMPTY, ...existing });
    else setEntry({ ...EMPTY, date: entry.date });
  }, [entry.date, entries]);

  // ── Save entry ─────────────────────────────────────────────────────────────
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
      setSaveMsg("✓ Opgeslagen");
    } catch (e) {
      setSaveMsg("✗ Fout bij opslaan");
    }
    setSyncing(false);
    setTimeout(() => setSaveMsg(""), 2500);
  };

  // ── Coaching ───────────────────────────────────────────────────────────────
  const runCoach = async () => {
    setCoachLoad(true); setCoaching("");
    try {
      const result = await fetchCoaching(entries.length ? entries : [entry], question);
      setCoaching(result);
    } catch { setCoaching("Fout bij ophalen coaching."); }
    setCoachLoad(false);
  };

  const set = (k, v) => setEntry(p => ({ ...p, [k]: v }));
  const last = entries[entries.length - 1];
  const race1 = daysUntil("2026-07-05");
  const race2 = daysUntil("2026-10-04");

  const TABS = ["coach","checkin","trends","data","setup"];
  const TLABELS = { coach:"Coach", checkin:"Check-in", trends:"Trends", data:"Data", setup:"Setup" };

  if (loading) return (
    <div style={{ background:"#0D1117", minHeight:"100vh", display:"flex", alignItems:"center", justifyContent:"center", color:"#6B7280", fontFamily:"monospace" }}>
      <div style={{ textAlign:"center" }}>
        <div style={{ fontSize:32, marginBottom:12, animation:"pulse 1.5s infinite" }}>⚡</div>
        <div>Data laden...</div>
      </div>
    </div>
  );

  return (
    <div style={{ fontFamily:"'DM Mono','Courier New',monospace", background:"#0D1117", minHeight:"100vh", color:"#E2E8F0" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Space+Grotesk:wght@700;900&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:3px}::-webkit-scrollbar-thumb{background:#2A3040;border-radius:2px}
        input,select,textarea{background:#1A1F2E!important;border:1px solid #2A3040!important;color:#E2E8F0!important;border-radius:8px;padding:8px 12px;font-family:inherit;font-size:13px;width:100%;outline:none;transition:border-color .2s}
        input:focus,select:focus,textarea:focus{border-color:#C8F04D!important}
        label{font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:#6B7280;display:block;margin-bottom:4px}
        .btn{border:none;border-radius:10px;padding:11px 20px;font-family:inherit;font-weight:700;font-size:12px;cursor:pointer;transition:all .2s;letter-spacing:.05em;text-transform:uppercase}
        .btn-lime{background:#C8F04D;color:#0D1117}.btn-lime:hover{background:#D4F76A;transform:translateY(-1px)}.btn-lime:disabled{opacity:.4;cursor:not-allowed;transform:none}
        .btn-ghost{background:#1A1F2E;color:#CBD5E1;border:1px solid #2A3040!important}.btn-ghost:hover{border-color:#C8F04D!important;color:#C8F04D}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
        @keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
        .fade{animation:fadeUp .35s ease}
      `}</style>

      {/* Header */}
      <div style={{ background:"linear-gradient(180deg,#111827 0%,#0D1117 100%)", borderBottom:"1px solid #1E2533", padding:"14px 20px" }}>
        <div style={{ maxWidth:680, margin:"0 auto" }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
            <div>
              <div style={{ fontSize:10, color:"#C8F04D", letterSpacing:"0.2em", textTransform:"uppercase", marginBottom:2 }}>Performance Coach</div>
              <div style={{ fontFamily:"'Space Grotesk',sans-serif", fontWeight:900, fontSize:20, letterSpacing:"-0.02em" }}>DASHBOARD</div>
            </div>
            <div style={{ display:"flex", gap:6, fontSize:11 }}>
              <div style={{ background:"#1A1F2E", border:"1px solid #2A3040", borderRadius:8, padding:"5px 10px", textAlign:"center" }}>
                <div style={{ color:"#6B7280", fontSize:9 }}>10K · Noordwijk</div>
                <div style={{ color:"#C8F04D", fontWeight:700 }}>{race1}d</div>
              </div>
              <div style={{ background:"#1A1F2E", border:"1px solid #2A3040", borderRadius:8, padding:"5px 10px", textAlign:"center" }}>
                <div style={{ color:"#6B7280", fontSize:9 }}>Gym-race · Utrecht</div>
                <div style={{ color:"#7DD3FC", fontWeight:700 }}>{race2}d</div>
              </div>
            </div>
          </div>
          {last && (
            <div style={{ display:"flex", gap:8, marginTop:10, overflowX:"auto", paddingBottom:4 }}>
              {[
                { l:"HRV",   v:last.hrv,          u:"ms",  c: +last.hrv > 50?"lime": +last.hrv > 35?"blue":"red" },
                { l:"RHR",   v:last.rhr,          u:"bpm", c:"blue" },
                { l:"Slaap", v:last.sleep_h,      u:"u",   c: +last.sleep_h >= 7?"lime":"red" },
                { l:"Stress",v:last.stress,        u:"/10", c: +last.stress <= 4?"lime": +last.stress <= 7?"blue":"red" },
                { l:"Batt.", v:last.body_battery,  u:"%",   c: +last.body_battery > 60?"lime":"muted" },
              ].map(m => <MetricBadge key={m.l} {...m} />)}
            </div>
          )}
          {!sheetMode && (
            <div style={{ marginTop:8, background:"#2A1F0A", border:"1px solid #92400E", borderRadius:8, padding:"6px 12px", fontSize:11, color:"#FCD34D" }}>
              ⚠ Lokale modus — Google Sheets niet geconfigureerd. Ga naar Setup.
            </div>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div style={{ background:"#0D1117", borderBottom:"1px solid #1E2533", padding:"8px 20px" }}>
        <div style={{ maxWidth:680, margin:"0 auto", display:"flex", gap:4, overflowX:"auto" }}>
          {TABS.map(t => (
            <button key={t} onClick={() => setTab(t)} className="btn"
              style={{ background: tab===t?"#C8F04D":"transparent", color: tab===t?"#0D1117":"#6B7280",
                       fontSize:11, padding:"7px 14px", borderRadius:8, border: tab===t?"none":"1px solid transparent" }}>
              {TLABELS[t]}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div style={{ maxWidth:680, margin:"0 auto", padding:"18px 20px 100px" }}>

        {/* ── COACH ── */}
        {tab === "coach" && (
          <div className="fade" style={{ display:"flex", flexDirection:"column", gap:14 }}>
            <div style={{ background:"#1A1F2E", border:"1px solid #2A3040", borderRadius:12, padding:14 }}>
              <label>Vraag of context (optioneel)</label>
              <textarea rows={2} style={{ resize:"none" }} placeholder="bijv. 'ik voel me moe' · 'geef wekelijkse check-in' · 'welke workout vandaag?'"
                value={question} onChange={e => setQuestion(e.target.value)} />
              <button className="btn btn-lime" onClick={runCoach} disabled={coachLoad} style={{ width:"100%", marginTop:10 }}>
                {coachLoad ? <span style={{ animation:"pulse 1s infinite", display:"inline-block" }}>Analyseren...</span> : "⚡ Coach mij nu"}
              </button>
            </div>
            {coachLoad && (
              <div style={{ textAlign:"center", padding:32, color:"#6B7280" }}>
                <div style={{ fontSize:28, animation:"pulse 1.2s infinite", marginBottom:8 }}>🧠</div>
                <div style={{ fontSize:12 }}>Data wordt geanalyseerd...</div>
              </div>
            )}
            {coaching && !coachLoad && <div className="fade"><CoachOutput text={coaching} /></div>}
            {!coaching && !coachLoad && (
              <div style={{ textAlign:"center", padding:48, color:"#2A3040" }}>
                <div style={{ fontSize:36, marginBottom:8 }}>📊</div>
                <div style={{ fontSize:13 }}>Druk op Coach mij nu voor je dagelijkse analyse</div>
              </div>
            )}
          </div>
        )}

        {/* ── CHECK-IN ── */}
        {tab === "checkin" && (
          <div className="fade" style={{ display:"flex", flexDirection:"column", gap:12 }}>
            <div style={{ background:"#1A1F2E", border:"1px solid #2A3040", borderRadius:12, padding:14 }}>
              <label>Datum</label>
              <input type="date" value={entry.date} onChange={e => set("date", e.target.value)} />
            </div>

            {[
              { title:"Lichaam", color:"#C8F04D", fields:[
                { k:"weight",  l:"Gewicht (kg)",    t:"number", step:"0.1", ph:"79.5" },
                { k:"alcohol", l:"Alcohol (eenhed)",t:"number", step:"0.5", ph:"0" },
                { k:"bp_sys",  l:"Bloeddruk SYS",   t:"number", ph:"120" },
                { k:"bp_dia",  l:"Bloeddruk DIA",   t:"number", ph:"80" },
              ]},
              { title:"Slaap", color:"#A78BFA", fields:[
                { k:"sleep_h",    l:"Slaapduur (uur)",      t:"number", step:"0.25", ph:"7.5" },
                { k:"sleep_q",    l:"Slaapkwaliteit (1–10)",t:"number", ph:"7" },
                { k:"sleep_deep", l:"Diepe slaap (uur)",    t:"number", step:"0.25", ph:"1.5" },
                { k:"sleep_rem",  l:"REM slaap (uur)",      t:"number", step:"0.25", ph:"1.5" },
              ]},
              { title:"Vitals & Herstel", color:"#7DD3FC", fields:[
                { k:"hrv",          l:"HRV (ms)",           t:"number", ph:"45" },
                { k:"rhr",          l:"Rusthartslag (bpm)", t:"number", ph:"58" },
                { k:"body_battery", l:"Body Battery (%)",   t:"number", ph:"75" },
                { k:"steps",        l:"Stappen",            t:"number", ph:"8000" },
                { k:"energy",       l:"Ochtendenergie (1–10)", t:"number", ph:"7" },
                { k:"stress",       l:"Stressniveau (1–10)",t:"number", ph:"4" },
              ]},
            ].map(section => (
              <div key={section.title} style={{ background:"#1A1F2E", border:"1px solid #2A3040", borderRadius:12, padding:14 }}>
                <div style={{ fontSize:11, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.1em", color:section.color, marginBottom:12 }}>{section.title}</div>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
                  {section.fields.map(f => (
                    <div key={f.k}>
                      <label>{f.l}</label>
                      <input type={f.t} step={f.step} placeholder={f.ph} value={entry[f.k]} onChange={e => set(f.k, e.target.value)} />
                    </div>
                  ))}
                </div>
              </div>
            ))}

            <div style={{ background:"#1A1F2E", border:"1px solid #2A3040", borderRadius:12, padding:14 }}>
              <div style={{ fontSize:11, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.1em", color:"#C8F04D", marginBottom:12 }}>Training</div>
              <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:12 }}>
                <label style={{ marginBottom:0, flex:1 }}>Getraind vandaag</label>
                <Toggle checked={!!entry.trained} onChange={v => set("trained", v)} />
              </div>
              {entry.trained && (
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
                  <div>
                    <label>Type</label>
                    <select value={entry.train_type} onChange={e => set("train_type", e.target.value)}>
                      <option value="">Kies</option>
                      {["hardlopen","PT","kracht thuis","core","mobiliteit","herstel","cardio","anders"].map(o => <option key={o}>{o}</option>)}
                    </select>
                  </div>
                  <div><label>Duur (min)</label><input type="number" placeholder="45" value={entry.train_min} onChange={e => set("train_min", e.target.value)} /></div>
                  <div><label>Afstand (km)</label><input type="number" step="0.1" placeholder="5.0" value={entry.train_dist} onChange={e => set("train_dist", e.target.value)} /></div>
                </div>
              )}
            </div>

            <div style={{ background:"#1A1F2E", border:"1px solid #2A3040", borderRadius:12, padding:14 }}>
              <div style={{ fontSize:11, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.1em", color:"#7DD3FC", marginBottom:12 }}>Mentaal</div>
              {[
                { k:"mental_unrest", l:"Mentale onrust" },
                { k:"breathing",     l:"Ademhaling / meditatie gedaan" },
              ].map(f => (
                <div key={f.k} style={{ display:"flex", alignItems:"center", gap:12, marginBottom:10 }}>
                  <label style={{ marginBottom:0, flex:1 }}>{f.l}</label>
                  <Toggle checked={!!entry[f.k]} onChange={v => set(f.k, v)} />
                </div>
              ))}
              {entry.breathing && (
                <div style={{ marginBottom:10 }}>
                  <label>Type oefening</label>
                  <input placeholder="box breathing, 4-7-8, bodyscan..." value={entry.breathing_type} onChange={e => set("breathing_type", e.target.value)} />
                </div>
              )}
              <label>Opmerkingen</label>
              <textarea rows={2} style={{ resize:"none" }} placeholder="Hoe voel je je? Bijzonderheden..."
                value={entry.notes} onChange={e => set("notes", e.target.value)} />
            </div>

            <button className="btn btn-lime" onClick={saveEntry} disabled={syncing} style={{ width:"100%" }}>
              {syncing ? "Opslaan..." : saveMsg || "Opslaan"}
            </button>
          </div>
        )}

        {/* ── TRENDS ── */}
        {tab === "trends" && (
          <div className="fade" style={{ display:"flex", flexDirection:"column", gap:12 }}>
            {entries.length < 3 ? (
              <div style={{ textAlign:"center", padding:48, color:"#6B7280" }}>
                <div style={{ fontSize:32, marginBottom:8 }}>📈</div>
                <div style={{ fontSize:13 }}>Voer minimaal 3 dagen in voor trends</div>
              </div>
            ) : (
              <>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
                  {[
                    { l:"Gem. HRV",    f:"hrv",     u:"ms", c:"lime" },
                    { l:"Gem. RHR",    f:"rhr",     u:"bpm", c:"blue" },
                    { l:"Gem. slaap",  f:"sleep_h", u:"u", c:+avg(numArr(entries,"sleep_h")) >= 7?"lime":"red" },
                    { l:"Gem. stress", f:"stress",  u:"/10", c:"muted" },
                  ].map(m => {
                    const vals = numArr(entries, m.f);
                    const cols = { lime:"#C8F04D", blue:"#7DD3FC", red:"#FCA5A5", muted:"#4B5563" };
                    return (
                      <div key={m.l} style={{ background:"#1A1F2E", border:"1px solid #2A3040", borderRadius:12, padding:14 }}>
                        <div style={{ fontSize:10, color:"#6B7280", textTransform:"uppercase", letterSpacing:"0.1em" }}>{m.l}</div>
                        <div style={{ fontSize:22, fontWeight:700, color:cols[m.c] }}>{avg(vals)}<span style={{ fontSize:12, opacity:.6 }}> {m.u}</span></div>
                      </div>
                    );
                  })}
                </div>
                {[
                  { label:"HRV (ms)",              field:"hrv",          color:"#C8F04D", good:"up" },
                  { label:"Rusthartslag (bpm)",     field:"rhr",          color:"#7DD3FC", good:"down" },
                  { label:"Slaapduur (uur)",        field:"sleep_h",      color:"#A78BFA", good:"up" },
                  { label:"Slaapkwaliteit (1–10)",  field:"sleep_q",      color:"#A78BFA", good:"up" },
                  { label:"Diepe slaap (uur)",      field:"sleep_deep",   color:"#818CF8", good:"up" },
                  { label:"Ochtendenergie (1–10)",  field:"energy",       color:"#C8F04D", good:"up" },
                  { label:"Stressniveau (1–10)",    field:"stress",       color:"#FCA5A5", good:"down" },
                  { label:"Body Battery (%)",       field:"body_battery", color:"#34D399", good:"up" },
                  { label:"Gewicht (kg)",           field:"weight",       color:"#7DD3FC", good:"down" },
                  { label:"Bloeddruk SYS",          field:"bp_sys",       color:"#FCA5A5", good:"down" },
                  { label:"Stappen",                field:"steps",        color:"#C8F04D", good:"up" },
                ].map(cfg => <TrendCard key={cfg.field} entries={entries} unit="" {...cfg} />)}

                <div style={{ background:"#1A1F2E", border:"1px solid #2A3040", borderRadius:12, padding:14 }}>
                  <div style={{ fontSize:11, color:"#6B7280", textTransform:"uppercase", letterSpacing:"0.1em", marginBottom:10 }}>Trainingsdagen</div>
                  <div style={{ display:"flex", gap:3, flexWrap:"wrap" }}>
                    {entries.slice(-28).map(e => (
                      <div key={e.date} title={`${fmt(e.date)}: ${e.train_type || "rust"}`}
                        style={{ width:20, height:20, borderRadius:4, background: e.trained?"#C8F04D":"#2A3040", opacity: e.trained?1:0.35, cursor:"default" }} />
                    ))}
                  </div>
                  <div style={{ marginTop:6, fontSize:10, color:"#4B5563" }}>Laatste 28 dagen · groen = training</div>
                </div>
              </>
            )}
          </div>
        )}

        {/* ── DATA ── */}
        {tab === "data" && (
          <div className="fade" style={{ display:"flex", flexDirection:"column", gap:12 }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <div style={{ fontSize:12, color:"#6B7280" }}>{entries.length} dag{entries.length!==1?"en":""} · {sheetMode?"Google Sheets":"lokaal"}</div>
              <div style={{ display:"flex", gap:8 }}>
                <button className="btn btn-ghost" style={{ fontSize:11, padding:"7px 12px" }} onClick={loadData}>↻ Sync</button>
              </div>
            </div>
            {entries.length === 0 ? (
              <div style={{ textAlign:"center", padding:48, color:"#6B7280" }}>
                <div style={{ fontSize:32, marginBottom:8 }}>📋</div>
                <div style={{ fontSize:13 }}>Nog geen data. Vul je eerste Check-in in.</div>
              </div>
            ) : (
              [...entries].reverse().map(e => (
                <div key={e.date} style={{ background:"#1A1F2E", border:"1px solid #2A3040", borderRadius:12, padding:14 }}>
                  <div style={{ display:"flex", justifyContent:"space-between", marginBottom:8 }}>
                    <span style={{ fontWeight:700, color:"#C8F04D" }}>{fmt(e.date)}</span>
                    <div style={{ display:"flex", gap:6 }}>
                      {e.trained && <span style={{ background:"#C8F04D22", color:"#C8F04D", fontSize:10, padding:"2px 8px", borderRadius:20 }}>{e.train_type||"training"}</span>}
                      {+e.alcohol > 0 && <span style={{ background:"#FCA5A522", color:"#FCA5A5", fontSize:10, padding:"2px 8px", borderRadius:20 }}>🍷 {e.alcohol}</span>}
                    </div>
                  </div>
                  <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:6, fontSize:12 }}>
                    {[["HRV",e.hrv,"ms"],["RHR",e.rhr,"bpm"],["Slaap",e.sleep_h,"u"],["Energie",e.energy,"/10"],
                      ["Stress",e.stress,"/10"],["Batt.",e.body_battery,"%"],["BP",e.bp_sys&&e.bp_dia?`${e.bp_sys}/${e.bp_dia}`:"",""],["kg",e.weight,""]
                    ].filter(([,v])=>v).map(([l,v,u]) => (
                      <div key={l} style={{ color:"#6B7280" }}>{l}: <span style={{ color:"#CBD5E1" }}>{v}{u?` ${u}`:""}</span></div>
                    ))}
                  </div>
                  {e.notes && <div style={{ marginTop:8, fontSize:11, color:"#4B5563", fontStyle:"italic" }}>"{e.notes}"</div>}
                </div>
              ))
            )}
          </div>
        )}

        {/* ── SETUP ── */}
        {tab === "setup" && (
          <div className="fade" style={{ display:"flex", flexDirection:"column", gap:14 }}>
            <div style={{ background:"#1A1F2E", border:"1px solid #C8F04D44", borderRadius:12, padding:16 }}>
              <div style={{ color:"#C8F04D", fontSize:11, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.1em", marginBottom:12 }}>Status verbindingen</div>
              {[
                { label:"Google Sheets", ok: !!SHEET_ID, detail: SHEET_ID ? `Sheet ID: ...${SHEET_ID.slice(-8)}` : "Niet geconfigureerd" },
                { label:"Claude API", ok: true, detail:"Via Anthropic (ingebouwd)" },
                { label:"Garmin sync", ok: false, detail:"Draait als apart Python script" },
              ].map(s => (
                <div key={s.label} style={{ display:"flex", alignItems:"center", gap:10, marginBottom:10 }}>
                  <span style={{ fontSize:16 }}>{s.ok ? "✅" : "⚪"}</span>
                  <div>
                    <div style={{ fontSize:13, color:"#E2E8F0", fontWeight:600 }}>{s.label}</div>
                    <div style={{ fontSize:11, color:"#6B7280" }}>{s.detail}</div>
                  </div>
                </div>
              ))}
            </div>

            <div style={{ background:"#1A1F2E", border:"1px solid #2A3040", borderRadius:12, padding:16 }}>
              <div style={{ color:"#7DD3FC", fontSize:11, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.1em", marginBottom:10 }}>Quickstart — 3 stappen</div>
              {[
                { n:"1", t:"Repository aanmaken", d:"Maak een GitHub repo en push de projectbestanden." },
                { n:"2", t:"Secrets instellen", d:"Ga naar GitHub → Settings → Secrets. Voeg toe: GARMIN_EMAIL, GARMIN_PASSWORD, GOOGLE_SHEET_ID, GOOGLE_SERVICE_ACCOUNT_JSON_CONTENT." },
                { n:"3", t:"Vercel koppelen", d:"Verbind je GitHub repo met Vercel. Voeg dezelfde env-variabelen toe. Deploy." },
              ].map(s => (
                <div key={s.n} style={{ display:"flex", gap:12, marginBottom:14 }}>
                  <div style={{ background:"#C8F04D", color:"#0D1117", borderRadius:"50%", width:24, height:24, display:"flex", alignItems:"center", justifyContent:"center", fontSize:12, fontWeight:700, flexShrink:0 }}>{s.n}</div>
                  <div>
                    <div style={{ fontSize:13, color:"#E2E8F0", fontWeight:600 }}>{s.t}</div>
                    <div style={{ fontSize:12, color:"#6B7280", marginTop:2 }}>{s.d}</div>
                  </div>
                </div>
              ))}
            </div>

            <div style={{ background:"#1A1F2E", border:"1px solid #2A3040", borderRadius:12, padding:16 }}>
              <div style={{ color:"#C8F04D", fontSize:11, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.1em", marginBottom:10 }}>Op telefoon installeren (PWA)</div>
              <div style={{ fontSize:13, color:"#CBD5E1", lineHeight:1.8 }}>
                <strong style={{ color:"#E2E8F0" }}>iPhone (Safari):</strong><br />
                Deel-knop → "Zet op beginscherm"<br /><br />
                <strong style={{ color:"#E2E8F0" }}>Android (Chrome):</strong><br />
                Menu (⋮) → "Toevoegen aan startscherm"<br /><br />
                <span style={{ color:"#6B7280", fontSize:12 }}>De app werkt daarna als een native app, volledig scherm, zonder browser-balk.</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
