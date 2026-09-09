-- ============================================================
-- Gkoach — migratie september 2026
-- Voegt velden toe voor meditatie en voeding.
--
-- Uitvoeren in: Supabase dashboard → SQL Editor → Run
-- Veilig om meerdere keren te draaien (IF NOT EXISTS).
-- Bestaande rijen krijgen NULL — dat betekent bewust "niet ingevuld",
-- niet "nul". De app en de coach maken dat onderscheid ook.
-- ============================================================

ALTER TABLE health_entries
  ADD COLUMN IF NOT EXISTS meditation_min INTEGER,   -- minuten mediteren (doel 15)
  ADD COLUMN IF NOT EXISTS veg_fruit      INTEGER,   -- porties groente & fruit (doel 5)
  ADD COLUMN IF NOT EXISTS protein_ok     BOOLEAN,   -- eiwit bij elke maaltijd
  ADD COLUMN IF NOT EXISTS late_meal      BOOLEAN,   -- hoofdmaaltijd <2u voor bed
  ADD COLUMN IF NOT EXISTS snacks         INTEGER;   -- aantal bewerkte snacks

-- Controle: laat de nieuwe kolommen zien
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'health_entries'
  AND column_name IN ('meditation_min', 'veg_fruit', 'protein_ok', 'late_meal', 'snacks')
ORDER BY column_name;
