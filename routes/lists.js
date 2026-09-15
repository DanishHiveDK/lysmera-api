// routes/lists.js — lead lists: create from a CVR extraction, browse, refresh,
// export. A list is a saved search plus the companies it pulled in.
'use strict';

const express = require('express');
const db      = require('../db');
const cvr     = require('../services/cvrService');
const { sanitizeFilters, isEmptyFilter } = require('../services/filterSchema');
const { authenticate } = require('../middleware/auth');
const { handleCvrError } = require('./search');
const { STATUS_VALUES, TERMINAL_STATUSES } = require('../config/cvrOptions');
const { toCsv } = require('../services/csv');
const mailService = require('../services/mailService');
const appUrl = require('../config/appUrl');

const router = express.Router();

const MAX_EXTRACT = 10000;

/**
 * Column ↔ value mapping for a lead row, in one place. The INSERT's column
 * list, its placeholders and the values are all derived from this, so adding
 * a field means editing one line instead of three lists that must stay in
 * lockstep.
 */
const LEAD_INSERT_COLUMNS = [
  ['org_id',             (c, ctx) => ctx.orgId],
  ['list_id',            (c, ctx) => ctx.listId],
  ['cvr',                (c) => c.cvr],
  ['name',               (c) => c.name ?? '(uden navn)'],
  ['address',            (c) => c.address],
  ['zipcode',            (c) => c.zipcode],
  ['city',               (c) => c.city],
  ['municipality',       (c) => c.municipality],
  ['region',             (c) => c.region],
  ['phone',              (c) => c.phone],
  ['email',              (c) => c.email],
  ['website',            (c) => c.website],
  ['industry_code',      (c) => c.industryCode],
  ['industry_text',      (c) => c.industryText],
  ['company_type',       (c) => c.companyType],
  ['employees',          (c) => c.employees],
  ['employees_interval', (c) => c.employeesInterval],
  ['established_on',     (c) => c.establishedOn || null],
  ['owner_name',         (c) => c.ownerName],
  ['owner_role',         (c) => c.ownerRole],
  ['owner_count',        (c) => c.ownerCount],
  ['purpose',            (c) => c.purpose],
  ['capital',            (c) => c.capital],
  ['capital_currency',   (c) => c.capitalCurrency],
  // Er listen sendt til en medarbejder, er nye virksomheder i den også hendes.
  ['assigned_to',        (c, ctx) => ctx.assignedTo],
];

/**
 * Insert a batch of normalised companies into a list.
 * ON CONFLICT DO NOTHING means re-running a search tops the list up instead of
 * duplicating rows or resetting the call statuses already recorded.
 */
/**
 * Hvilke af disse CVR-numre har organisationen allerede som lead — i en
 * hvilken som helst liste?
 *
 * Slås op i databasen frem for at hente alle organisationens numre hjem: en
 * konto kan have hundredtusinder, og vi skal kun bruge svaret for de højst
 * nogle hundrede der er på vej ind.
 */
async function alleredeGemte(kilde, orgId, cvrNumre) {
  const numre = [...new Set(cvrNumre.filter(Boolean).map(String))];
  if (!numre.length) return new Set();
  const { rows } = await kilde.query(
    'SELECT DISTINCT cvr FROM leads WHERE org_id = $1 AND cvr = ANY($2::text[])',
    [orgId, numre]
  );
  return new Set(rows.map((r) => r.cvr));
}

async function insertLeads(client, { orgId, listId, companies }) {
  // Advertising-protected companies are excluded in the CVR query already;
  // this is the second gate so a provider change can't leak them into a list.
  const rows = companies.filter((c) => c.cvr && !c.advertisingProtected);
  if (!rows.length) return 0;

  const { rows: [liste] } = await client.query(
    'SELECT assigned_to FROM lead_lists WHERE id = $1', [listId]);
  const assignedTo = liste?.assigned_to ?? null;

  const width = LEAD_INSERT_COLUMNS.length;
  const values = [];
  const placeholders = rows.map((company, i) => {
    const base = i * width;
    for (const [, read] of LEAD_INSERT_COLUMNS) values.push(read(company, { orgId, listId, assignedTo }));
    return `(${Array.from({ length: width }, (_, j) => `$${base + j + 1}`).join(', ')})`;
  });

  const { rowCount } = await client.query(
    `INSERT INTO leads (${LEAD_INSERT_COLUMNS.map(([col]) => col).join(', ')})
     VALUES ${placeholders.join(', ')}
     ON CONFLICT (list_id, cvr) DO NOTHING`,
    values
  );
  return rowCount;
}

/**
 * Må brugeren se listen? En ejer ser alle organisationens lister. En sælger
 * ser sine egne og dem, der ikke er sendt til nogen. En liste sendt til en
 * kollega er kollegaens, og for alle andre findes den ikke.
 */
function maaSe(req, liste) {
  return req.user.role === 'owner'
    || liste.assigned_to == null
    || liste.assigned_to === req.user.id;
}

/** Listen, hvis den findes i organisationen og brugeren må se den. Ellers null. */
async function hentListe(req, id, kolonner = 'id, name') {
  const { rows } = await db.query(
    `SELECT ${kolonner}, assigned_to FROM lead_lists WHERE id = $1 AND org_id = $2`, [id, req.orgId]);
  return rows[0] && maaSe(req, rows[0]) ? rows[0] : null;
}

/** En aktiv kollega i samme organisation, som en liste kan sendes til. */
async function findModtager(req, id) {
  const n = Number(id);
  if (!Number.isInteger(n)) return null;
  const { rows } = await db.query(
    'SELECT id, name, email FROM users WHERE id = $1 AND org_id = $2 AND is_active', [n, req.orgId]);
  return rows[0] ?? null;
}

/** Mail til medarbejderen om en ny liste. Aldrig til den, der selv sendte den. */
async function giBesked(req, modtager, liste, antal) {
  if (!modtager || modtager.id === req.user.id) return false;
  return mailService.sendListeTildelt({
    til: modtager.email,
    navn: modtager.name,
    listeNavn: liste.name,
    antal,
    tildeltAf: req.user.name,
    link: `${appUrl()}/lister/${liste.id}`,
  });
}

// ── GET /api/lists ───────────────────────────────────────────────────────────
router.get('/lists', authenticate, async (req, res) => {
  const params = [req.orgId, TERMINAL_STATUSES];
  const where = ['l.org_id = $1', 'l.archived_at IS NULL'];

  if (req.user.role !== 'owner') {
    params.push(req.user.id);
    where.push(`(l.assigned_to IS NULL OR l.assigned_to = $${params.length})`);
  } else if (req.query.assignedTo) {
    // Ejeren kan se én medarbejders lister, eller dem der ikke er sendt ud.
    if (req.query.assignedTo === 'none') {
      where.push('l.assigned_to IS NULL');
    } else {
      params.push(Number(req.query.assignedTo) || 0);
      where.push(`l.assigned_to = $${params.length}`);
    }
  }

  try {
    const { rows } = await db.query(
      `SELECT l.id, l.name, l.description, l.filters, l.created_at, l.archived_at,
              l.assigned_to, l.assigned_at, a.name AS assigned_to_name,
              u.name AS created_by_name,
              COUNT(ld.id)                                              AS lead_count,
              COUNT(ld.id) FILTER (WHERE ld.status = 'new')             AS new_count,
              COUNT(ld.id) FILTER (WHERE ld.call_count > 0)             AS called_count,
              COUNT(ld.id) FILTER (WHERE ld.status <> ALL($2::text[])) AS open_count,
              COUNT(ld.id) FILTER (WHERE ld.status IN ('interested','meeting_booked','won')) AS positive_count
         FROM lead_lists l
         LEFT JOIN users u  ON u.id  = l.created_by
         LEFT JOIN users a  ON a.id  = l.assigned_to
         LEFT JOIN leads ld ON ld.list_id = l.id
        WHERE ${where.join(' AND ')}
        GROUP BY l.id, u.name, a.name
        ORDER BY l.created_at DESC`,
      params
    );
    return res.json({ lists: rows });
  } catch (err) {
    console.error('[lists:index]', err.message);
    return res.status(500).json({ error: 'Kunne ikke hente listerne.' });
  }
});

// ── POST /api/lists — run the extraction and save it ─────────────────────────
router.post('/lists', authenticate, async (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  if (!name) return res.status(400).json({ error: 'Giv listen et navn.' });

  // Ejeren kan sende listen til en medarbejder, allerede når den oprettes.
  let modtager = null;
  if (req.body?.assignedTo != null) {
    if (req.user.role !== 'owner') {
      return res.status(403).json({ error: 'Kun ejeren kan sende lister ud.' });
    }
    try {
      modtager = await findModtager(req, req.body.assignedTo);
    } catch (err) {
      console.error('[lists:create:modtager]', err.message);
      return res.status(500).json({ error: 'Kunne ikke oprette listen.' });
    }
    if (!modtager) return res.status(400).json({ error: 'Medarbejderen findes ikke eller er deaktiveret.' });
  }

  // En tom liste at samle enkelte virksomheder i. Filterkravet nedenfor er
  // der for at ingen kan trække hele registret ud ved et uheld — det gælder
  // ikke her, hvor der ikke hentes noget overhovedet.
  if (req.body?.empty === true) {
    try {
      const { rows } = await db.query(
        `INSERT INTO lead_lists (org_id, name, description, filters, created_by, assigned_to, assigned_at)
         VALUES ($1, $2, $3, '{}'::jsonb, $4, $5, CASE WHEN $5::int IS NULL THEN NULL ELSE NOW() END)
         RETURNING id, name, description, filters, created_at, assigned_to`,
        [req.orgId, name, String(req.body?.description ?? '').trim() || null, req.user.id, modtager?.id ?? null]
      );
      return res.status(201).json({ list: rows[0], imported: 0, matched: 0, fetched: 0 });
    } catch (err) {
      console.error('[lists:create:empty]', err.message);
      return res.status(500).json({ error: 'Kunne ikke oprette listen.' });
    }
  }

  const filters = sanitizeFilters(req.body?.filters ?? {});
  if (isEmptyFilter(filters)) {
    return res.status(400).json({
      error: 'Vælg mindst ét filter — branche, område, størrelse eller søgeord.',
      code: 'FILTER_TOO_BROAD',
    });
  }

  const limit = Math.min(Math.max(Number(req.body?.limit) || 1000, 1), MAX_EXTRACT);

  try {
    // Create the list first so each scroll batch can be written straight in
    // rather than buffering the whole extraction in memory.
    const { rows } = await db.query(
      `INSERT INTO lead_lists (org_id, name, description, filters, created_by, assigned_to, assigned_at)
       VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $6::int IS NULL THEN NULL ELSE NOW() END)
       RETURNING id, name, description, filters, created_at, assigned_to`,
      [req.orgId, name, String(req.body?.description ?? '').trim() || null,
       JSON.stringify(filters), req.user.id, modtager?.id ?? null]
    );
    const list = rows[0];

    let inserted = 0;
    let skippedProtected = 0;
    let skippedExisting = 0;
    try {
      const { total, fetched } = await cvr.extractCompanies({
        filters,
        limit,
        onBatch: async (batch) => {
          skippedProtected += batch.filter((c) => c.advertisingProtected).length;
          const client = await db.getClient();
          try {
            let hold = batch;
            // ON CONFLICT fanger kun dubletter i SAMME liste. Vil man ikke se
            // dem man allerede har talt med, skal der kigges på tværs af alle
            // organisationens lister — og det er dét der er værdien: et udtræk
            // på tusind virksomheder man halvdelen af i forvejen har ringet
            // til, er femhundrede spildte opkald.
            if (filters.excludeExisting) {
              const kendte = await alleredeGemte(client, req.orgId, batch.map((c) => c.cvr));
              if (kendte.size) {
                hold = batch.filter((c) => !kendte.has(String(c.cvr)));
                skippedExisting += batch.length - hold.length;
              }
            }
            inserted += await insertLeads(client, { orgId: req.orgId, listId: list.id, companies: hold });
          } finally {
            client.release();
          }
        },
      });

      const mailSendt = inserted > 0 ? await giBesked(req, modtager, list, inserted) : false;

      return res.status(201).json({
        list,
        mailSendt,
        imported: inserted,
        matched: total,
        fetched,
        truncated: total > fetched,
        skippedAdvertisingProtected: skippedProtected,
        skippedExisting,
      });
    } catch (err) {
      // The extraction failed — don't leave an empty list behind for the user
      // to wonder about.
      await db.query('DELETE FROM lead_lists WHERE id = $1 AND org_id = $2', [list.id, req.orgId])
        .catch(() => {});
      throw err;
    }
  } catch (err) {
    return handleCvrError(err, res, 'lists:create');
  }
});

// ── POST /api/lists/:id/refresh — re-run the saved filter, add new companies ─
router.post('/lists/:id/refresh', authenticate, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Ugyldigt liste-id.' });

  try {
    const liste = await hentListe(req, id, 'id, filters');
    if (!liste) return res.status(404).json({ error: 'Listen blev ikke fundet.' });

    const filters = sanitizeFilters(liste.filters ?? {});
    const limit = Math.min(Math.max(Number(req.body?.limit) || 1000, 1), MAX_EXTRACT);

    let inserted = 0;
    const { total, fetched } = await cvr.extractCompanies({
      filters,
      limit,
      onBatch: async (batch) => {
        const client = await db.getClient();
        try {
          inserted += await insertLeads(client, { orgId: req.orgId, listId: id, companies: batch });
        } finally {
          client.release();
        }
      },
    });

    return res.json({ added: inserted, matched: total, fetched });
  } catch (err) {
    return handleCvrError(err, res, 'lists:refresh');
  }
});

// ── GET /api/lists/:id — list with status breakdown ──────────────────────────
router.get('/lists/:id', authenticate, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Ugyldigt liste-id.' });

  try {
    const { rows } = await db.query(
      `SELECT l.id, l.name, l.description, l.filters, l.created_at,
              l.assigned_to, l.assigned_at, a.name AS assigned_to_name
         FROM lead_lists l
         LEFT JOIN users a ON a.id = l.assigned_to
        WHERE l.id = $1 AND l.org_id = $2`,
      [id, req.orgId]
    );
    if (!rows.length || !maaSe(req, rows[0])) return res.status(404).json({ error: 'Listen blev ikke fundet.' });

    const stats = await db.query(
      `SELECT status, COUNT(*)::int AS count FROM leads
        WHERE list_id = $1 AND org_id = $2 GROUP BY status`,
      [id, req.orgId]
    );

    const byStatus = Object.fromEntries(stats.rows.map((r) => [r.status, r.count]));
    const total = stats.rows.reduce((sum, r) => sum + r.count, 0);

    return res.json({ list: rows[0], total, byStatus });
  } catch (err) {
    console.error('[lists:show]', err.message);
    return res.status(500).json({ error: 'Kunne ikke hente listen.' });
  }
});

// ── PATCH /api/lists/:id — omdøb, arkivér eller send til en medarbejder ─────
//
// assignedTo: en kollegas id, eller null for at tage listen tilbage. Kun ejeren.
// Når en liste sendes ud, følger alle dens åbne virksomheder med — også dem
// der før var tildelt en anden. Det er dét, "send listen til Sofie" betyder.
// Tages den tilbage, frigives de åbne virksomheder, der lå hos den tidligere
// medarbejder. Afsluttede leads beholder den, der afsluttede dem.
router.patch('/lists/:id', authenticate, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Ugyldigt liste-id.' });

  const tildeling = req.body?.assignedTo !== undefined;
  if (tildeling && req.user.role !== 'owner') {
    return res.status(403).json({ error: 'Kun ejeren kan sende lister ud.' });
  }

  const sets = [];
  const params = [];
  if (req.body?.name !== undefined) {
    const name = String(req.body.name).trim();
    if (!name) return res.status(400).json({ error: 'Navnet må ikke være tomt.' });
    params.push(name); sets.push(`name = $${params.length}`);
  }
  if (req.body?.description !== undefined) {
    params.push(String(req.body.description).trim() || null);
    sets.push(`description = $${params.length}`);
  }
  if (req.body?.archived !== undefined) {
    sets.push(`archived_at = ${req.body.archived ? 'NOW()' : 'NULL'}`);
  }
  if (!sets.length && !tildeling) return res.status(400).json({ error: 'Ingen ændringer angivet.' });

  try {
    const før = await hentListe(req, id, 'id, name');
    if (!før) return res.status(404).json({ error: 'Listen blev ikke fundet.' });

    let modtager = null;
    if (tildeling && req.body.assignedTo !== null) {
      modtager = await findModtager(req, req.body.assignedTo);
      if (!modtager) return res.status(400).json({ error: 'Medarbejderen findes ikke eller er deaktiveret.' });
    }
    if (tildeling) {
      params.push(modtager?.id ?? null);
      sets.push(`assigned_to = $${params.length}`,
                `assigned_at = CASE WHEN $${params.length}::int IS NULL THEN NULL ELSE NOW() END`);
    }

    const { liste, flyttet } = await db.transaction(async (client) => {
      const { rows } = await client.query(
        `UPDATE lead_lists SET ${sets.join(', ')}
          WHERE id = $${params.length + 1} AND org_id = $${params.length + 2}
          RETURNING id, name, description, archived_at, assigned_to, assigned_at`,
        [...params, id, req.orgId]
      );
      let antal = 0;
      if (tildeling && modtager) {
        ({ rowCount: antal } = await client.query(
          `UPDATE leads SET assigned_to = $1, updated_at = NOW()
            WHERE list_id = $2 AND org_id = $3 AND status <> ALL($4::text[])`,
          [modtager.id, id, req.orgId, TERMINAL_STATUSES]));
      } else if (tildeling && før.assigned_to != null) {
        await client.query(
          `UPDATE leads SET assigned_to = NULL, updated_at = NOW()
            WHERE list_id = $1 AND org_id = $2 AND assigned_to = $3
              AND status <> ALL($4::text[])`,
          [id, req.orgId, før.assigned_to, TERMINAL_STATUSES]);
      }
      return { liste: rows[0], flyttet: antal };
    });

    // Besked kun når listen skifter hænder, ikke ved et navneskifte.
    const nyModtager = tildeling && modtager && modtager.id !== før.assigned_to;
    const mailSendt = nyModtager ? await giBesked(req, modtager, liste, flyttet) : false;

    return res.json({
      list: { ...liste, assigned_to_name: modtager?.name ?? null },
      tildelteLeads: flyttet,
      mailSendt,
    });
  } catch (err) {
    console.error('[lists:patch]', err.message);
    return res.status(500).json({ error: 'Kunne ikke opdatere listen.' });
  }
});

// ── DELETE /api/lists/:id ────────────────────────────────────────────────────
router.delete('/lists/:id', authenticate, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Ugyldigt liste-id.' });
  try {
    if (!(await hentListe(req, id))) return res.status(404).json({ error: 'Listen blev ikke fundet.' });
    const { rowCount } = await db.query(
      'DELETE FROM lead_lists WHERE id = $1 AND org_id = $2', [id, req.orgId]
    );
    if (!rowCount) return res.status(404).json({ error: 'Listen blev ikke fundet.' });
    return res.json({ ok: true });
  } catch (err) {
    console.error('[lists:delete]', err.message);
    return res.status(500).json({ error: 'Kunne ikke slette listen.' });
  }
});

// ── DELETE /api/lists/:id/leads — fjern udvalgte virksomheder ────────────────
// Body: { ids: [1,2,3] }  eller  { filter: { missingEmail: true, status: … } }
//
// To måder at pege på det samme, fordi de bruges forskelligt: `ids` når man har
// hakket nogle stykker af, og `filter` når man vil af med alle uden mail — dér
// kan der være tusinder, og de ligger ikke nødvendigvis på den side man kigger
// på.
router.delete('/lists/:id/leads', authenticate, async (req, res) => {
  const listId = Number(req.params.id);
  if (!Number.isInteger(listId)) return res.status(400).json({ error: 'Ugyldigt liste-id.' });

  const ids = Array.isArray(req.body?.ids)
    ? req.body.ids.map(Number).filter(Number.isInteger).slice(0, 5000)
    : null;
  const filter = req.body?.filter ?? null;

  if (!ids?.length && !filter) {
    return res.status(400).json({ error: 'Vælg hvad der skal slettes.' });
  }

  // org_id står i hver enkelt betingelse. Uden den kunne et gæt på et liste-id
  // fra en anden konto slette deres arbejde.
  const where = ['org_id = $1', 'list_id = $2'];
  const params = [req.orgId, listId];

  if (ids?.length) {
    params.push(ids);
    where.push(`id = ANY($${params.length}::int[])`);
  } else {
    if (filter.missingEmail) where.push("(email IS NULL OR email = '')");
    if (filter.missingPhone) where.push("(phone IS NULL OR phone = '')");
    if (filter.status && STATUS_VALUES.includes(filter.status)) {
      params.push(filter.status);
      where.push(`status = $${params.length}`);
    }
    // Et filter der ikke indsnævrer noget, ville tømme hele listen. Det kan
    // man gøre med vilje ved at slette listen, ikke ved et uheld herfra.
    if (where.length === 2) {
      return res.status(400).json({ error: 'Filteret ville slette hele listen. Slet listen i stedet.' });
    }
  }

  try {
    // Findes listen overhovedet hos denne konto? Uden det svarer et opslag på
    // en fremmed liste 200 med nul slettede, og så kan man ikke se forskel på
    // "intet matchede filteret" og "du peger på en liste der ikke er din".
    // Svaret er det samme i begge tilfælde — findes ikke og er ikke din skal
    // ikke kunne skelnes udefra.
    if (!(await hentListe(req, listId))) return res.status(404).json({ error: 'Listen blev ikke fundet.' });

    const { rowCount } = await db.query(
      `DELETE FROM leads WHERE ${where.join(' AND ')}`, params
    );
    return res.json({ ok: true, slettet: rowCount });
  } catch (err) {
    console.error('[lists:leads:delete]', err.message);
    return res.status(500).json({ error: 'Kunne ikke slette virksomhederne.' });
  }
});

// ── GET /api/lists/:id/leads — paged, filterable ─────────────────────────────
router.get('/lists/:id/leads', authenticate, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Ugyldigt liste-id.' });

  const page = Math.max(Number(req.query.page) || 1, 1);
  const size = Math.min(Math.max(Number(req.query.size) || 50, 1), 200);
  const params = [req.orgId, id];
  const where = ['l.org_id = $1', 'l.list_id = $2'];

  if (req.query.status && STATUS_VALUES.includes(req.query.status)) {
    params.push(req.query.status);
    where.push(`l.status = $${params.length}`);
  }
  if (req.query.assignedTo) {
    params.push(Number(req.query.assignedTo));
    where.push(`l.assigned_to = $${params.length}`);
  }
  if (req.query.q) {
    params.push(`%${String(req.query.q).trim()}%`);
    where.push(`(l.name ILIKE $${params.length} OR l.cvr ILIKE $${params.length})`);
  }

  try {
    if (!(await hentListe(req, id))) return res.status(404).json({ error: 'Listen blev ikke fundet.' });
    const countRes = await db.query(
      `SELECT COUNT(*)::int AS total FROM leads l WHERE ${where.join(' AND ')}`, params
    );
    params.push(size, (page - 1) * size);
    const { rows } = await db.query(
      `SELECT l.*, u.name AS assigned_to_name
         FROM leads l
         LEFT JOIN users u ON u.id = l.assigned_to
        WHERE ${where.join(' AND ')}
        ORDER BY l.status = 'new' DESC, l.employees DESC NULLS LAST, l.name
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    return res.json({ leads: rows, total: countRes.rows[0].total, page, size });
  } catch (err) {
    console.error('[lists:leads]', err.message);
    return res.status(500).json({ error: 'Kunne ikke hente leads.' });
  }
});

// ── GET /api/lists/:id/export.csv ────────────────────────────────────────────
router.get('/lists/:id/export.csv', authenticate, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Ugyldigt liste-id.' });

  const params = [req.orgId, id];
  const where = ['l.org_id = $1', 'l.list_id = $2'];
  if (req.query.status && STATUS_VALUES.includes(req.query.status)) {
    params.push(req.query.status);
    where.push(`l.status = $${params.length}`);
  }

  try {
    const listeRække = await hentListe(req, id);
    if (!listeRække) return res.status(404).json({ error: 'Listen blev ikke fundet.' });

    const { rows } = await db.query(
      `SELECT l.cvr, l.name, l.address, l.zipcode, l.city, l.municipality, l.phone,
              l.email, l.website, l.industry_code, l.industry_text, l.company_type,
              l.employees, l.established_on, l.status, l.call_count, l.last_called_at,
              l.next_callback_at, u.name AS assigned_to_name,
              (SELECT a.body FROM lead_activities a
                WHERE a.lead_id = l.id AND a.body IS NOT NULL
                ORDER BY a.created_at DESC LIMIT 1) AS latest_note
         FROM leads l
         LEFT JOIN users u ON u.id = l.assigned_to
        WHERE ${where.join(' AND ')}
        ORDER BY l.name`,
      params
    );

    const csv = toCsv(rows, [
      ['cvr', 'CVR'], ['name', 'Virksomhed'], ['address', 'Adresse'],
      ['zipcode', 'Postnr'], ['city', 'By'], ['municipality', 'Kommune'],
      ['phone', 'Telefon'], ['email', 'E-mail'], ['website', 'Hjemmeside'],
      ['industry_code', 'Branchekode'], ['industry_text', 'Branche'],
      ['company_type', 'Selskabsform'], ['employees', 'Ansatte'],
      ['established_on', 'Stiftet'], ['status', 'Status'],
      ['call_count', 'Antal opkald'], ['last_called_at', 'Sidst ringet'],
      ['next_callback_at', 'Genopkald'], ['assigned_to_name', 'Tildelt'],
      ['latest_note', 'Seneste note'],
    ]);

    const safeName = listeRække.name.replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 60);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition',
      `attachment; filename="lysmera_${safeName}.csv"; filename*=UTF-8''lysmera_${encodeURIComponent(safeName)}.csv`);
    return res.send(csv);
  } catch (err) {
    console.error('[lists:export]', err.message);
    return res.status(500).json({ error: 'Kunne ikke eksportere listen.' });
  }
});

// ── POST /api/lists/:id/leads — læg én virksomhed i en liste ─────────────────
// Kernen i produktet: brugeren finder en relevant virksomhed og gemmer netop
// den, frem for at skulle tage et helt udtræk med.
router.post('/lists/:id/leads', authenticate, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Ugyldigt liste-id.' });

  // Flere ad gangen — fra en markering på søgesiden. Samme regler som ved én:
  // virksomhederne hentes fra registret, og reklamebeskyttede kommer ikke med.
  if (Array.isArray(req.body?.cvrs)) {
    const numre = [...new Set(
      req.body.cvrs.map((n) => String(n).replace(/[\s\-.]/g, '')).filter((n) => /^\d{8}$/.test(n))
    )].slice(0, 200);
    if (!numre.length) return res.status(400).json({ error: 'Ingen gyldige CVR-numre.' });

    try {
      const liste = await hentListe(req, id);
      if (!liste) return res.status(404).json({ error: 'Listen blev ikke fundet.' });

      const fundne = await cvr.lookupCompanies(numre);
      const beskyttede = fundne.filter((c) => c.advertisingProtected);
      const brugbare  = fundne.filter((c) => !c.advertisingProtected);

      const client = await db.getClient();
      let indsat = 0;
      try {
        indsat = await insertLeads(client, { orgId: req.orgId, listId: id, companies: brugbare });
      } finally {
        client.release();
      }

      return res.status(201).json({
        list: { id: liste.id, name: liste.name },
        // Fire tal frem for ét, fordi forskellen mellem dem er det brugeren
        // spørger om når listen ikke voksede så meget som forventet.
        tilføjet: indsat,
        laaAllerede: brugbare.length - indsat,
        reklamebeskyttede: beskyttede.length,
        ikkeFundet: numre.length - fundne.length,
      });
    } catch (err) {
      return handleCvrError(err, res, 'lists:leads:bulk');
    }
  }

  const cvrNummer = String(req.body?.cvr ?? '').replace(/[\s\-.]/g, '');
  if (!/^\d{8}$/.test(cvrNummer)) {
    return res.status(400).json({ error: 'Et dansk CVR-nummer er 8 cifre.' });
  }

  try {
    const liste = await hentListe(req, id);
    if (!liste) return res.status(404).json({ error: 'Listen blev ikke fundet.' });

    // Virksomheden hentes fra registret, ikke fra det klienten sender. Ellers
    // kunne hvad som helst lægges i en liste og se ud som CVR-data bagefter.
    const firma = await cvr.lookupCompany(cvrNummer);
    if (!firma) {
      return res.status(404).json({ error: 'Vi kunne ikke finde en virksomhed med det CVR-nummer.' });
    }

    // Reklamebeskyttelse er et lovkrav, ikke en indstilling. insertLeads
    // frasorterer dem allerede, men tavst — og her har brugeren peget på
    // netop denne virksomhed og skal vide hvorfor den ikke kan gemmes.
    if (firma.advertisingProtected) {
      return res.status(422).json({
        error: `${firma.name} er reklamebeskyttet i CVR og må ikke kontaktes med markedsføring.`,
        code: 'ADVERTISING_PROTECTED',
      });
    }

    const client = await db.getClient();
    let indsat;
    try {
      indsat = await insertLeads(client, {
        orgId: req.orgId, listId: id, companies: [firma],
      });
    } finally {
      client.release();
    }

    // Nul betyder at den lå der i forvejen — ikke at noget gik galt.
    return res.status(indsat ? 201 : 200).json({
      added: indsat > 0,
      alreadyOnList: indsat === 0,
      company: { cvr: firma.cvr, name: firma.name },
      list: { id: liste.id, name: liste.name },
    });
  } catch (err) {
    return handleCvrError(err, res, 'lists:addLead');
  }
});

module.exports = router;
