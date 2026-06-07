-- ============================================================
-- Gkoach — Supabase schema
-- Plak dit in: Supabase dashboard → SQL Editor → Run
-- ============================================================

-- health_entries: één rij per gebruiker per dag
CREATE TABLE health_entries (
  id           UUID    DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id      UUID    NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  date         DATE    NOT NULL,

  -- Gewicht & leefstijl
  weight       REAL,
  alcohol      REAL,

  -- Bloeddruk
  bp_sys       REAL,
  bp_dia       REAL,

  -- Slaap
  sleep_h      REAL,
  sleep_q      REAL,
  sleep_deep   REAL,
  sleep_rem    REAL,

  -- HRV
  hrv          REAL,
  hrv_7d       REAL,
  hrv_5min     REAL,

  -- Vitals
  rhr          REAL,
  stress       REAL,
  body_battery REAL,
  steps        INTEGER,
  step_goal    INTEGER,

  -- Training
  trained          BOOLEAN,
  train_type       TEXT,
  train_min        REAL,
  train_dist       REAL,
  avg_hr           REAL,
  max_hr           REAL,
  avg_pace         TEXT,
  cadence          REAL,

  -- Hardloop dynamics
  ground_contact   REAL,
  vertical_osc     REAL,
  vertical_ratio   REAL,
  stride_length    REAL,
  training_effect  TEXT,
  vo2max           REAL,
  run_power        REAL,

  -- Overig Garmin
  energy           REAL,

  -- Check-in
  mental_unrest    BOOLEAN,
  breathing        BOOLEAN,
  breathing_type   TEXT,
  notes            TEXT,
  sleep_prep       BOOLEAN,
  koffie           BOOLEAN,
  mood             INTEGER,
  activities       TEXT,  -- JSON string van Garmin activiteiten

  UNIQUE(user_id, date)
);

-- Row Level Security: gebruikers zien alleen eigen data
ALTER TABLE health_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "eigen data lezen en schrijven"
  ON health_entries FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- planned_workouts: geplande Garmin Coach workouts
CREATE TABLE planned_workouts (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  date        DATE NOT NULL,
  title       TEXT,
  sport       TEXT,
  workout_id  TEXT,
  UNIQUE(user_id, date)
);

ALTER TABLE planned_workouts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "eigen workouts lezen en schrijven"
  ON planned_workouts FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Indexen voor snelle queries
CREATE INDEX idx_health_entries_user_date ON health_entries(user_id, date);
CREATE INDEX idx_planned_workouts_user_date ON planned_workouts(user_id, date);
