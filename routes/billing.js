// routes/billing.js — abonnement: status, checkout og kundeportal.
'use strict';

const express = require('express');
const db      = require('../db');
const stripeService = require('../services/stripeService');
const requireSubscription = require('../middleware/subscription');
const { authenticate, requireOwner } = require('../middleware/auth');

const router = express.Router();

/** Frontendens adresse — hertil sendes brugeren tilbage fra Stripe. */
const appUrl = require('../config/appUrl');

async function hentOrg(orgId) {
  const { rows } = await db.query(
    `SELECT o.id, o.name, o.cvr, o.stripe_customer_id, o.stripe_subscription_id,
            o.subscription_status, o.current_period_end,
            o.paid_seats, o.requested_seats,
            (SELECT COUNT(*)::int FROM users u
              WHERE u.org_id = o.id AND u.is_active) AS aktive_brugere,
            -- Åbne invitationer optager en plads. Ellers ville de ledige
            -- pladser her sige noget andet end det, en invitation får at vide.
            (SELECT COUNT(*)::int FROM team_invitations i
              WHERE i.org_id = o.id AND i.status = 'pending'
                AND i.expires_at > NOW()) AS afventende_invitationer,
            -- Ejerens adresse afgør fritagelsen for hele organisationen.
            (SELECT u.email FROM users u
              WHERE u.org_id = o.id AND u.role = 'owner'
              ORDER BY u.id LIMIT 1) AS ejer_email
       FROM organizations o WHERE o.id = $1`,
    [orgId]
  );
  return rows[0] ?? null;
}

/**
 * Forudbetalte ekstra pladser. Købt i Stripe, når der er et abonnement;
 * før det, dem der blev valgt ved oprettelsen. En fritagen konto har ingen.
 */
function koebtePladser(org, fritaget) {
  if (fritaget) return 0;
  return org.stripe_subscription_id ? org.paid_seats : org.requested_seats;
}

/** Et gyldigt antal ekstra pladser, eller null. */
function gyldigtAntal(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= stripeService.MAKS_PLADSER ? n : null;
}

/** Prisen i kroner, ekskl. moms. */
const GRUNDPRIS = Number(process.env.PRICE_BASE_DKK || 179);
const PLADSPRIS = Number(process.env.PRICE_SEAT_DKK || 99);

// ── GET /api/billing/status ──────────────────────────────────────────────────
// Frontenden spørger her for at vide om den skal vise betalingsmuren.
router.get('/status', authenticate, async (req, res) => {
  try {
    const org = await hentOrg(req.orgId);
    if (!org) return res.status(404).json({ error: 'Organisationen blev ikke fundet.' });

    // Ejerne er fritaget i muren, og status skal sige det samme — ellers
    // ville brugerfladen vise låsen frem, mens API'et lukkede dem ind.
    // Fritagelsen følger organisationen: er ejeren fritaget, gælder det også
    // de kollegaer ejeren har taget med ind — op til de gratis pladser.
    const fritaget = requireSubscription.erFritaget(req.user?.email)
                  || requireSubscription.erFritaget(org.ejer_email);

    const gratisPladser = requireSubscription.GRATIS_TEAMPLADSER;
    const betaltePladser = koebtePladser(org, fritaget);
    // Hvor mange brugere teamet kan have, og hvor mange der er i brug.
    // Afventende invitationer optager en plads, som når de sendes.
    const kapacitet = fritaget
      ? 1 + gratisPladser
      : stripeService.PLADSER_INKLUDERET + betaltePladser;
    const brugt = org.aktive_brugere + org.afventende_invitationer;

    return res.json({
      status: fritaget ? 'fritaget' : org.subscription_status,
      harAdgang: fritaget || stripeService.harAdgang(org.subscription_status),
      fritaget,
      iPrøveperiode: !fritaget && org.subscription_status === 'trialing',
      team: {
        aktive: org.aktive_brugere,
        inkluderet: stripeService.PLADSER_INKLUDERET,
        betaltePladser,
        grundpris: GRUNDPRIS,
        pladspris: PLADSPRIS,
        // Gratis pladser ud over ejeren selv. 0 på en betalende konto, så
        // frontenden kan nøjes med at se på tallet.
        gratisPladser: fritaget ? gratisPladser : 0,
        afventendeInvitationer: org.afventende_invitationer,
        kapacitet,
        brugt,
        ledige: Math.max(0, kapacitet - brugt),
        maksPladser: stripeService.MAKS_PLADSER,
        // Kan pladser købes? Kræver en pladspris i Stripe.
        kanKoebePladser: Boolean(stripeService.SEAT_PRICE_ID),
        ledigeGratisPladser: fritaget
          ? Math.max(0, 1 + gratisPladser - org.aktive_brugere - org.afventende_invitationer)
          : 0,
        // Ekskl. moms. Frontenden lægger 25 % på når den viser inkl.-prisen,
        // så de to tal aldrig kan komme til at modsige hinanden.
        ialt: fritaget ? 0 : GRUNDPRIS + betaltePladser * PLADSPRIS,
      },
      periodeSlutter: org.current_period_end,
      harAbonnement: Boolean(org.stripe_subscription_id),
      prøvedage: stripeService.TRIAL_DAGE,
    });
  } catch (err) {
    console.error('[billing:status]', err.message);
    return res.status(500).json({ error: 'Kunne ikke hente abonnementet.' });
  }
});

// ── POST /api/billing/checkout ───────────────────────────────────────────────
router.post('/checkout', authenticate, requireOwner, async (req, res) => {
  if (!stripeService.erKonfigureret()) {
    return res.status(503).json({ error: 'Betaling er ikke sat op endnu.' });
  }

  try {
    const org = await hentOrg(req.orgId);
    if (!org) return res.status(404).json({ error: 'Organisationen blev ikke fundet.' });

    // Antallet af ekstra brugere kan rettes lige før betalingen. Uden et tal
    // bruges det, der blev valgt ved oprettelsen.
    const pladser = req.body?.pladser === undefined ? org.requested_seats : gyldigtAntal(req.body.pladser);
    if (pladser === null) {
      return res.status(400).json({ error: `Vælg mellem 0 og ${stripeService.MAKS_PLADSER} ekstra brugere.` });
    }
    if (pladser > 0 && !stripeService.SEAT_PRICE_ID) {
      return res.status(503).json({ error: 'Ekstra brugere kan ikke købes endnu.' });
    }
    const brugt = org.aktive_brugere + org.afventende_invitationer;
    if (stripeService.PLADSER_INKLUDERET + pladser < brugt) {
      return res.status(409).json({
        error: `I har allerede ${brugt} brugere og invitationer. Vælg mindst ${brugt - stripeService.PLADSER_INKLUDERET} ekstra brugere.`,
        code: 'SEATS_IN_USE',
      });
    }
    await db.query('UPDATE organizations SET requested_seats = $1 WHERE id = $2', [pladser, org.id]);

    const session = await stripeService.opretCheckout({
      orgId: org.id,
      email: req.user.email,
      kundeId: org.stripe_customer_id,
      orgNavn: org.name,
      cvr: org.cvr,
      pladser,
      successUrl: `${appUrl()}/velkommen?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${appUrl()}/abonnement`,
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error('[billing:checkout]', err.message);
    return res.status(502).json({ error: 'Kunne ikke starte betalingen. Prøv igen.' });
  }
});

// ── POST /api/billing/seats — køb flere eller færre pladser ─────────────────
//
// Body: { pladser } — det ønskede antal ekstra pladser i alt, ikke en ændring.
// Der kan ikke gås under det antal, der er i brug; ellers ville nogen miste
// adgangen uden at ejeren havde valgt hvem.
router.post('/seats', authenticate, requireOwner, async (req, res) => {
  const pladser = gyldigtAntal(req.body?.pladser);
  if (pladser === null) {
    return res.status(400).json({ error: `Vælg mellem 0 og ${stripeService.MAKS_PLADSER} ekstra pladser.` });
  }

  try {
    const org = await hentOrg(req.orgId);
    if (!org) return res.status(404).json({ error: 'Organisationen blev ikke fundet.' });
    if (requireSubscription.erFritaget(org.ejer_email)) {
      return res.status(400).json({ error: 'Kontoen er fritaget og har gratis pladser. Der er intet at købe.' });
    }

    const brugt = org.aktive_brugere + org.afventende_invitationer;
    if (stripeService.PLADSER_INKLUDERET + pladser < brugt) {
      return res.status(409).json({
        error: `I bruger ${brugt} pladser, inkl. afventende invitationer. Deaktivér et medlem `
             + `eller træk en invitation tilbage, før I går ned til ${stripeService.PLADSER_INKLUDERET + pladser}.`,
        code: 'SEATS_IN_USE',
      });
    }

    // Intet abonnement endnu: tallet er et ønske, som checkout tager med.
    if (!org.stripe_subscription_id) {
      await db.query('UPDATE organizations SET requested_seats = $1 WHERE id = $2', [pladser, org.id]);
      return res.json({ pladser, afventerBetaling: true });
    }

    await stripeService.saetPladser({ abonnementId: org.stripe_subscription_id, pladser });
    // Webhooken skriver det samme tal lidt efter. Det skrives også her, så den
    // nye plads kan bruges med det samme.
    await db.query('UPDATE organizations SET paid_seats = $1 WHERE id = $2', [pladser, org.id]);
    return res.json({ pladser, afventerBetaling: false });
  } catch (err) {
    if (err.code === 'SEATS_NOT_CONFIGURED') {
      return res.status(503).json({ error: 'Ekstra pladser kan ikke købes endnu.' });
    }
    console.error('[billing:seats]', err.message);
    return res.status(502).json({ error: 'Kunne ikke ændre pladserne. Prøv igen.' });
  }
});

// ── POST /api/billing/portal ─────────────────────────────────────────────────
router.post('/portal', authenticate, requireOwner, async (req, res) => {
  try {
    const org = await hentOrg(req.orgId);
    if (!org?.stripe_customer_id) {
      return res.status(400).json({ error: 'Der er ikke oprettet et abonnement endnu.' });
    }

    const session = await stripeService.opretPortal({
      kundeId: org.stripe_customer_id,
      returUrl: `${appUrl()}/abonnement`,
    });
    return res.json({ url: session.url });
  } catch (err) {
    console.error('[billing:portal]', err.message);
    return res.status(502).json({ error: 'Kunne ikke åbne kundeportalen.' });
  }
});

/**
 * Fakturaer fra Stripe, i den form frontenden skal bruge.
 *
 * Stripe er kilden — vi gemmer dem ikke selv. En kopi ville kunne komme ud af
 * trit med virkeligheden ved en kreditnota eller en refusion, og så ville
 * kundens bogholderi bygge på noget forkert.
 */
async function hentFakturaer(kundeId, antal = 100) {
  if (!kundeId || !stripeService.stripe) return [];
  const liste = await stripeService.stripe.invoices.list({
    customer: kundeId,
    limit: Math.min(antal, 100),
  });

  return liste.data.map((f) => ({
    nummer: f.number,
    dato: f.status_transitions?.finalized_at ?? f.created,
    periodeStart: f.period_start,
    periodeSlut: f.period_end,
    status: f.status,
    betalt: f.status === 'paid',
    // Beløb i ører fra Stripe. Kronerne regnes ét sted — her — så de to tal
    // ikke kan komme til at modsige hinanden i brugerfladen.
    ekskl: (f.subtotal ?? 0) / 100,
    moms: (f.tax ?? f.total_taxes?.reduce((s, t) => s + (t.amount || 0), 0) ?? 0) / 100,
    ialt: (f.total ?? 0) / 100,
    valuta: (f.currency ?? 'dkk').toUpperCase(),
    // Køberen tages fra fakturaen, ikke fra vores database. Stripe fryser
    // navnet fast når fakturaen udstedes, og bilaget er dét der gælder i et
    // regnskab. Læste vi navnet hos os, ville et senere navneskifte give en
    // CSV-linje der ikke passer til den PDF der ligger ved siden af.
    køberNavn: f.customer_name ?? null,
    køberCvr: f.customer_tax_ids?.[0]?.value ?? null,
    pdf: f.invoice_pdf,
    web: f.hosted_invoice_url,
  }));
}

// ── GET /api/billing/invoices ────────────────────────────────────────────────
router.get('/invoices', authenticate, async (req, res) => {
  try {
    const org = await hentOrg(req.orgId);
    if (!org) return res.status(404).json({ error: 'Organisationen blev ikke fundet.' });

    return res.json({
      invoices: await hentFakturaer(org.stripe_customer_id),
      // Med til CSV'en og til visningen: en faktura uden købers oplysninger
      // kan ikke bruges i et regnskab.
      virksomhed: { navn: org.name, cvr: org.cvr },
    });
  } catch (err) {
    console.error('[billing:invoices]', err.message);
    return res.status(502).json({ error: 'Kunne ikke hente fakturaerne.' });
  }
});

// ── GET /api/billing/invoices.csv ────────────────────────────────────────────
// Til bogføring. Semikolon og komma som decimaltegn, så dansk Excel åbner den
// i kolonner frem for at proppe det hele ned i én.
router.get('/invoices.csv', authenticate, async (req, res) => {
  try {
    const org = await hentOrg(req.orgId);
    if (!org) return res.status(404).json({ error: 'Organisationen blev ikke fundet.' });

    const fakturaer = await hentFakturaer(org.stripe_customer_id);
    const kr = (n) => String(n.toFixed(2)).replace('.', ',');
    const dato = (s) => (s ? new Date(s * 1000).toISOString().slice(0, 10) : '');

    const linjer = [
      ['Fakturanummer', 'Dato', 'Periode fra', 'Periode til', 'Beløb ekskl. moms',
       // Momsnummeret står som Stripe har det på bilaget — for en dansk kunde
       // et CVR med DK foran. Det tal skal kunne slås direkte op mod bilaget,
       // så det skrives uændret frem for at blive pyntet til.
       'Moms', 'Beløb i alt', 'Valuta', 'Status', 'Købers navn', 'Købers CVR/momsnr.'].join(';'),
      ...fakturaer.map((f) => [
        f.nummer ?? '', dato(f.dato), dato(f.periodeStart), dato(f.periodeSlut),
        kr(f.ekskl), kr(f.moms), kr(f.ialt), f.valuta,
        f.betalt ? 'Betalt' : f.status,
        f.køberNavn ?? org.name ?? '', f.køberCvr ?? org.cvr ?? '',
      ].join(';')),
    ];

    // BOM foran, ellers viser dansk Excel æ, ø og å som volapyk.
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="lysmera-fakturaer.csv"');
    return res.send('﻿' + linjer.join('\r\n'));
  } catch (err) {
    console.error('[billing:invoices:csv]', err.message);
    return res.status(502).json({ error: 'Kunne ikke lave udtrækket.' });
  }
});

module.exports = router;
