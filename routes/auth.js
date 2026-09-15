// routes/auth.js — login, session and team management.
'use strict';

const express  = require('express');
const crypto   = require('crypto');
const bcrypt   = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { TERMINAL_STATUSES } = require('../config/cvrOptions');
const db       = require('../db');
const appUrl   = require('../config/appUrl');
const cvrService = require('../services/cvrService');
const stripeService = require('../services/stripeService');
const mailService = require('../services/mailService');
const { erPlatformAdmin } = require('../middleware/platformAdmin');
const { erFritaget, GRATIS_TEAMPLADSER } = require('../middleware/subscription');
const { authenticate, requireOwner, signToken } = require('../middleware/auth');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'For mange loginforsøg. Prøv igen om 15 minutter.' },
});

// Oprettelse er åben, så den eneste bremse er denne. Loftet er sat så en
// almindelig bruger aldrig rammer det, men et script ikke kan lave hundredvis
// af organisationer på jeres Virk-aftale.
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  // Kun oprettelser der lykkes tæller med. Ellers ville en bruger, der taster
  // en for kort adgangskode et par gange, bruge sit loft på forsøg der ikke
  // har oprettet noget — og det er de oprettede organisationer, ikke de
  // afviste forsøg, der belaster Virk-aftalen.
  skipFailedRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'For mange oprettelser fra denne forbindelse. Prøv igen om en time.' },
});

// Opslag under oprettelsen sker mens brugeren taster, så loftet er højere end
// for selve oprettelsen — men det er stadig vores Virk-aftale der betaler.
const lookupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'For mange opslag. Prøv igen om lidt.' },
});

// Invitationslinket er åbent for alle der har det. Loftet er sat, så en
// tilfældig token ikke kan gættes ved at prøve sig frem.
const invitationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'For mange forsøg. Prøv igen om lidt.' },
});

// ── POST /api/auth/login ─────────────────────────────────────────────────────
router.post('/login', loginLimiter, async (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const password = String(req.body?.password ?? '');

  if (!email || !password) {
    return res.status(400).json({ error: 'Udfyld både e-mail og adgangskode.' });
  }

  try {
    const { rows } = await db.query(
      `SELECT u.id, u.org_id, u.email, u.name, u.role, u.password_hash, u.is_active,
              o.name AS org_name
         FROM users u
         JOIN organizations o ON o.id = u.org_id
        WHERE LOWER(u.email) = $1`,
      [email]
    );
    const user = rows[0];

    // Same response whether the address is unknown or the password is wrong —
    // otherwise this endpoint tells an attacker which emails exist.
    const ok = user && user.is_active && await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'Forkert e-mail eller adgangskode.' });
    }

    await db.query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);

    return res.json({
      token: signToken(user),
      user: {
        id: user.id, name: user.name, email: user.email, role: user.role,
        orgId: user.org_id, orgName: user.org_name,
        // Adgang til admin-siden. Sendes med, så frontenden ved om linket skal
        // vises — men API'et afgør selv adgangen ved hvert kald.
        platformAdmin: erPlatformAdmin(user.email),
      },
    });
  } catch (err) {
    console.error('[auth:login]', err.message);
    return res.status(500).json({ error: 'Login mislykkedes. Prøv igen.' });
  }
});

// ── GET /api/auth/cvr/:nummer — slå firmanavn op under oprettelsen ───────────
// Så brugeren kan se hvilken virksomhed nummeret hører til, før der oprettes
// noget. Åbent endpoint, men det udstiller kun hvad CVR-registret allerede
// offentliggør.
router.get('/cvr/:nummer', lookupLimiter, async (req, res) => {
  try {
    const firma = await cvrService.lookupCompany(req.params.nummer);
    if (!firma) {
      return res.status(404).json({ error: 'Vi kunne ikke finde en virksomhed med det CVR-nummer.' });
    }
    return res.json({ company: { cvr: firma.cvr, name: firma.name, city: firma.city ?? null } });
  } catch (err) {
    if (err instanceof cvrService.CvrError) {
      return res.status(err.status || 502).json({ error: err.message, code: err.code });
    }
    console.error('[auth:cvr]', err.message);
    return res.status(500).json({ error: 'Opslaget mislykkedes. Prøv igen.' });
  }
});

// ── POST /api/auth/register — selvbetjent oprettelse ─────────────────────────
// Opretter en ny organisation med den nye bruger som ejer. Der er ingen
// invitation og ingen godkendelse: enhver med et gyldigt CVR-nummer kan komme
// i gang. Nummeret slås op i registret og kan kun bruges én gang, så den samme
// virksomhed ikke kan tage en ny prøveperiode med en ny mailadresse.
router.post('/register', registerLimiter, async (req, res) => {
  const name     = String(req.body?.name ?? '').trim();
  const cvr      = String(req.body?.cvr ?? '').replace(/[\s\-.]/g, '');
  const email    = String(req.body?.email ?? '').trim().toLowerCase();
  const password = String(req.body?.password ?? '');

  if (!name || !cvr || !email || !password) {
    return res.status(400).json({ error: 'Navn, CVR-nummer, e-mail og adgangskode skal udfyldes.' });
  }
  if (!/^\d{8}$/.test(cvr)) {
    return res.status(400).json({ error: 'Et dansk CVR-nummer er 8 cifre.' });
  }
  // Bevidst løs kontrol: der findes gyldige adresser som et strengere mønster
  // ville afvise. Formålet er at fange tastefejl, ikke at validere e-mail.
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'Skriv en gyldig e-mailadresse.' });
  }
  if (password.length < 10) {
    return res.status(400).json({ error: 'Adgangskoden skal være mindst 10 tegn.' });
  }

  // Ekstra brugere valgt ved oprettelsen. De betales først, når abonnementet
  // tegnes; indtil da er tallet et ønske, som checkout tager med.
  const pladser = Number(req.body?.pladser ?? 0);
  if (!Number.isInteger(pladser) || pladser < 0 || pladser > stripeService.MAKS_PLADSER) {
    return res.status(400).json({ error: `Vælg mellem 0 og ${stripeService.MAKS_PLADSER} ekstra brugere.` });
  }

  // Slå nummeret op før der oprettes noget. Findes virksomheden ikke, er
  // nøglen til "én prøveperiode per virksomhed" værdiløs.
  let firma;
  try {
    firma = await cvrService.lookupCompany(cvr);
  } catch (err) {
    if (err instanceof cvrService.CvrError) {
      // Registret er nede. Vi kunne lade oprettelsen gå igennem uden opslag,
      // men så ville et opdigtet nummer slippe forbi netop mens ingen kan se
      // det — og det er præcis hullet det hele skal lukke.
      return res.status(err.status || 502).json({
        error: 'Vi kan ikke nå CVR-registret lige nu, så oprettelsen må vente et øjeblik. Prøv igen om lidt.',
        code: err.code,
      });
    }
    console.error('[auth:register:cvr]', err.message);
    return res.status(500).json({ error: 'Kunne ikke oprette kontoen. Prøv igen.' });
  }
  if (!firma) {
    return res.status(404).json({ error: 'Vi kunne ikke finde en virksomhed med det CVR-nummer.' });
  }

  try {
    const hash = await bcrypt.hash(password, 12);

    // Organisation og ejer hører sammen: uden transaktionen kunne en optaget
    // e-mail efterlade en tom organisation uden brugere.
    const user = await db.transaction(async (client) => {
      // Navnet tages fra registret, ikke fra brugeren. Det er både mere
      // korrekt og ét felt mindre at udfylde.
      const org = await client.query(
        'INSERT INTO organizations (name, cvr, requested_seats) VALUES ($1, $2, $3) RETURNING id, name',
        [firma.name, cvr, pladser]
      );
      const created = await client.query(
        `INSERT INTO users (org_id, email, password_hash, name, role)
         VALUES ($1, $2, $3, $4, 'owner')
         RETURNING id, org_id, email, name, role`,
        [org.rows[0].id, email, hash, name]
      );
      return { ...created.rows[0], org_name: org.rows[0].name };
    });

    return res.status(201).json({
      token: signToken(user),
      user: {
        id: user.id, name: user.name, email: user.email, role: user.role,
        orgId: user.org_id, orgName: user.org_name,
        platformAdmin: erPlatformAdmin(user.email),
      },
    });
  } catch (err) {
    if (err.code === '23505') {
      // Hvilken af de to nøgler der ramte, afgør hvad brugeren skal gøre:
      // logge ind, eller kontakte den kollega der allerede har oprettet firmaet.
      if (err.constraint === 'organizations_cvr_key') {
        return res.status(409).json({
          error: 'Der findes allerede en konto for den virksomhed. Bed din kollega om at invitere dig.',
          code: 'CVR_TAKEN',
        });
      }
      return res.status(409).json({ error: 'Der findes allerede en konto med den e-mail.' });
    }
    console.error('[auth:register]', err.message);
    return res.status(500).json({ error: 'Kunne ikke oprette kontoen. Prøv igen.' });
  }
});

// ── GET /api/auth/me ─────────────────────────────────────────────────────────
router.get('/me', authenticate, async (req, res) => {
  try {
    const { rows } = await db.query('SELECT name FROM organizations WHERE id = $1', [req.orgId]);
    return res.json({
      user: {
        id: req.user.id, name: req.user.name, email: req.user.email,
        role: req.user.role, orgId: req.orgId, orgName: rows[0]?.name ?? null,
        platformAdmin: erPlatformAdmin(req.user.email),
      },
    });
  } catch (err) {
    console.error('[auth:me]', err.message);
    return res.status(500).json({ error: 'Kunne ikke hente brugeren.' });
  }
});

// ── PATCH /api/auth/me — din egen profil ─────────────────────────────────────
// Navn og e-mail. Adgangskoden har sin egen rute: den kræver den nuværende
// kode, og det krav må ikke kunne omgås ved at sende feltet med her.
router.patch('/me', authenticate, async (req, res) => {
  const navn  = String(req.body?.name ?? '').trim();
  const email = String(req.body?.email ?? '').trim().toLowerCase();

  if (!navn) return res.status(400).json({ error: 'Navnet skal udfyldes.' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'Skriv en gyldig e-mailadresse.' });
  }

  try {
    const { rows } = await db.query(
      `UPDATE users SET name = $1, email = $2 WHERE id = $3
       RETURNING id, org_id, email, name, role`,
      [navn, email, req.user.id]
    );
    const bruger = rows[0];
    const { rows: org } = await db.query(
      'SELECT name FROM organizations WHERE id = $1', [bruger.org_id]);

    // Nyt token: navn og e-mail står i nyttelasten, og et token med det gamle
    // navn ville få brugerfladen til at vise det gamle indtil næste login.
    return res.json({
      token: signToken(bruger),
      user: {
        id: bruger.id, name: bruger.name, email: bruger.email, role: bruger.role,
        orgId: bruger.org_id, orgName: org[0]?.name ?? null,
        platformAdmin: erPlatformAdmin(bruger.email),
      },
    });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Den e-mail er allerede i brug.' });
    }
    console.error('[auth:me:patch]', err.message);
    return res.status(500).json({ error: 'Kunne ikke gemme profilen.' });
  }
});

// ── GET /api/auth/team — colleagues, for the "assigned to" pickers ───────────
router.get('/team', authenticate, async (req, res) => {
  try {
    // Lister og åbne leads pr. medarbejder: ejerens overblik over, hvem der
    // har hvilke ringelister.
    const { rows } = await db.query(
      `SELECT u.id, u.name, u.email, u.role, u.is_active, u.last_login_at,
              (SELECT COUNT(*)::int FROM lead_lists ll
                WHERE ll.org_id = u.org_id AND ll.assigned_to = u.id
                  AND ll.archived_at IS NULL)                  AS lister,
              (SELECT COUNT(*)::int FROM leads l
                WHERE l.org_id = u.org_id AND l.assigned_to = u.id
                  AND l.status <> ALL($2::text[]))             AS aabne_leads
         FROM users u WHERE u.org_id = $1 ORDER BY u.name`,
      [req.orgId, TERMINAL_STATUSES]
    );
    return res.json({ users: rows });
  } catch (err) {
    console.error('[auth:team]', err.message);
    return res.status(500).json({ error: 'Kunne ikke hente teamet.' });
  }
});

/**
 * Pladserne på en konto: hvor mange der er, hvor mange der er brugt, og om
 * der er flere tilbage.
 *
 * Pladserne er forudbetalte. En konto har ejerens plads plus de ekstra
 * pladser, der er købt i Stripe, eller, før abonnementet er tegnet, dem der
 * blev valgt ved oprettelsen. En fritagen konto har i stedet de gratis
 * teampladser.
 *
 * Afventende invitationer tæller med. Ellers kunne ejeren invitere tyve og
 * først opdage loftet når den sjette sagde ja — og så ville de fjorten andre
 * have et link der ikke virker.
 */
async function pladsOverblik(orgId) {
  const { rows } = await db.query(
    `SELECT (SELECT u.email FROM users u
              WHERE u.org_id = o.id AND u.role = 'owner'
              ORDER BY u.id LIMIT 1)                              AS ejer_email,
            (SELECT COUNT(*)::int FROM users u
              WHERE u.org_id = o.id AND u.is_active)              AS aktive,
            (SELECT COUNT(*)::int FROM team_invitations i
              WHERE i.org_id = o.id AND i.status = 'pending'
                AND i.expires_at > NOW())                         AS afventende,
            o.paid_seats, o.requested_seats, o.stripe_subscription_id AS abonnement
       FROM organizations o WHERE o.id = $1`,
    [orgId]
  );
  const r = rows[0] ?? { aktive: 0, afventende: 0, paid_seats: 0, requested_seats: 0, abonnement: null };
  const fri = erFritaget(r.ejer_email);
  const koebte = fri ? 0 : (r.abonnement ? r.paid_seats : r.requested_seats);
  const loft = fri
    ? 1 + GRATIS_TEAMPLADSER
    : stripeService.PLADSER_INKLUDERET + koebte;
  const brugt = r.aktive + r.afventende;

  return {
    fri,
    loft,
    koebte,
    gratisPladser: fri ? GRATIS_TEAMPLADSER : 0,
    aktive: r.aktive,
    afventende: r.afventende,
    brugt,
    ledige: Math.max(0, loft - brugt),
  };
}

/** Er der plads til én mere? Svarer med den besked brugeren skal se. */
async function afvisHvisFuldt(orgId) {
  const plads = await pladsOverblik(orgId);
  if (plads.ledige >= 1) return null;
  if (plads.fri) {
    return {
      error: `Kontoen har ${plads.gratisPladser} gratis teampladser ud over dig selv, `
           + 'og de er brugt. Deaktivér et medlem eller træk en invitation tilbage først.',
      code: 'FREE_SEATS_EXCEEDED',
    };
  }
  return {
    error: `Alle ${plads.loft} pladser er i brug. Køb flere pladser under Medlemskab, `
         + 'eller deaktivér et medlem eller træk en invitation tilbage.',
    code: 'NO_SEATS',
    plads,
  };
}

// ── POST /api/auth/team — owner invites a colleague ──────────────────────────
router.post('/team', authenticate, requireOwner, async (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const name = String(req.body?.name ?? '').trim();
  const password = String(req.body?.password ?? '');
  const role = req.body?.role === 'owner' ? 'owner' : 'agent';

  if (!email || !name || !password) {
    return res.status(400).json({ error: 'Navn, e-mail og adgangskode skal udfyldes.' });
  }
  if (password.length < 10) {
    return res.status(400).json({ error: 'Adgangskoden skal være mindst 10 tegn.' });
  }

  try {
    const fuldt = await afvisHvisFuldt(req.orgId);
    if (fuldt) return res.status(409).json(fuldt);

    const hash = await bcrypt.hash(password, 12);
    const { rows } = await db.query(
      `INSERT INTO users (org_id, email, password_hash, name, role)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, email, role, is_active`,
      [req.orgId, email, hash, name, role]
    );
    return res.status(201).json({ user: rows[0], plads: await pladsOverblik(req.orgId) });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Den e-mail er allerede i brug.' });
    }
    console.error('[auth:team:create]', err.message);
    return res.status(500).json({ error: 'Kunne ikke oprette brugeren.' });
  }
});

// ── PATCH /api/auth/team/:id — et medlems profil og adgang ───────────────────
//
// Navn, e-mail, rolle og aktiv/inaktiv. Ejeren retter kollegaens stavefejl og
// skifter rollen samme sted som adgangen slås til og fra — det er den samme
// beslutning om den samme person.
//
// Adgangskoden er IKKE med. Den kan kun skiftes af den det handler om, og kun
// mod den nuværende kode. Kunne ejeren sætte en ny, kunne ejeren også logge
// ind som kollegaen — og så var det ikke længere kollegaens underskrift på de
// noter og opkald der står i hendes navn.
router.patch('/team/:id', authenticate, requireOwner, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Ugyldigt bruger-id.' });

  const egenRække = id === req.user.id;
  const har = (felt) => Object.prototype.hasOwnProperty.call(req.body ?? {}, felt);

  // Kun de felter der rent faktisk er sendt med. Et PATCH der sætter alt det
  // andet tilbage til en standardværdi ville gøre et navneskifte til en
  // genaktivering.
  const sæt = {};

  if (har('name')) {
    const navn = String(req.body.name ?? '').trim();
    if (!navn) return res.status(400).json({ error: 'Navnet skal udfyldes.' });
    sæt.name = navn;
  }
  if (har('email')) {
    const email = String(req.body.email ?? '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: 'Skriv en gyldig e-mailadresse.' });
    }
    sæt.email = email;
  }
  if (har('role')) {
    if (!['owner', 'agent'].includes(req.body.role)) {
      return res.status(400).json({ error: 'Ukendt rolle.' });
    }
    if (egenRække) {
      // Ellers kunne den eneste ejer degradere sig selv og efterlade kontoen
      // uden nogen der kan rette op på det.
      return res.status(400).json({ error: 'Du kan ikke ændre din egen rolle.' });
    }
    sæt.role = req.body.role;
  }
  if (har('isActive')) {
    if (egenRække) {
      return res.status(400).json({ error: 'Du kan ikke deaktivere dig selv.' });
    }
    sæt.is_active = req.body.isActive !== false;
  }

  if (!Object.keys(sæt).length) {
    return res.status(400).json({ error: 'Der var intet at ændre.' });
  }

  try {
    const { rows: nuværende } = await db.query(
      'SELECT id, role, is_active FROM users WHERE id = $1 AND org_id = $2', [id, req.orgId]);
    if (!nuværende.length) return res.status(404).json({ error: 'Brugeren blev ikke fundet.' });
    const før = nuværende[0];

    // Genaktivering er også en plads der tages. Uden kontrollen her kunne
    // loftet omgås ved at slukke og tænde for medlemmer på skift.
    if (sæt.is_active === true && !før.is_active) {
      const fuldt = await afvisHvisFuldt(req.orgId);
      if (fuldt) return res.status(409).json(fuldt);
    }

    // Der kan ikke blive nul ejere ad denne vej: den der kalder, ER en aktiv
    // ejer (requireOwner + authenticate), og sin egen rolle og adgang kan man
    // ikke røre. Derfor ingen kontrol af "sidste ejer" her — den ville aldrig
    // kunne udløses, og en kontrol der aldrig fanger noget, er en kontrol man
    // tror på uden grund.

    const kolonner = Object.keys(sæt);
    const { rows } = await db.query(
      `UPDATE users SET ${kolonner.map((k, i) => `${k} = $${i + 1}`).join(', ')}
        WHERE id = $${kolonner.length + 1} AND org_id = $${kolonner.length + 2}
        RETURNING id, name, email, role, is_active`,
      [...kolonner.map((k) => sæt[k]), id, req.orgId]
    );
    return res.json({ user: rows[0], plads: await pladsOverblik(req.orgId) });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Den e-mail er allerede i brug.' });
    }
    console.error('[auth:team:patch]', err.message);
    return res.status(500).json({ error: 'Kunne ikke opdatere brugeren.' });
  }
});

// ═══ Invitationer ════════════════════════════════════════════════════════════
//
// En invitation er knyttet til en e-mailadresse, ikke til en bruger: den
// inviterede har som regel ingen konto endnu. Derfor to veje ind:
//
//   1. Har hun en konto, ligger invitationen på hendes eget overblik og kan
//      accepteres derfra. Det er den vej der ikke kræver at en mail kommer
//      frem.
//   2. Har hun ikke, følger hun linket, vælger en adgangskode og er inde.
//      Ingen CVR-nummer undervejs — hun opretter ikke en virksomhed, hun
//      bliver en del af en der findes.

const INVITATION_KOLONNER = `i.id, i.email, i.name, i.role, i.status,
                             i.created_at, i.expires_at, i.responded_at`;

const invitationsLink = (token) => `${appUrl()}/invitation/${token}`;

// ── GET /api/auth/team/invitations — hvem er inviteret? ──────────────────────
router.get('/team/invitations', authenticate, requireOwner, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT ${INVITATION_KOLONNER},
              i.expires_at <= NOW() AS udloebet,
              u.name AS inviteret_af,
              -- Kun åbne invitationer har et link at kopiere. En brugt eller
              -- tilbagekaldt token skal ikke kunne sendes videre ved en fejl.
              CASE WHEN i.status = 'pending' AND i.expires_at > NOW()
                   THEN i.token END AS token
         FROM team_invitations i
         LEFT JOIN users u ON u.id = i.invited_by
        WHERE i.org_id = $1
          AND (i.status = 'pending' OR i.created_at > NOW() - INTERVAL '30 days')
        ORDER BY (i.status = 'pending') DESC, i.created_at DESC`,
      [req.orgId]
    );

    return res.json({
      invitations: rows.map(({ token, ...r }) => ({
        ...r,
        link: token ? invitationsLink(token) : null,
      })),
      plads: await pladsOverblik(req.orgId),
    });
  } catch (err) {
    console.error('[auth:invitations:list]', err.message);
    return res.status(500).json({ error: 'Kunne ikke hente invitationerne.' });
  }
});

// ── POST /api/auth/team/invitations — invitér med navn og e-mail ─────────────
router.post('/team/invitations', authenticate, requireOwner, async (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const name  = String(req.body?.name ?? '').trim();
  const role  = req.body?.role === 'owner' ? 'owner' : 'agent';

  if (!name || !email) {
    return res.status(400).json({ error: 'Skriv både navn og e-mail.' });
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'Skriv en gyldig e-mailadresse.' });
  }

  try {
    // Er hun allerede med i teamet, er invitationen en fejltagelse — og et
    // link der aldrig ville kunne bruges til noget.
    const { rows: findes } = await db.query(
      'SELECT 1 FROM users WHERE org_id = $1 AND LOWER(email) = $2', [req.orgId, email]);
    if (findes.length) {
      return res.status(409).json({ error: 'Den person er allerede med i jeres team.' });
    }

    const fuldt = await afvisHvisFuldt(req.orgId);
    if (fuldt) return res.status(409).json(fuldt);

    // 32 tilfældige bytes. base64url, så den kan stå i en URL uden at blive
    // kodet om undervejs og dermed ikke længere passe på den i databasen.
    const token = crypto.randomBytes(32).toString('base64url');

    const { rows } = await db.query(
      `INSERT INTO team_invitations (org_id, email, name, role, token, invited_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, email, name, role, status, created_at, expires_at`,
      [req.orgId, email, name, role, token, req.user.id]
    );

    // Mailen er en genvej, ikke selve invitationen: den ligger i databasen og
    // kan ses på modtagerens eget overblik. Fejler afsendelsen — eller er der
    // slet ingen mailudbyder sat op — oprettes invitationen alligevel, og
    // ejeren får linket at sende selv.
    const { rows: org } = await db.query(
      'SELECT name FROM organizations WHERE id = $1', [req.orgId]);

    const sendt = await mailService.sendInvitation({
      til: email,
      navn: name,
      orgNavn: org[0]?.name ?? 'Lysmera',
      inviteretAf: req.user.name,
      link: invitationsLink(token),
    });

    return res.status(201).json({
      invitation: { ...rows[0], link: invitationsLink(token) },
      mailSendt: sendt,
      plads: await pladsOverblik(req.orgId),
    });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({
        error: 'Der er allerede sendt en invitation til den adresse.',
        code: 'INVITATION_EXISTS',
      });
    }
    console.error('[auth:invitations:create]', err.message);
    return res.status(500).json({ error: 'Kunne ikke oprette invitationen.' });
  }
});

// ── DELETE /api/auth/team/invitations/:id — træk den tilbage ─────────────────
router.delete('/team/invitations/:id', authenticate, requireOwner, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Ugyldig invitation.' });

  try {
    // Rækken bliver stående med status 'revoked'. Slettede vi den, ville
    // linket blot give "findes ikke", og ejeren kunne ikke se at der havde
    // været en invitation at trække tilbage.
    const { rows } = await db.query(
      `UPDATE team_invitations SET status = 'revoked', responded_at = NOW()
        WHERE id = $1 AND org_id = $2 AND status = 'pending'
        RETURNING id`,
      [id, req.orgId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Invitationen blev ikke fundet.' });
    return res.json({ ok: true, plads: await pladsOverblik(req.orgId) });
  } catch (err) {
    console.error('[auth:invitations:revoke]', err.message);
    return res.status(500).json({ error: 'Kunne ikke trække invitationen tilbage.' });
  }
});

// ── GET /api/auth/invitations — er der noget til MIG? ────────────────────────
// Frontenden spørger her ved hvert sideskift og viser beskeden øverst.
router.get('/invitations', authenticate, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT i.id, i.role, i.created_at, i.expires_at,
              o.name AS org_navn, u.name AS inviteret_af
         FROM team_invitations i
         JOIN organizations o ON o.id = i.org_id
         LEFT JOIN users u ON u.id = i.invited_by
        WHERE LOWER(i.email) = LOWER($1)
          AND i.status = 'pending' AND i.expires_at > NOW()
          -- Invitationer til det team man allerede er i, er der intet at
          -- svare på. De kan opstå hvis ejeren inviterer en kollega der
          -- lige er kommet ind ad en anden vej.
          AND i.org_id <> $2
        ORDER BY i.created_at DESC`,
      [req.user.email, req.orgId]
    );
    return res.json({ invitations: rows });
  } catch (err) {
    console.error('[auth:invitations:mine]', err.message);
    return res.status(500).json({ error: 'Kunne ikke hente invitationer.' });
  }
});

// ── POST /api/auth/invitations/:id/accept — sig ja, som eksisterende bruger ──
router.post('/invitations/:id/accept', authenticate, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Ugyldig invitation.' });

  try {
    const { rows } = await db.query(
      `SELECT i.id, i.org_id, i.role, o.name AS org_navn
         FROM team_invitations i
         JOIN organizations o ON o.id = i.org_id
        WHERE i.id = $1 AND LOWER(i.email) = LOWER($2)
          AND i.status = 'pending' AND i.expires_at > NOW()`,
      [id, req.user.email]
    );
    const inv = rows[0];
    if (!inv) {
      return res.status(404).json({ error: 'Invitationen er ikke længere gyldig.' });
    }

    const gammelOrgId = req.orgId;

    if (inv.org_id === gammelOrgId) {
      await db.query(
        `UPDATE team_invitations SET status = 'accepted', responded_at = NOW() WHERE id = $1`, [id]);
      return res.json({ ok: true, flyttet: false });
    }

    const fuldt = await afvisHvisFuldt(inv.org_id);
    if (fuldt) {
      return res.status(409).json({
        error: 'Der er ikke flere pladser i det team lige nu. Sig til den der inviterede dig.',
        code: fuldt.code,
      });
    }

    // En bruger hører til én organisation. At sige ja er derfor at forlade
    // den, man står i — og er man den sidste, bliver den tilbage uden en
    // eneste bruger. Er der noget i den, ville det være tabt bag et login der
    // ikke findes mere, så dét siger vi nej til frem for at slette i stilhed.
    const { rows: gamle } = await db.query(
      `SELECT o.name,
              o.stripe_subscription_id AS sub,
              (SELECT COUNT(*)::int FROM users u WHERE u.org_id = o.id AND u.id <> $2) AS andre,
              (SELECT COUNT(*)::int FROM leads l WHERE l.org_id = o.id)                AS leads,
              (SELECT COUNT(*)::int FROM lead_lists ll WHERE ll.org_id = o.id)         AS lister
         FROM organizations o WHERE o.id = $1`,
      [gammelOrgId, req.user.id]
    );
    const gammel = gamle[0] ?? { andre: 0, leads: 0, lister: 0, sub: null };
    const sidsteMand = gammel.andre === 0;

    if (sidsteMand && (gammel.leads > 0 || gammel.lister > 0 || gammel.sub)) {
      return res.status(409).json({
        error: `Du er den eneste bruger på ${gammel.name}, og der ligger lister, leads `
             + 'eller et abonnement på kontoen. Skriv til os, så flytter vi dig manuelt.',
        code: 'ACCOUNT_HAS_DATA',
      });
    }

    const bruger = await db.transaction(async (client) => {
      const opdateret = await client.query(
        `UPDATE users SET org_id = $1, role = $2, is_active = TRUE
          WHERE id = $3
          RETURNING id, org_id, email, name, role`,
        [inv.org_id, inv.role, req.user.id]
      );
      await client.query(
        `UPDATE team_invitations SET status = 'accepted', responded_at = NOW() WHERE id = $1`, [id]);
      // Brugeren er flyttet ud først, så CASCADE ikke tager hende med.
      if (sidsteMand) {
        await client.query('DELETE FROM organizations WHERE id = $1', [gammelOrgId]);
      }
      return opdateret.rows[0];
    });

    // Nyt token: det gamle er stadig gyldigt (login læses fra databasen ved
    // hvert kald), men bærer den gamle org i sin nyttelast.
    return res.json({
      ok: true,
      flyttet: true,
      token: signToken(bruger),
      user: {
        id: bruger.id, name: bruger.name, email: bruger.email, role: bruger.role,
        orgId: bruger.org_id, orgName: inv.org_navn,
        platformAdmin: erPlatformAdmin(bruger.email),
      },
    });
  } catch (err) {
    console.error('[auth:invitations:accept]', err.message);
    return res.status(500).json({ error: 'Kunne ikke acceptere invitationen.' });
  }
});

// ── POST /api/auth/invitations/:id/decline ───────────────────────────────────
router.post('/invitations/:id/decline', authenticate, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Ugyldig invitation.' });

  try {
    const { rows } = await db.query(
      `UPDATE team_invitations SET status = 'declined', responded_at = NOW()
        WHERE id = $1 AND LOWER(email) = LOWER($2) AND status = 'pending'
        RETURNING id`,
      [id, req.user.email]
    );
    if (!rows.length) return res.status(404).json({ error: 'Invitationen blev ikke fundet.' });
    return res.json({ ok: true });
  } catch (err) {
    console.error('[auth:invitations:decline]', err.message);
    return res.status(500).json({ error: 'Kunne ikke afvise invitationen.' });
  }
});

// ── GET /api/auth/invite/:token — hvad er det her for en invitation? ─────────
// Åbent: modtageren har typisk ingen konto endnu og skal kunne se hvem der har
// inviteret hende, før hun opretter noget. `harKonto` fortæller kun om DEN
// adresse invitationen allerede er stilet til, og kun til den der har token.
router.get('/invite/:token', invitationLimiter, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT i.name, i.email, i.role, i.status, i.expires_at,
              i.expires_at <= NOW() AS udloebet,
              o.name AS org_navn, u.name AS inviteret_af,
              EXISTS (SELECT 1 FROM users x WHERE LOWER(x.email) = LOWER(i.email)) AS har_konto
         FROM team_invitations i
         JOIN organizations o ON o.id = i.org_id
         LEFT JOIN users u ON u.id = i.invited_by
        WHERE i.token = $1`,
      [req.params.token]
    );
    const inv = rows[0];
    if (!inv) return res.status(404).json({ error: 'Invitationen findes ikke.' });

    return res.json({
      gyldig: inv.status === 'pending' && !inv.udloebet,
      status: inv.udloebet && inv.status === 'pending' ? 'expired' : inv.status,
      invitation: {
        navn: inv.name, email: inv.email, rolle: inv.role,
        orgNavn: inv.org_navn, inviteretAf: inv.inviteret_af,
        udløber: inv.expires_at, harKonto: inv.har_konto,
      },
    });
  } catch (err) {
    console.error('[auth:invite:vis]', err.message);
    return res.status(500).json({ error: 'Kunne ikke hente invitationen.' });
  }
});

// ── POST /api/auth/invite/:token — sig ja og opret kontoen i samme træk ──────
// Ingen CVR-nummer: den inviterede opretter ikke en virksomhed, hun bliver en
// del af en der findes i forvejen.
router.post('/invite/:token', invitationLimiter, async (req, res) => {
  const password = String(req.body?.password ?? '');
  const navn     = String(req.body?.name ?? '').trim();

  if (password.length < 10) {
    return res.status(400).json({ error: 'Adgangskoden skal være mindst 10 tegn.' });
  }

  try {
    const { rows } = await db.query(
      `SELECT i.id, i.org_id, i.email, i.name, i.role, o.name AS org_navn
         FROM team_invitations i
         JOIN organizations o ON o.id = i.org_id
        WHERE i.token = $1 AND i.status = 'pending' AND i.expires_at > NOW()`,
      [req.params.token]
    );
    const inv = rows[0];
    if (!inv) {
      return res.status(410).json({
        error: 'Invitationen er brugt, trukket tilbage eller udløbet.',
        code: 'INVITATION_INVALID',
      });
    }

    const { rows: findes } = await db.query(
      'SELECT 1 FROM users WHERE LOWER(email) = LOWER($1)', [inv.email]);
    if (findes.length) {
      return res.status(409).json({
        error: 'Der findes allerede en konto med den e-mail. Log ind — så ligger invitationen på dit overblik.',
        code: 'ACCOUNT_EXISTS',
      });
    }

    const fuldt = await afvisHvisFuldt(inv.org_id);
    if (fuldt) {
      return res.status(409).json({
        error: 'Der er ikke flere pladser i det team lige nu. Sig til den der inviterede dig.',
        code: fuldt.code,
      });
    }

    const hash = await bcrypt.hash(password, 12);
    const bruger = await db.transaction(async (client) => {
      const oprettet = await client.query(
        `INSERT INTO users (org_id, email, password_hash, name, role)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, org_id, email, name, role`,
        [inv.org_id, inv.email, hash, navn || inv.name, inv.role]
      );
      await client.query(
        `UPDATE team_invitations SET status = 'accepted', responded_at = NOW() WHERE id = $1`,
        [inv.id]
      );
      return oprettet.rows[0];
    });


    return res.status(201).json({
      token: signToken(bruger),
      user: {
        id: bruger.id, name: bruger.name, email: bruger.email, role: bruger.role,
        orgId: bruger.org_id, orgName: inv.org_navn,
        platformAdmin: erPlatformAdmin(bruger.email),
      },
    });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Der findes allerede en konto med den e-mail.' });
    }
    console.error('[auth:invite:accept]', err.message);
    return res.status(500).json({ error: 'Kunne ikke oprette kontoen.' });
  }
});

// ── POST /api/auth/password — change own password ────────────────────────────
router.post('/password', authenticate, async (req, res) => {
  const current = String(req.body?.currentPassword ?? '');
  const next = String(req.body?.newPassword ?? '');
  if (next.length < 10) {
    return res.status(400).json({ error: 'Den nye adgangskode skal være mindst 10 tegn.' });
  }

  try {
    const { rows } = await db.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (!rows.length || !await bcrypt.compare(current, rows[0].password_hash)) {
      return res.status(401).json({ error: 'Den nuværende adgangskode er forkert.' });
    }
    await db.query('UPDATE users SET password_hash = $1 WHERE id = $2',
      [await bcrypt.hash(next, 12), req.user.id]);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[auth:password]', err.message);
    return res.status(500).json({ error: 'Kunne ikke skifte adgangskode.' });
  }
});

// ── GET /api/auth/export — retten til dataportabilitet ───────────────────────
// Artikel 20: alt organisationen har hos os, i et format en maskine kan læse.
// Der er ingen grund til at gøre det til en mailkorrespondance når vi kan lade
// folk hente det selv.
router.get('/export', authenticate, requireOwner, async (req, res) => {
  try {
    const [org, brugere, lister, leads, aktiviteter] = await Promise.all([
      db.query(`SELECT id, name, cvr, created_at, subscription_status, current_period_end
                  FROM organizations WHERE id = $1`, [req.orgId]),
      db.query(`SELECT id, name, email, role, is_active, created_at, last_login_at
                  FROM users WHERE org_id = $1 ORDER BY id`, [req.orgId]),
      db.query(`SELECT id, name, description, filters, created_at
                  FROM lead_lists WHERE org_id = $1 ORDER BY id`, [req.orgId]),
      db.query(`SELECT * FROM leads WHERE org_id = $1 ORDER BY id`, [req.orgId]),
      db.query(`SELECT id, lead_id, user_id, type, outcome, body, created_at
                  FROM lead_activities WHERE org_id = $1 ORDER BY id`, [req.orgId]),
    ]);

    const navn = `lysmera-data-${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${navn}"`);
    return res.send(JSON.stringify({
      udtrukket: new Date().toISOString(),
      // Adgangskoder er med vilje ikke med. De ligger som hash og kan hverken
      // læses tilbage eller bruges til noget andetsteds.
      organisation: org.rows[0] ?? null,
      brugere: brugere.rows,
      lister: lister.rows,
      leads: leads.rows,
      aktiviteter: aktiviteter.rows,
    }, null, 2));
  } catch (err) {
    console.error('[auth:export]', err.message);
    return res.status(500).json({ error: 'Kunne ikke lave udtrækket.' });
  }
});

// ── DELETE /api/auth/account — retten til at blive slettet ───────────────────
// Artikel 17. Sletter organisationen, hvorefter brugere, lister, leads og
// aktiviteter følger med via ON DELETE CASCADE.
router.delete('/account', authenticate, requireOwner, async (req, res) => {
  // Adgangskoden kræves igen. Sletningen kan ikke fortrydes, og et stjålet
  // token alene skal ikke kunne udslette en hel virksomheds arbejde.
  const kode = String(req.body?.password ?? '');
  if (!kode) return res.status(400).json({ error: 'Bekræft med din adgangskode.' });

  try {
    const { rows } = await db.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (!rows.length || !await bcrypt.compare(kode, rows[0].password_hash)) {
      return res.status(401).json({ error: 'Adgangskoden er forkert.' });
    }

    const { rows: orgRows } = await db.query(
      'SELECT stripe_subscription_id AS sub FROM organizations WHERE id = $1', [req.orgId]);

    // Stop opkrævningen først. Slettede vi data og lod abonnementet løbe, ville
    // kunden betale videre for noget der ikke findes. Fejler det, fortsætter vi
    // alligevel — retten til sletning afhænger ikke af at Stripe svarer.
    const opsagt = await stripeService.opsigStraks(orgRows[0]?.sub);

    await db.query('DELETE FROM organizations WHERE id = $1', [req.orgId]);
    console.log(`[auth:slet] organisation ${req.orgId} slettet af bruger ${req.user.id}`);

    return res.json({
      ok: true,
      abonnementOpsagt: Boolean(opsagt),
      // Siges højt, så en kunde der skylder penge ikke tror bogføringen også
      // forsvandt. Fakturaer skal vi gemme efter bogføringsloven.
      bemærkning: orgRows[0]?.sub && !opsagt
        ? 'Abonnementet kunne ikke opsiges automatisk — skriv til os, så ordner vi det.'
        : null,
    });
  } catch (err) {
    console.error('[auth:slet]', err.message);
    return res.status(500).json({ error: 'Kunne ikke slette kontoen.' });
  }
});

module.exports = router;
