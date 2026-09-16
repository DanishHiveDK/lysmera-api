-- 011 — beskeder fra kontaktformularen på lysmera.dk, og svarene på dem.
--
-- Beskeden gemmes, før der sendes nogen mail. Mailen til os er kun en
-- notifikation; det er rækken her, der er beskeden. Så forsvinder intet,
-- fordi Resend var nede eller en nøgle manglede.
CREATE TABLE IF NOT EXISTS kontakt_beskeder (
  id            SERIAL PRIMARY KEY,
  navn          TEXT NOT NULL,
  epost         TEXT NOT NULL,
  besked        TEXT NOT NULL DEFAULT '',
  kilde         TEXT NOT NULL DEFAULT 'lysmera.dk',
  laest_at      TIMESTAMPTZ,
  arkiveret_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS kontakt_beskeder_nyeste_idx
  ON kontakt_beskeder (created_at DESC);

-- Et svar gemmes også, når mailen ikke kom afsted (sendt = false), så man
-- kan se det og prøve igen i stedet for at tro, at kunden har fået det.
CREATE TABLE IF NOT EXISTS kontakt_svar (
  id          SERIAL PRIMARY KEY,
  besked_id   INTEGER NOT NULL REFERENCES kontakt_beskeder(id) ON DELETE CASCADE,
  tekst       TEXT NOT NULL,
  emne        TEXT NOT NULL,
  sendt_af    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  sendt       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS kontakt_svar_besked_idx ON kontakt_svar (besked_id, created_at);
