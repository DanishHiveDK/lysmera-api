// routes/kontakt.js — kontaktformularen på lysmera.dk.
//
// Offentlig og uden login. Landingssidens worker sender formularen hertil, og
// beskeden havner under Admin → Beskeder, hvor den kan besvares.
//
// Beskeden gemmes FØR notifikationsmailen. Fejler mailen, er beskeden stadig
// her, og formularen melder succes — for den er modtaget.
'use strict';

const express   = require('express');
const rateLimit = require('express-rate-limit');
const db        = require('../db');
const appUrl    = require('../config/appUrl');
const mailService = require('../services/mailService');

const router = express.Router();

// Workeren står mellem browseren og os, så req.ip er en Cloudflare-adresse.
// Den sender den besøgendes adresse med. Kan headeren forfalskes af den, der
// kalder API'et direkte? Ja — men det giver kun et loft pr. opdigtet adresse,
// og honeypot og længdegrænser gælder stadig.
const kontaktLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.get('X-Klient-IP') || req.ip,
  message: { fejl: 'for_mange', error: 'For mange beskeder. Prøv igen om lidt.' },
});

/** Klipper og renser et felt, så en fejlindtastning ikke fylder en hel side. */
function felt(v, maks) {
  return String(v ?? '').trim().slice(0, maks);
}

router.post('/', kontaktLimiter, async (req, res) => {
  const krop = req.body || {};

  // Honeypot: et skjult felt, som kun robotter udfylder. De får et ok, så de
  // ikke lærer at prøve igen på en anden måde.
  if (felt(krop.hjemmeside, 200)) return res.json({ ok: true });

  const navn   = felt(krop.navn, 120);
  const epost  = felt(krop.epost, 200).toLowerCase();
  const besked = felt(krop.besked ?? krop.hvem, 5000);

  if (!navn || !epost) {
    return res.status(400).json({ fejl: 'mangler_felter', error: 'Navn og e-mail skal udfyldes.' });
  }
  // Løs kontrol: fanger tastefejl uden at afvise usædvanlige, gyldige adresser.
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(epost)) {
    return res.status(400).json({ fejl: 'ugyldig_epost', error: 'E-mailadressen ser forkert ud.' });
  }

  let id;
  try {
    const { rows } = await db.query(
      `INSERT INTO kontakt_beskeder (navn, epost, besked, kilde)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [navn, epost, besked, felt(krop.kilde, 60) || 'lysmera.dk']
    );
    id = rows[0].id;
  } catch (err) {
    console.error('[kontakt]', err.message);
    return res.status(500).json({ fejl: 'gem_fejlede', error: 'Beskeden kunne ikke gemmes.' });
  }

  // Ventes ikke på: den besøgende skal ikke hænge, fordi Resend er langsom.
  mailService
    .sendKontaktNotifikation({ navn, epost, besked, link: `${appUrl()}/admin?besked=${id}` })
    .catch((err) => console.error('[kontakt:mail]', err.message));

  return res.status(201).json({ ok: true });
});

module.exports = router;
