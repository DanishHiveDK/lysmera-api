// routes/search.js — CVR search preview and single-company lookup.
// Nothing here writes to the database; saving results is routes/lists.js.
'use strict';

const express   = require('express');
const db        = require('../db');
const rateLimit = require('express-rate-limit');
const cvr       = require('../services/cvrService');
const { sanitizeFilters } = require('../services/filterSchema');
const { begrænsFiltre } = require('../middleware/funktioner');
const { authenticate }    = require('../middleware/auth');
const options   = require('../config/cvrOptions');

const router = express.Router();

// Virk is a shared public resource — don't let one account hammer it.
const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 40,
  keyGenerator: (req) => String(req.user?.id ?? req.ip),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'For mange søgninger på kort tid. Vent et øjeblik.' },
});

/** Translate a CvrError into its HTTP response; anything else is a 500. */
function handleCvrError(err, res, context) {
  if (err instanceof cvr.CvrError) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  console.error(`[${context}]`, err.message);
  return res.status(500).json({ error: 'Der skete en uventet fejl.' });
}

/**
 * Piller virksomheder ud af en side med resultater.
 *
 * To slags frasortering, holdt adskilt fordi brugeren har bedt om dem
 * forskelligt:
 *
 *   skjulte  — virksomheder man udtrykkeligt har valgt fra. Ryger ALTID ud,
 *              medmindre man beder om at se dem igen. Det var en bevidst
 *              handling, og så skal den holde uden at man skal huske et
 *              flueben hver gang.
 *   gemte    — virksomheder man allerede har som lead. Kun når fluebenet er
 *              sat, for nogle gange VIL man se dem.
 *
 * Sker HER og ikke i forespørgslen til CVR: registret kender ikke vores
 * database, og en konto kan have hundredtusinder af leads — de kan ikke sendes
 * med som betingelse. Derfor forbliver `total` registrets tal, og tallene
 * nedenfor siger hvor mange der blev pillet ud af netop denne side, så
 * brugerfladen kan sige det ligeud frem for at lade siden se kortere ud.
 */
async function fravælg(orgId, results, { udenGemte = false, medSkjulte = false } = {}) {
  const numre = results.map((c) => String(c.cvr)).filter(Boolean);
  if (!numre.length) return { vist: results, skjultAfDig: 0, alleredeGemt: 0 };

  const [skjulte, gemte] = await Promise.all([
    medSkjulte
      ? { rows: [] }
      : db.query('SELECT cvr FROM hidden_companies WHERE org_id = $1 AND cvr = ANY($2::text[])',
          [orgId, numre]),
    // Slås altid op: også når man IKKE vil have dem skjult, skal rækkerne
    // kunne mærkes med om man har dem i forvejen.
    db.query('SELECT DISTINCT cvr FROM leads WHERE org_id = $1 AND cvr = ANY($2::text[])',
      [orgId, numre]),
  ]);

  const erSkjult = new Set(skjulte.rows.map((r) => r.cvr));
  const erGemt   = new Set(gemte.rows.map((r) => r.cvr));

  let skjultAfDig = 0;
  let alleredeGemt = 0;
  const vist = results.filter((c) => {
    const n = String(c.cvr);
    // Rækkefølgen betyder noget for tællingen: er en virksomhed både skjult og
    // gemt, tælles den som skjult, for det var den mest bevidste handling.
    if (erSkjult.has(n)) { skjultAfDig += 1; return false; }
    if (udenGemte && erGemt.has(n)) { alleredeGemt += 1; return false; }
    return true;
  // Mærket sættes til sidst, så det også står på dem der ER med i visningen —
  // altså når brugeren IKKE har bedt om at få dem gemte skjult. Uden det kunne
  // man ikke se hvilke af rækkerne man allerede har rørt.
  }).map((c) => ({ ...c, alleredeGemt: erGemt.has(String(c.cvr)) }));
  return { vist, skjultAfDig, alleredeGemt };
}

// ── GET /api/meta/options — dropdown data for the search form ────────────────
router.get('/meta/options', authenticate, (req, res) => {
  res.json({
    industries:   options.INDUSTRIES,
    // Overordnede områder. Dækker hver branchekode i registret via
    // præfiks på hovedafdelingen, så listen ikke kan komme bagud.
    industryCategories: options.INDUSTRY_CATEGORIES.map(({ value, label }) => ({ value, label })),
    companyForms: options.COMPANY_FORMS,
    regions:      options.REGIONS,
    // Two axes: `statuses` is the outcome of a call, `stages` is where the
    // lead sits in the funnel. The UI needs both — see API.md.
    statuses:     options.LEAD_STATUSES,
    stages:       options.PIPELINE_STAGES,
    // Hvilke kolonner der kan sorteres. Frontenden gætter ikke.
    sortableColumns: Object.keys(cvr.SORTERBARE),
    cvrConfigured: cvr.hasVirkCredentials(),
  });
});

// ── POST /api/search — paged preview of a filter ─────────────────────────────
router.post('/search', authenticate, searchLimiter, async (req, res) => {
  const filters = sanitizeFilters(req.body?.filters ?? req.body ?? {});
  begrænsFiltre(filters, req.user?.email);
  try {
    const { total, results } = await cvr.searchCompanies({
      filters,
      page: req.body?.page ?? 1,
      size: req.body?.size ?? 25,
      // Kolonnesortering fra tabelhovedet. Ukendte navne falder tilbage på
      // standarden i cvrService frem for at fejle.
      sort: req.body?.sort,
      order: req.body?.order,
    });

    const { vist, skjultAfDig, alleredeGemt } = await fravælg(req.orgId, results, {
      udenGemte: filters.excludeExisting,
      medSkjulte: filters.includeHidden,
    });

    return res.json({
      total,
      results: vist,
      skjultAfDig,
      alleredeGemt,
      filters,
      excludesAdvertisingProtected: cvr.EXCLUDE_PROTECTED,
    });
  } catch (err) {
    return handleCvrError(err, res, 'search');
  }
});

// ── GET /api/new-companies — the product's core view ─────────────────────────
// Companies registered in the last N days, newest first. Everything the
// dashboard and the landing feed are built on.
//
// Query: days (1-90, default 7), page, size, plus the normal search filters
// as repeatable params (industryCodes, region, zipFrom/zipTo, requirePhone…).
router.get('/new-companies', authenticate, searchLimiter, async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 90);
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  // Reuse the shared filter validation, then pin the date window. A caller
  // cannot widen it past `days` by also sending establishedFrom.
  const filters = sanitizeFilters({ ...req.query, establishedFrom: since, establishedTo: undefined });
  begrænsFiltre(filters, req.user?.email);

  try {
    const { total, results } = await cvr.searchCompanies({
      filters,
      page: req.query.page ?? 1,
      size: req.query.size ?? 25,
      sort: 'newest',
    });

    const today = new Date();
    const withAge = results.map((c) => {
      const registered = c.establishedOn ? new Date(c.establishedOn) : null;
      const ageDays = registered
        ? Math.max(0, Math.floor((today - registered) / 86400000))
        : null;
      // VAT registration is a separate, rate-limited lookup — say plainly that
      // it hasn't been done rather than letting the UI guess.
      return { ...c, ageDays, vatStatus: 'unknown' };
    });

    const { vist, skjultAfDig, alleredeGemt } = await fravælg(req.orgId, withAge, {
      udenGemte: filters.excludeExisting,
      medSkjulte: filters.includeHidden,
    });

    return res.json({
      total,
      days,
      since,
      results: vist,
      skjultAfDig,
      alleredeGemt,
      excludesAdvertisingProtected: cvr.EXCLUDE_PROTECTED,
    });
  } catch (err) {
    return handleCvrError(err, res, 'new-companies');
  }
});

// ── Skjulte virksomheder ─────────────────────────────────────────────────────
// "Vis mig ikke den her igen". Adskilt fra leads, fordi det betyder noget
// andet: et lead er nogen man vil tale med, en skjult virksomhed er nogen man
// har set og valgt fra.

// POST /api/hidden  { cvrs: [...] }
router.post('/hidden', authenticate, async (req, res) => {
  const numre = [...new Set(
    (req.body?.cvrs ?? []).map((n) => String(n).replace(/[\s\-.]/g, ''))
      .filter((n) => /^\d{8}$/.test(n))
  )].slice(0, 500);
  if (!numre.length) return res.status(400).json({ error: 'Ingen gyldige CVR-numre.' });

  try {
    const { rowCount } = await db.query(
      `INSERT INTO hidden_companies (org_id, cvr, hidden_by)
       SELECT $1, u.cvr, $2 FROM UNNEST($3::text[]) AS u(cvr)
       ON CONFLICT (org_id, cvr) DO NOTHING`,
      [req.orgId, req.user.id, numre]
    );
    return res.json({ ok: true, skjult: rowCount });
  } catch (err) {
    console.error('[hidden:add]', err.message);
    return res.status(500).json({ error: 'Kunne ikke skjule virksomhederne.' });
  }
});

// DELETE /api/hidden  { cvrs: [...] }  — eller {} for at rydde det hele
router.delete('/hidden', authenticate, async (req, res) => {
  const numre = Array.isArray(req.body?.cvrs)
    ? req.body.cvrs.map((n) => String(n).replace(/[\s\-.]/g, '')).filter((n) => /^\d{8}$/.test(n))
    : null;
  try {
    const { rowCount } = numre?.length
      ? await db.query('DELETE FROM hidden_companies WHERE org_id = $1 AND cvr = ANY($2::text[])',
          [req.orgId, numre])
      : await db.query('DELETE FROM hidden_companies WHERE org_id = $1', [req.orgId]);
    return res.json({ ok: true, fremhentet: rowCount });
  } catch (err) {
    console.error('[hidden:remove]', err.message);
    return res.status(500).json({ error: 'Kunne ikke hente virksomhederne frem igen.' });
  }
});

// GET /api/hidden — hvor mange, så brugerfladen kan tilbyde at vise dem igen
router.get('/hidden', authenticate, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT COUNT(*)::int AS antal FROM hidden_companies WHERE org_id = $1', [req.orgId]
    );
    return res.json({ antal: rows[0].antal });
  } catch (err) {
    console.error('[hidden:count]', err.message);
    return res.status(500).json({ error: 'Kunne ikke hente de skjulte.' });
  }
});

// ── GET /api/search/company/:cvr — single lookup ─────────────────────────────
router.get('/search/company/:cvr', authenticate, searchLimiter, async (req, res) => {
  try {
    const company = await cvr.lookupCompany(req.params.cvr);
    if (!company) return res.status(404).json({ error: 'CVR-nummeret blev ikke fundet.' });
    return res.json({ company });
  } catch (err) {
    return handleCvrError(err, res, 'search:company');
  }
});

module.exports = router;
module.exports.handleCvrError = handleCvrError;
