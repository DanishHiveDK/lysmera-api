-- 012 — hvem har åbnet hvilken guide.
--
-- Én række pr. bruger og guide; gentagne åbninger tæller op i `antal`. Det er
-- grundlaget for at vurdere, om et betalt kursus er værd at lave.
CREATE TABLE IF NOT EXISTS guide_visninger (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id      INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  slug        TEXT NOT NULL,
  antal       INTEGER NOT NULL DEFAULT 1,
  foerste_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sidste_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, slug)
);
