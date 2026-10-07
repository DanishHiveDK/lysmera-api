-- 013 — anonym besøgstæller for lysmera.dk og opret-siden i appen.
--
-- Kun samlede tal pr. dag: ingen IP-adresser, ingen cookies, intet der kan
-- føres tilbage til en person. Det er dét, der gør, at privatlivspolitikkens
-- "ingen cookies til statistik" stadig er sandt, og at der ikke skal et banner.
--
-- `kilde` udfyldes kun for sidevisninger (hvor kom de fra); for de øvrige
-- hændelser er den tom.
CREATE TABLE IF NOT EXISTS besoeg_taeller (
  dag        DATE    NOT NULL,
  haendelse  TEXT    NOT NULL,
  kilde      TEXT    NOT NULL DEFAULT '',
  antal      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (dag, haendelse, kilde)
);
