// routes/besoeg.js — anonym besøgstæller.
//
// Offentlig og uden login. Landingssidens worker sender hændelserne fra
// lysmera.dk hertil (med X-Klient-IP, så bremsen virker pr. besøgende), og
// appens opret-side kalder direkte.
//
// Der gemmes kun en optælling pr. dag og hændelse. Ingen IP, ingen
// browser-id, intet pr. besøgende — derfor heller ingen cookie og intet
// samtykke. Prisen er, at vi ikke kan følge én besøgende hele vejen; tragten
// er antal pr. trin, ikke de samme personer trin for trin.
'use strict';

const express   = require('express');
const rateLimit = require('express-rate-limit');
const db        = require('../db');

const router = express.Router();

// Det, siderne må tælle. Alt andet afvises, så endepunktet ikke kan bruges
// til at fylde tabellen med opdigtede rækker.
const HAENDELSER = new Set([
  'visning',      // lysmera.dk blev åbnet
  'funktioner',   // sektionen "Funktioner" kom i syne
  'saadan',       // sektionen "Sådan virker det" kom i syne
  'adgang',       // formularen kom i syne
  'cta',          // klik på "Få adgang"
  'login',        // klik på "Log ind"
  'form_start',   // begyndte at udfylde formularen
  'form_sendt',   // formularen blev sendt
  'opret_visning' // appens /opret-side blev åbnet
]);

const ROBOT = /bot|crawl|spider|slurp|headless|lighthouse|preview|facebookexternalhit|embedly|monitor/i;

// En rigtig besøgende sender en håndfuld hændelser pr. sidevisning.
const besoegLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.get('X-Klient-IP') || req.ip,
  handler: (req, res) => res.status(204).end(), // stille: en tæller skal aldrig give fejl i browseren
});

/** Hvor kom de fra — groft inddelt, så tabellen ikke fyldes med enkelt-URL'er. */
function kilde(ref, utm) {
  const u = String(utm || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 30);
  if (u) return `utm:${u}`;
  let vært = '';
  try { vært = new URL(String(ref || '')).hostname.replace(/^www\./, ''); } catch { /* ingen henviser */ }
  if (!vært) return 'direkte';
  if (/(^|\.)lysmera\.dk$/.test(vært)) return 'direkte';
  if (/google\.|bing\.|duckduckgo\.|ecosia\.|yahoo\./.test(vært)) return 'søgning';
  if (/linkedin\.|lnkd\.in/.test(vært)) return 'linkedin';
  if (/facebook\.|fb\.|instagram\.|l\.messenger/.test(vært)) return 'facebook/instagram';
  if (/eurohive\.eu$/.test(vært)) return 'eurohive';
  return 'andet';
}

router.post('/', besoegLimiter, async (req, res) => {
  const krop = req.body || {};
  const h = String(krop.h || '');
  if (!HAENDELSER.has(h)) return res.status(400).json({ fejl: 'ukendt_haendelse' });
  const ua = req.get('X-Klient-UA') || req.get('User-Agent') || '';
  if (ROBOT.test(ua)) return res.status(204).end();

  const k = h === 'visning' ? kilde(krop.ref, krop.utm) : '';
  try {
    await db.query(
      `INSERT INTO besoeg_taeller (dag, haendelse, kilde, antal)
       VALUES ((NOW() AT TIME ZONE 'Europe/Copenhagen')::date, $1, $2, 1)
       ON CONFLICT (dag, haendelse, kilde) DO UPDATE SET antal = besoeg_taeller.antal + 1`,
      [h, k]
    );
  } catch (err) {
    console.error('[besoeg]', err.message);
  }
  return res.status(204).end();
});

module.exports = router;
module.exports.kilde = kilde;
