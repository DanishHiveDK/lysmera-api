// routes/admin.js — platformens eget overblik.
//
// Stripes dashboard viser betalinger bedre end noget her. Det det IKKE kan, er
// at koble betalingen sammen med brugen: hvem der rent faktisk søger og ringer,
// og hvem der er holdt op uden endnu at have opsagt. Det er dét denne side er
// til for.
'use strict';

const express = require('express');
const db      = require('../db');
const { authenticate } = require('../middleware/auth');
const requirePlatformAdmin = require('../middleware/platformAdmin');
const { erFritaget } = require('../middleware/subscription');
const stripeService = require('../services/stripeService');
const mailService = require('../services/mailService');

const router = express.Router();

const GRUNDPRIS = Number(process.env.PRICE_BASE_DKK || 179);
const PLADSPRIS = Number(process.env.PRICE_SEAT_DKK || 99);

router.use(authenticate, requirePlatformAdmin);

// ── GET /api/admin/overview ──────────────────────────────────────────────────
router.get('/overview', async (req, res) => {
  try {
    const { rows: konti } = await db.query(
      `SELECT o.id, o.name, o.cvr, o.created_at,
              o.subscription_status, o.current_period_end,
              o.stripe_customer_id IS NOT NULL AS har_kunde,
              -- Ejerens adresse afgør om kontoen er fritaget for betaling.
              (SELECT u.email FROM users u
                 WHERE u.org_id = o.id AND u.role = 'owner'
                 ORDER BY u.id LIMIT 1)                                       AS ejer_email,
              (SELECT COUNT(*)::int FROM users u WHERE u.org_id = o.id AND u.is_active)  AS brugere,
              (SELECT COUNT(*)::int FROM users u WHERE u.org_id = o.id)                  AS brugere_i_alt,
              (SELECT COUNT(*)::int FROM leads l WHERE l.org_id = o.id)                  AS leads,
              (SELECT COUNT(*)::int FROM lead_lists ll WHERE ll.org_id = o.id)           AS lister,
              (SELECT COUNT(*)::int FROM lead_activities a
                 WHERE a.org_id = o.id AND a.type = 'call')                              AS opkald,
              -- Sidste livstegn. Uden det kan man ikke se hvem der er holdt op
              -- med at bruge produktet, før opsigelsen kommer.
              GREATEST(
                COALESCE((SELECT MAX(u.last_login_at) FROM users u WHERE u.org_id = o.id), o.created_at),
                COALESCE((SELECT MAX(a.created_at) FROM lead_activities a WHERE a.org_id = o.id), o.created_at)
              ) AS sidst_aktiv
         FROM organizations o
        ORDER BY o.created_at DESC`
    );

    // Vores egne konti står i den samme tabel som kundernes. De betaler ikke,
    // så de må ikke tælle med i omsætningen — ellers ville sidens vigtigste
    // tal vise vores egen gratis adgang som indtægt.
    const fritaget = (k) => erFritaget(k.ejer_email);

    const betalende = konti.filter((k) => k.subscription_status === 'active' && !fritaget(k));
    const prøve     = konti.filter((k) => k.subscription_status === 'trialing' && !fritaget(k));

    const pris = (k) =>
      GRUNDPRIS + Math.max(0, k.brugere - stripeService.PLADSER_INKLUDERET) * PLADSPRIS;

    return res.json({
      konti: konti.map((k) => ({
        ...k,
        maanedspris: pris(k),
        fritaget: fritaget(k),
      })),
      nøgletal: {
        konti: konti.length,
        betalende: betalende.length,
        iPrøveperiode: prøve.length,
        // Kun de betalende tælles med. At regne prøvekonti med ville få
        // omsætningen til at se større ud end den er.
        maanedligOmsaetning: betalende.reduce((s, k) => s + pris(k), 0),
        // Med her, så "konti i alt" kan forklares: differencen mellem det tal
        // og de betalende er ikke kun kunder der ikke har købt.
        fritagne: konti.filter(fritaget).length,
        brugere: konti.reduce((s, k) => s + k.brugere, 0),
        leads: konti.reduce((s, k) => s + k.leads, 0),
        opkald: konti.reduce((s, k) => s + k.opkald, 0),
      },
    });
  } catch (err) {
    console.error('[admin:overview]', err.message);
    return res.status(500).json({ error: 'Kunne ikke hente overblikket.' });
  }
});

// ── GET /api/admin/invoices ──────────────────────────────────────────────────
// De seneste fakturaer på tværs af alle kunder, så I kan se indbetalinger uden
// at skifte over i Stripe.
router.get('/invoices', async (req, res) => {
  if (!stripeService.stripe) {
    return res.status(503).json({ error: 'Betaling er ikke sat op.' });
  }
  try {
    const liste = await stripeService.stripe.invoices.list({ limit: 50 });
    return res.json({
      invoices: liste.data.map((f) => ({
        nummer: f.number,
        kunde: f.customer_name,
        dato: f.status_transitions?.finalized_at ?? f.created,
        ekskl: (f.subtotal ?? 0) / 100,
        moms: (f.tax ?? 0) / 100,
        ialt: (f.total ?? 0) / 100,
        valuta: (f.currency ?? 'dkk').toUpperCase(),
        status: f.status,
        web: f.hosted_invoice_url,
      })),
    });
  } catch (err) {
    console.error('[admin:invoices]', err.message);
    return res.status(502).json({ error: 'Kunne ikke hente fakturaerne.' });
  }
});

// ── Beskeder fra kontaktformularen ───────────────────────────────────────────

const ID = /^\d+$/;

// GET /api/admin/beskeder — nyeste først, med antal svar pr. besked.
router.get('/beskeder', async (req, res) => {
  const arkiv = req.query.arkiv === '1';
  try {
    const { rows } = await db.query(
      `SELECT b.id, b.navn, b.epost, b.besked, b.kilde, b.laest_at, b.arkiveret_at, b.created_at,
              (SELECT COUNT(*)::int FROM kontakt_svar s WHERE s.besked_id = b.id AND s.sendt) AS svar
         FROM kontakt_beskeder b
        WHERE (b.arkiveret_at IS NOT NULL) = $1
        ORDER BY b.created_at DESC
        LIMIT 200`,
      [arkiv]
    );
    const { rows: [t] } = await db.query(
      `SELECT COUNT(*)::int AS ulaeste FROM kontakt_beskeder
        WHERE laest_at IS NULL AND arkiveret_at IS NULL`
    );
    return res.json({ beskeder: rows, ulaeste: t.ulaeste, mailOpsat: mailService.erKonfigureret() });
  } catch (err) {
    console.error('[admin:beskeder]', err.message);
    return res.status(500).json({ error: 'Kunne ikke hente beskederne.' });
  }
});

// GET /api/admin/beskeder/:id — beskeden og dens svar. Markerer den som læst.
router.get('/beskeder/:id', async (req, res) => {
  if (!ID.test(req.params.id)) return res.status(404).json({ error: 'Beskeden findes ikke.' });
  try {
    const { rows: [besked] } = await db.query(
      `UPDATE kontakt_beskeder SET laest_at = COALESCE(laest_at, NOW())
        WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (!besked) return res.status(404).json({ error: 'Beskeden findes ikke.' });
    const { rows: svar } = await db.query(
      `SELECT s.id, s.tekst, s.emne, s.sendt, s.created_at, u.name AS afsender
         FROM kontakt_svar s LEFT JOIN users u ON u.id = s.sendt_af
        WHERE s.besked_id = $1 ORDER BY s.created_at`,
      [besked.id]
    );
    return res.json({ besked, svar });
  } catch (err) {
    console.error('[admin:besked]', err.message);
    return res.status(500).json({ error: 'Kunne ikke hente beskeden.' });
  }
});

// PATCH /api/admin/beskeder/:id — { laest?: bool, arkiveret?: bool }
router.patch('/beskeder/:id', async (req, res) => {
  if (!ID.test(req.params.id)) return res.status(404).json({ error: 'Beskeden findes ikke.' });
  const { laest, arkiveret } = req.body || {};
  // Kun faste SQL-stykker; ingen brugerværdi sættes ind i strengen.
  const sæt = [];
  if (typeof laest === 'boolean') sæt.push(`laest_at = ${laest ? 'COALESCE(laest_at, NOW())' : 'NULL'}`);
  if (typeof arkiveret === 'boolean') sæt.push(`arkiveret_at = ${arkiveret ? 'NOW()' : 'NULL'}`);
  if (!sæt.length) return res.status(400).json({ error: 'Intet at ændre.' });
  try {
    const { rowCount } = await db.query(
      `UPDATE kontakt_beskeder SET ${sæt.join(', ')} WHERE id = $1`, [req.params.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Beskeden findes ikke.' });
    return res.json({ ok: true });
  } catch (err) {
    console.error('[admin:besked:patch]', err.message);
    return res.status(500).json({ error: 'Kunne ikke opdatere beskeden.' });
  }
});

// POST /api/admin/beskeder/:id/svar — { tekst, emne? }. Sendes som mail fra
// lucca@lysmera.dk. Svaret gemmes også, når mailen fejler, så det kan ses.
router.post('/beskeder/:id/svar', async (req, res) => {
  if (!ID.test(req.params.id)) return res.status(404).json({ error: 'Beskeden findes ikke.' });
  const tekst = String(req.body?.tekst ?? '').trim().slice(0, 20000);
  if (!tekst) return res.status(400).json({ error: 'Skriv et svar først.' });
  if (!mailService.erKonfigureret()) {
    return res.status(503).json({
      error: 'Mail er ikke sat op på serveren (SMTP_USER/SMTP_PASS eller RESEND_API_KEY mangler).',
      code: 'MAIL_IKKE_OPSAT',
    });
  }

  try {
    const { rows: [besked] } = await db.query(
      'SELECT * FROM kontakt_beskeder WHERE id = $1', [req.params.id]
    );
    if (!besked) return res.status(404).json({ error: 'Beskeden findes ikke.' });

    const emne = String(req.body?.emne ?? '').trim().slice(0, 200) || 'Sv: Din henvendelse til Lysmera';
    const sendt = await mailService.sendKontaktSvar({
      til: besked.epost,
      navn: besked.navn,
      emne,
      tekst,
      oprindelig: besked.besked,
      dato: new Date(besked.created_at).toLocaleString('da-DK', { timeZone: 'Europe/Copenhagen' }),
    });

    const { rows: [svar] } = await db.query(
      `INSERT INTO kontakt_svar (besked_id, tekst, emne, sendt_af, sendt)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, tekst, emne, sendt, created_at`,
      [besked.id, tekst, emne, req.user.id, sendt]
    );
    await db.query(
      'UPDATE kontakt_beskeder SET laest_at = COALESCE(laest_at, NOW()) WHERE id = $1', [besked.id]
    );

    const medAfsender = { ...svar, afsender: req.user.name ?? null };
    if (!sendt) {
      return res.status(502).json({
        error: 'Mailen blev ikke sendt. Svaret er gemt — prøv igen.',
        svar: medAfsender,
      });
    }
    return res.status(201).json({ svar: medAfsender });
  } catch (err) {
    console.error('[admin:besked:svar]', err.message);
    return res.status(500).json({ error: 'Kunne ikke sende svaret.' });
  }
});

module.exports = router;
