// routes/guides.js — registrerer, når en bruger åbner en guide.
//
// Guiderne selv ligger i frontenden. Her gemmes kun, hvem der har læst hvad.
// Kræver login, men ikke abonnement: guiderne er gratis, også efter en
// udløbet prøveperiode.
'use strict';

const express = require('express');
const db      = require('../db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// Frontenden ejer listen over guides. Formatet holder skrald ude af tabellen.
const SLUG = /^[a-z0-9-]{1,60}$/;

router.post('/:slug/laest', authenticate, async (req, res) => {
  if (!SLUG.test(req.params.slug)) return res.status(404).json({ error: 'Guiden findes ikke.' });
  try {
    await db.query(
      `INSERT INTO guide_visninger (user_id, org_id, slug) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, slug)
       DO UPDATE SET antal = guide_visninger.antal + 1, sidste_at = NOW()`,
      [req.user.id, req.orgId, req.params.slug]
    );
    return res.status(204).end();
  } catch (err) {
    console.error('[guides]', err.message);
    return res.status(500).json({ error: 'Kunne ikke gemme.' });
  }
});

module.exports = router;
