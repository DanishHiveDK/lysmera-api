// scripts/verify.js — end-to-end check against a real, throwaway PostgreSQL.
//
// Boots an embedded Postgres, runs the migrations, seeds an organisation and
// then drives the actual Express app over HTTP: login, list creation, the call
// queue, callbacks, CSV export and the org-isolation guarantees.
//
// The CVR provider is stubbed — Virk credentials are not needed to prove the
// database layer and the API work.
//
//   node scripts/verify.js
'use strict';

const path = require('path');
const os   = require('os');
const fs   = require('fs');
const crypto = require('crypto');

// Deliberately not 55432 — that's `npm run db:local`, and the two must be able
// to run side by side.
const PG_PORT  = 55433;
const APP_PORT = 4555;

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

/** Fake CVR companies so the extraction path can run without Virk. */
function fakeCompanies(count, offset = 0) {
  return Array.from({ length: count }, (_, i) => {
    const n = offset + i;
    return {
      cvr: String(10000000 + n),
      name: `Testvirksomhed ${n} ApS`,
      address: `Testvej ${n}`,
      zipcode: String(5000 + (n % 900)),
      city: 'Odense',
      municipality: 'Odense',
      phone: `65${String(100000 + n).slice(0, 6)}`,
      email: `kontakt${n}@example.dk`,
      website: 'https://example.dk',
      industryCode: '620200',
      industryText: 'IT-konsulentbistand',
      companyType: 'APS',
      employees: (n % 40) + 1,
      employeesInterval: null,
      establishedOn: '2015-03-01',
      status: 'NORMAL',
      // Every tenth company is advertising-protected — these must never land
      // in a list, which is the whole point of checking it here.
      advertisingProtected: n % 10 === 0,
      // Enrichment fields (migration 002)
      region: 'Syddanmark',
      ownerName: `Ejer Ejersen ${n}`,
      ownerRole: 'Direktør',
      ownerCount: 1,
      purpose: `Selskabets formål er testvirksomhed nummer ${n}.`,
      capital: 40000,
      capitalCurrency: 'DKK',
    };
  });
}

async function main() {
  const mod = require('embedded-postgres');
  const EmbeddedPostgres = mod.default ?? mod;
  const dataDir = path.join(os.tmpdir(), `lysmera-verify-${Date.now()}`);

  console.log('Starter midlertidig PostgreSQL…');
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password: 'postgres',
    port: PG_PORT,
    persistent: false,
    // A Danish Windows locale would initialise the cluster as WIN1252 and
    // reject non-Latin-1 bytes. Production (Railway) is UTF8 — match it, or
    // this verification tests a database unlike the real one.
    initdbFlags: ['--encoding=UTF8', '--no-locale'],
  });

  await pg.initialise();
  await pg.start();
  await pg.createDatabase('lysmera_test');
  console.log(`PostgreSQL kører på :${PG_PORT}\n`);

  // Env must be set before db.js / server.js are required — the pool is built
  // at module load.
  process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/lysmera_test`;
  process.env.JWT_SECRET   = crypto.randomBytes(32).toString('hex');
  process.env.PORT         = String(APP_PORT);
  process.env.NODE_ENV     = 'test';
  // Fritagelsen og loftet læses ved indlæsning af middleware/subscription, så
  // de skal stå her — før server.js kræves ind. To pladser i stedet for fem:
  // loftet skal kunne rammes uden at oprette et helt team først.
  process.env.BILLING_EXEMPT_EMAILS = 'fri@example.dk';
  process.env.FREE_TEAM_SEATS       = '2';
  process.env.PLATFORM_ADMIN_EMAILS = 'admin@example.dk';

  const db = require('../db');

  try {
    // ── Migrations ───────────────────────────────────────────────────────────
    section('Migrations');
    const migDir = path.join(__dirname, '..', 'migrations');
    await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    for (const file of fs.readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort()) {
      await db.transaction(async (c) => {
        await c.query(fs.readFileSync(path.join(migDir, file), 'utf8'));
        await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      });
      check(`${file} kørt`, true);
    }
    const tables = await db.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' ORDER BY table_name`);
    const names = tables.rows.map((r) => r.table_name);
    check('alle tabeller oprettet',
      ['organizations', 'users', 'lead_lists', 'leads', 'lead_activities'].every((t) => names.includes(t)),
      names.join(', '));

    // ── Seed two organisations, so isolation can be tested ───────────────────
    section('Organisationer og brugere');
    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash('hemmeligkode123', 10);

    const mkOrg = async (orgName, email) => {
      const org = await db.query('INSERT INTO organizations (name) VALUES ($1) RETURNING id', [orgName]);
      const user = await db.query(
        `INSERT INTO users (org_id, email, password_hash, name, role)
         VALUES ($1, $2, $3, $4, 'owner') RETURNING id`,
        [org.rows[0].id, email, hash, orgName + ' ejer']);
      return { orgId: org.rows[0].id, userId: user.rows[0].id };
    };
    const orgA = await mkOrg('Firma A ApS', 'a@example.dk');
    // Pladserne er forudbetalte. Firma A skal kunne tage et helt hold ind i
    // afsnittene om team og invitationer, så det har pladser nok på forhånd.
    await db.query('UPDATE organizations SET requested_seats = 20 WHERE id = $1', [orgA.orgId]);
    const orgB = await mkOrg('Firma B ApS', 'b@example.dk');
    check('to organisationer oprettet', orgA.orgId !== orgB.orgId);

    const dupe = await db.query(
      `INSERT INTO users (org_id, email, password_hash, name)
       VALUES ($1, 'A@EXAMPLE.DK', $2, 'Dublet') ON CONFLICT DO NOTHING RETURNING id`,
      [orgB.orgId, hash]).catch((e) => e);
    check('e-mail er unik på tværs af store/små bogstaver',
      dupe instanceof Error || dupe.rows.length === 0);

    // ── Stub the CVR provider, then boot the app ─────────────────────────────
    const cvr = require('../services/cvrService');
    cvr.extractCompanies = async ({ limit = 1000, onBatch }) => {
      const batches = [fakeCompanies(30, 0), fakeCompanies(20, 30)];
      let fetched = 0;
      for (const b of batches) {
        const slice = b.slice(0, Math.max(0, limit - fetched));
        if (!slice.length) break;
        fetched += slice.length;
        if (onBatch) await onBatch(slice);
      }
      return { total: 50, fetched, results: [] };
    };

    require('../server');
    await new Promise((r) => setTimeout(r, 400));
    const BASE = `http://127.0.0.1:${APP_PORT}`;

    const call = async (path, { method = 'GET', body, token } = {}) => {
      const res = await fetch(`${BASE}${path}`, {
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* CSV and the like */ }
      return { status: res.status, json, text, headers: res.headers };
    };

    // ── Auth ─────────────────────────────────────────────────────────────────
    section('Login');
    const health = await call('/health');
    check('/health rapporterer db: true', health.json?.db === true, JSON.stringify(health.json));

    const badLogin = await call('/api/auth/login', {
      method: 'POST', body: { email: 'a@example.dk', password: 'forkert' } });
    check('forkert adgangskode afvises', badLogin.status === 401);

    const unknownLogin = await call('/api/auth/login', {
      method: 'POST', body: { email: 'findes-ikke@example.dk', password: 'hemmeligkode123' } });
    check('ukendt e-mail giver samme svar som forkert kode',
      unknownLogin.status === 401 && unknownLogin.json.error === badLogin.json.error);

    const loginA = await call('/api/auth/login', {
      method: 'POST', body: { email: 'A@Example.dk', password: 'hemmeligkode123' } });
    check('login virker (og e-mail er case-insensitiv)', loginA.status === 200 && !!loginA.json.token);
    const tokenA = loginA.json.token;

    const loginB = await call('/api/auth/login', {
      method: 'POST', body: { email: 'b@example.dk', password: 'hemmeligkode123' } });
    const tokenB = loginB.json.token;

    const me = await call('/api/auth/me', { token: tokenA });
    check('/auth/me returnerer org-navn', me.json?.user?.orgName === 'Firma A ApS');

    const noAuth = await call('/api/lists');
    check('beskyttet rute kræver token', noAuth.status === 401);

    // ── Extraction into a list ───────────────────────────────────────────────
    section('Udtræk og lister');
    const tooBroad = await call('/api/lists', {
      method: 'POST', token: tokenA, body: { name: 'Alt', filters: {} } });
    check('udtræk uden filtre blokeres', tooBroad.status === 400
      && tooBroad.json.code === 'FILTER_TOO_BROAD');

    const created = await call('/api/lists', {
      method: 'POST', token: tokenA,
      body: { name: 'IT-firmaer Fyn', filters: { industryCodes: ['620200'], region: 'fyn' }, limit: 1000 } });
    check('liste oprettet', created.status === 201, JSON.stringify(created.json));
    const listId = created.json?.list?.id;

    // 50 generated, every tenth advertising-protected → 45 should be stored.
    check('reklamebeskyttede frasorteres (45 af 50 importeret)',
      created.json?.imported === 45, `importeret: ${created.json?.imported}`);

    const dbProtected = await db.query(
      'SELECT COUNT(*)::int AS n FROM leads WHERE list_id = $1 AND advertising_protected', [listId]);
    check('ingen reklamebeskyttede i databasen', dbProtected.rows[0].n === 0);

    const refresh = await call(`/api/lists/${listId}/refresh`, {
      method: 'POST', token: tokenA, body: { limit: 1000 } });
    check('opdatering tilføjer ingen dubletter', refresh.json?.added === 0,
      `tilføjet: ${refresh.json?.added}`);

    const listShow = await call(`/api/lists/${listId}`, { token: tokenA });
    check('liste-detaljer viser statusfordeling',
      listShow.json?.total === 45 && listShow.json?.byStatus?.new === 45,
      JSON.stringify(listShow.json?.byStatus));

    const leadsPage = await call(`/api/lists/${listId}/leads?size=10&page=2`, { token: tokenA });
    check('paginering virker', leadsPage.json?.leads?.length === 10 && leadsPage.json?.total === 45);

    const searchLeads = await call(`/api/lists/${listId}/leads?q=Testvirksomhed%201%20`, { token: tokenA });
    check('søgning i listen virker', searchLeads.json?.total >= 1);

    // ── Org isolation ────────────────────────────────────────────────────────
    section('Adskillelse mellem virksomheder');
    const bSeesLists = await call('/api/lists', { token: tokenB });
    check('Firma B ser ikke Firma A\'s lister', bSeesLists.json?.lists?.length === 0);

    const bReadsList = await call(`/api/lists/${listId}`, { token: tokenB });
    check('Firma B kan ikke åbne Firma A\'s liste (404)', bReadsList.status === 404);

    const someLead = (await db.query(
      'SELECT id FROM leads WHERE list_id = $1 LIMIT 1', [listId])).rows[0].id;
    const bReadsLead = await call(`/api/leads/${someLead}`, { token: tokenB });
    check('Firma B kan ikke åbne Firma A\'s lead (404)', bReadsLead.status === 404);

    const bWritesLead = await call(`/api/leads/${someLead}/outcome`, {
      method: 'POST', token: tokenB, body: { status: 'won' } });
    check('Firma B kan ikke ændre Firma A\'s lead (404)', bWritesLead.status === 404);

    // ── The call queue ───────────────────────────────────────────────────────
    section('Ringekø');
    const next1 = await call('/api/leads/next', { token: tokenA });
    check('næste lead udleveres', !!next1.json?.lead, JSON.stringify(next1.json).slice(0, 160));
    check('antal tilbage er korrekt', next1.json?.remaining === 45, `remaining: ${next1.json?.remaining}`);
    const lead1 = next1.json.lead;

    const noAnswer = await call(`/api/leads/${lead1.id}/outcome`, {
      method: 'POST', token: tokenA, body: { status: 'no_answer', note: 'Lagde besked' } });
    check('resultat "intet svar" gemmes',
      noAnswer.json?.lead?.status === 'no_answer' && noAnswer.json?.lead?.call_count === 1);
    check('leadet tildeles den der ringede', noAnswer.json?.lead?.assigned_to != null);

    const next2 = await call('/api/leads/next', { token: tokenA });
    check('køen går videre til et andet lead', next2.json?.lead?.id !== lead1.id);

    const missingTime = await call(`/api/leads/${next2.json.lead.id}/outcome`, {
      method: 'POST', token: tokenA, body: { status: 'callback' } });
    check('"ring igen" uden tidspunkt afvises', missingTime.status === 400);

    const future = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
    const cbSet = await call(`/api/leads/${next2.json.lead.id}/outcome`, {
      method: 'POST', token: tokenA, body: { status: 'callback', callbackAt: future, note: 'Ring torsdag' } });
    check('genopkald gemmes med tidspunkt', cbSet.json?.lead?.next_callback_at != null);

    const next3 = await call('/api/leads/next', { token: tokenA });
    check('lead med fremtidigt genopkald springes over i køen',
      next3.json?.lead?.id !== next2.json.lead.id);

    // A callback that is already due must jump to the front of the queue.
    const past = new Date(Date.now() - 3600 * 1000);
    const overdueLead = next3.json.lead.id;
    await db.query('UPDATE leads SET status = $1, next_callback_at = $2 WHERE id = $3',
      ['callback', past, overdueLead]);
    const next4 = await call('/api/leads/next', { token: tokenA });
    check('forfaldent genopkald kommer forrest i køen', next4.json?.lead?.id === overdueLead,
      `fik ${next4.json?.lead?.id}, ventede ${overdueLead}`);

    const won = await call(`/api/leads/${overdueLead}/outcome`, {
      method: 'POST', token: tokenA, body: { status: 'won', note: 'Solgt!' } });
    check('terminal status rydder genopkaldet', won.json?.lead?.next_callback_at === null);

    const next5 = await call('/api/leads/next', { token: tokenA });
    check('vundet lead falder ud af køen', next5.json?.lead?.id !== overdueLead);

    const badStatus = await call(`/api/leads/${lead1.id}/outcome`, {
      method: 'POST', token: tokenA, body: { status: 'noget-opfundet' } });
    check('ukendt status afvises', badStatus.status === 400);

    // ── Notes, history, callbacks list, stats ────────────────────────────────
    section('Noter, historik og genopkald');
    await call(`/api/leads/${lead1.id}/notes`, {
      method: 'POST', token: tokenA, body: { body: 'Ringede igen, receptionen tog den' } });
    const detail = await call(`/api/leads/${lead1.id}`, { token: tokenA });
    check('historikken indeholder både opkald og note',
      detail.json?.activities?.some((a) => a.type === 'call')
      && detail.json?.activities?.some((a) => a.type === 'note'));
    check('historikken viser hvem der gjorde det',
      detail.json?.activities?.[0]?.user_name === 'Firma A ApS ejer');

    const cbToday = await call('/api/leads/callbacks?scope=today', { token: tokenA });
    check('dagens genopkald er tom (aftalen ligger om 3 dage)',
      cbToday.json?.callbacks?.length === 0, `fik ${cbToday.json?.callbacks?.length}`);

    const cbWeek = await call('/api/leads/callbacks?scope=week', { token: tokenA });
    check('ugens genopkald indeholder aftalen', cbWeek.json?.callbacks?.length === 1);

    // Three outcomes were logged: no_answer, callback and won. The rejected
    // callback (400) and the plain note must not count as calls.
    const stats = await call('/api/stats', { token: tokenA });
    check('statistik tæller kun rigtige opkald (3)', stats.json?.calls_today === 3,
      JSON.stringify(stats.json));
    check('statistik tæller vundne', stats.json?.won === 1, JSON.stringify(stats.json));

    const statsB = await call('/api/stats', { token: tokenB });
    check('Firma B\'s statistik er nul', statsB.json?.leads === 0);

    // ── Team ─────────────────────────────────────────────────────────────────
    section('Team');
    const newUser = await call('/api/auth/team', {
      method: 'POST', token: tokenA,
      body: { name: 'Sælger Sofie', email: 'sofie@example.dk', password: 'langnokkode123', role: 'agent' } });
    check('ejer kan oprette sælger', newUser.status === 201);

    const shortPw = await call('/api/auth/team', {
      method: 'POST', token: tokenA,
      body: { name: 'Kort', email: 'kort@example.dk', password: 'kort' } });
    check('for kort adgangskode afvises', shortPw.status === 400);

    const loginSofie = await call('/api/auth/login', {
      method: 'POST', body: { email: 'sofie@example.dk', password: 'langnokkode123' } });
    const tokenSofie = loginSofie.json.token;
    check('sælger kan logge ind', !!tokenSofie);

    const sofieAddsUser = await call('/api/auth/team', {
      method: 'POST', token: tokenSofie,
      body: { name: 'X', email: 'x@example.dk', password: 'langnokkode123' } });
    check('sælger kan ikke oprette brugere', sofieAddsUser.status === 403);

    const sofieSeesList = await call(`/api/lists/${listId}`, { token: tokenSofie });
    check('sælger ser sin egen organisations liste', sofieSeesList.status === 200);

    await call(`/api/auth/team/${newUser.json.user.id}`, {
      method: 'PATCH', token: tokenA, body: { isActive: false } });
    const sofieAfterDisable = await call('/api/lists', { token: tokenSofie });
    check('deaktiveret bruger mister adgang med det samme',
      sofieAfterDisable.status === 401 && sofieAfterDisable.json.code === 'USER_INACTIVE');

    // ── Invitationer ─────────────────────────────────────────────────────────
    section('Invitationer');
    const invitér = (body, token = tokenA) =>
      call('/api/auth/team/invitations', { method: 'POST', token, body });

    const invMaria = await invitér({ name: 'Maria Berg', email: 'maria@example.dk' });
    check('ejer kan invitere med navn og e-mail', invMaria.status === 201,
      JSON.stringify(invMaria.json));
    const mariaLink = invMaria.json?.invitation?.link ?? '';
    const mariaToken = mariaLink.split('/').pop();
    check('invitationen giver et link at sende', mariaLink.includes('/invitation/'), mariaLink);
    check('uden mailudbyder sendes der ingen mail', invMaria.json?.mailSendt === false);

    const invIgen = await invitér({ name: 'Maria Berg', email: 'MARIA@example.dk' });
    check('samme adresse kan ikke inviteres to gange',
      invIgen.status === 409 && invIgen.json.code === 'INVITATION_EXISTS');

    const invMedlem = await invitér({ name: 'Ejeren', email: 'a@example.dk' });
    check('et nuværende medlem kan ikke inviteres', invMedlem.status === 409);

    const invAgent = await call('/api/auth/team/invitations', {
      method: 'POST', token: tokenSofie, body: { name: 'X', email: 'x@example.dk' } });
    check('en sælger kan ikke invitere', invAgent.status === 401 || invAgent.status === 403);

    const åbne = await call('/api/auth/team/invitations', { token: tokenA });
    check('ejeren kan se de åbne invitationer',
      åbne.json?.invitations?.some((i) => i.email === 'maria@example.dk' && i.status === 'pending'));

    // ── Den inviterede uden konto ────────────────────────────────────────────
    const visInv = await call(`/api/auth/invite/${mariaToken}`);
    check('invitationen kan ses uden login',
      visInv.status === 200 && visInv.json.gyldig === true);
    check('den viser hvem der inviterer',
      visInv.json?.invitation?.orgNavn === 'Firma A ApS'
      && visInv.json?.invitation?.harKonto === false);

    const kortKode = await call(`/api/auth/invite/${mariaToken}`, {
      method: 'POST', body: { password: 'kort' } });
    check('for kort adgangskode afvises ved accept', kortKode.status === 400);

    const ukendtToken = await call('/api/auth/invite/findes-ikke', {
      method: 'POST', body: { password: 'langnokkode123' } });
    check('ukendt token kan ikke bruges', ukendtToken.status === 410);

    const mariaAccept = await call(`/api/auth/invite/${mariaToken}`, {
      method: 'POST', body: { password: 'mariaskode123' } });
    check('den inviterede opretter sig uden CVR-nummer', mariaAccept.status === 201,
      JSON.stringify(mariaAccept.json));
    check('hun lander i det team der inviterede hende',
      mariaAccept.json?.user?.orgId === orgA.orgId && mariaAccept.json?.user?.role === 'agent');

    const mariaSerListe = await call(`/api/lists/${listId}`, { token: mariaAccept.json?.token });
    check('hun ser holdets lister med det samme', mariaSerListe.status === 200);

    const brugtToken = await call(`/api/auth/invite/${mariaToken}`, {
      method: 'POST', body: { password: 'endnuenkode123' } });
    check('linket kan kun bruges én gang', brugtToken.status === 410);

    // ── Tilbagekaldelse ──────────────────────────────────────────────────────
    const invPeter = await invitér({ name: 'Peter', email: 'peter@example.dk' });
    const peterToken = (invPeter.json?.invitation?.link ?? '').split('/').pop();
    const trukket = await call(
      `/api/auth/team/invitations/${invPeter.json?.invitation?.id}`, { method: 'DELETE', token: tokenA });
    check('ejeren kan trække en invitation tilbage', trukket.status === 200);
    const efterTilbagekald = await call(`/api/auth/invite/${peterToken}`);
    check('et tilbagekaldt link virker ikke længere',
      efterTilbagekald.json?.gyldig === false && efterTilbagekald.json?.status === 'revoked');

    // ── Den inviterede HAR allerede en konto ─────────────────────────────────
    const tomOrg = await mkOrg('Tom Konto ApS', 'tom@example.dk');
    const invTom = await invitér({ name: 'Tom', email: 'tom@example.dk' });
    check('en adresse med konto kan også inviteres', invTom.status === 201);

    const tomToken = (await call('/api/auth/login', {
      method: 'POST', body: { email: 'tom@example.dk', password: 'hemmeligkode123' } })).json.token;

    const tomsInvitationer = await call('/api/auth/invitations', { token: tomToken });
    check('invitationen dukker op på hans eget overblik',
      tomsInvitationer.json?.invitations?.[0]?.org_navn === 'Firma A ApS',
      JSON.stringify(tomsInvitationer.json));

    const tomAccept = await call(
      `/api/auth/invitations/${tomsInvitationer.json.invitations[0].id}/accept`,
      { method: 'POST', token: tomToken });
    check('han kan acceptere fra sit overblik', tomAccept.status === 200,
      JSON.stringify(tomAccept.json));
    check('han flyttes over i det nye team',
      tomAccept.json?.user?.orgId === orgA.orgId && tomAccept.json?.flyttet === true);
    const tomsGamleOrg = await db.query(
      'SELECT COUNT(*)::int AS n FROM organizations WHERE id = $1', [tomOrg.orgId]);
    check('hans tomme organisation ryddes op', tomsGamleOrg.rows[0].n === 0);

    // En konto med lister og leads må ikke kunne forlades i stilhed: brugeren
    // er den eneste, og data ville blive stående bag et login der ikke findes.
    const dataOrg = await mkOrg('Data ApS', 'data@example.dk');
    await db.query('INSERT INTO lead_lists (org_id, name) VALUES ($1, $2)',
      [dataOrg.orgId, 'Egne emner']);
    const dataToken = (await call('/api/auth/login', {
      method: 'POST', body: { email: 'data@example.dk', password: 'hemmeligkode123' } })).json.token;

    const invData = await invitér({ name: 'Data', email: 'data@example.dk' });
    const dataInvId = invData.json?.invitation?.id;
    const dataAccept = await call(`/api/auth/invitations/${dataInvId}/accept`,
      { method: 'POST', token: dataToken });
    check('en konto med data kan ikke forlades ved et uheld',
      dataAccept.status === 409 && dataAccept.json.code === 'ACCOUNT_HAS_DATA',
      JSON.stringify(dataAccept.json));

    const fremmedAccept = await call(`/api/auth/invitations/${dataInvId}/accept`,
      { method: 'POST', token: mariaAccept.json?.token });
    check('man kan ikke acceptere en invitation stilet til en anden',
      fremmedAccept.status === 404);

    const dataAfvis = await call(`/api/auth/invitations/${dataInvId}/decline`,
      { method: 'POST', token: dataToken });
    check('en invitation kan afvises', dataAfvis.status === 200);
    const efterAfvisning = await call('/api/auth/invitations', { token: dataToken });
    check('en afvist invitation vises ikke igen',
      efterAfvisning.json?.invitations?.length === 0);

    // ── Gratis teampladser på en fritaget konto ──────────────────────────────
    section('Gratis teampladser');
    const friOrg = await mkOrg('Fri ApS', 'fri@example.dk');
    const friToken = (await call('/api/auth/login', {
      method: 'POST', body: { email: 'fri@example.dk', password: 'hemmeligkode123' } })).json.token;

    const friStatus = await call('/api/billing/status', { token: friToken });
    check('den fritagne konto får to gratis teampladser',
      friStatus.json?.fritaget === true && friStatus.json?.team?.gratisPladser === 2,
      JSON.stringify(friStatus.json?.team));

    const kollega = (n) => call('/api/auth/team', {
      method: 'POST', token: friToken,
      body: { name: `Kollega ${n}`, email: `kollega${n}@example.dk`, password: 'langnokkode123' } });
    check('første gratis plads kan bruges', (await kollega(1)).status === 201);
    check('anden gratis plads kan bruges', (await kollega(2)).status === 201);
    const forMange = await kollega(3);
    check('den tredje afvises — loftet er to',
      forMange.status === 409 && forMange.json.code === 'FREE_SEATS_EXCEEDED',
      JSON.stringify(forMange.json));

    const kollegaToken = (await call('/api/auth/login', {
      method: 'POST', body: { email: 'kollega1@example.dk', password: 'langnokkode123' } })).json.token;
    const kollegaStatus = await call('/api/billing/status', { token: kollegaToken });
    check('kollegaen på en fritaget konto er også fritaget',
      kollegaStatus.json?.fritaget === true && kollegaStatus.json?.harAdgang === true,
      JSON.stringify(kollegaStatus.json));

    // En afventende invitation optager pladsen. Ellers ville loftet først vise
    // sig når nummer seks sagde ja — og de fem andre havde et dødt link.
    await call(`/api/auth/team/${(await db.query(
      `SELECT id FROM users WHERE email = 'kollega2@example.dk'`)).rows[0].id}`, {
      method: 'PATCH', token: friToken, body: { isActive: false } });
    const invEfterFrigivelse = await invitér(
      { name: 'Ny Kollega', email: 'ny@example.dk' }, friToken);
    check('en frigivet plads kan inviteres til', invEfterFrigivelse.status === 201);
    const invForMange = await invitér({ name: 'En til', email: 'entil@example.dk' }, friToken);
    check('afventende invitationer tæller med i loftet',
      invForMange.status === 409 && invForMange.json.code === 'FREE_SEATS_EXCEEDED');

    const genaktivér = await call(`/api/auth/team/${(await db.query(
      `SELECT id FROM users WHERE email = 'kollega2@example.dk'`)).rows[0].id}`, {
      method: 'PATCH', token: friToken, body: { isActive: true } });
    check('en deaktiveret bruger kan ikke genaktiveres forbi loftet',
      genaktivér.status === 409 && genaktivér.json.code === 'FREE_SEATS_EXCEEDED');

    // ── Profiler ─────────────────────────────────────────────────────────────
    section('Profiler');
    const kollega1Id = (await db.query(
      `SELECT id FROM users WHERE email = 'kollega1@example.dk'`)).rows[0].id;

    const omdøbt = await call(`/api/auth/team/${kollega1Id}`, {
      method: 'PATCH', token: friToken, body: { name: 'Kollega Én', email: 'en@example.dk' } });
    check('ejeren kan rette et medlems navn og e-mail',
      omdøbt.status === 200 && omdøbt.json.user.name === 'Kollega Én'
      && omdøbt.json.user.email === 'en@example.dk', JSON.stringify(omdøbt.json));
    check('et navneskifte aktiverer ikke ved et uheld', omdøbt.json?.user?.is_active === true);

    const efterOmdøbning = await call('/api/auth/login', {
      method: 'POST', body: { email: 'en@example.dk', password: 'langnokkode123' } });
    check('den nye adresse kan logge ind', efterOmdøbning.status === 200);

    const optagetMail = await call(`/api/auth/team/${kollega1Id}`, {
      method: 'PATCH', token: friToken, body: { email: 'fri@example.dk' } });
    check('en optaget e-mail afvises', optagetMail.status === 409);

    const tomtNavn = await call(`/api/auth/team/${kollega1Id}`, {
      method: 'PATCH', token: friToken, body: { name: '   ' } });
    check('et tomt navn afvises', tomtNavn.status === 400);

    const nyRolle = await call(`/api/auth/team/${kollega1Id}`, {
      method: 'PATCH', token: friToken, body: { role: 'owner' } });
    check('et medlem kan gøres til ejer',
      nyRolle.status === 200 && nyRolle.json.user.role === 'owner');

    const friId = (await db.query(
      `SELECT id FROM users WHERE email = 'fri@example.dk'`)).rows[0].id;
    const egenRolle = await call(`/api/auth/team/${friId}`, {
      method: 'PATCH', token: friToken, body: { role: 'agent' } });
    check('man kan ikke ændre sin egen rolle', egenRolle.status === 400);

    const egenAdgang = await call(`/api/auth/team/${friId}`, {
      method: 'PATCH', token: friToken, body: { isActive: false } });
    check('man kan ikke deaktivere sig selv', egenAdgang.status === 400);

    // Egen profil
    const egenProfil = await call('/api/auth/me', {
      method: 'PATCH', token: friToken, body: { name: 'Fri Ejer', email: 'fri@example.dk' } });
    check('man kan rette sit eget navn',
      egenProfil.status === 200 && egenProfil.json.user.name === 'Fri Ejer'
      && !!egenProfil.json.token, JSON.stringify(egenProfil.json));

    const ugyldigMail = await call('/api/auth/me', {
      method: 'PATCH', token: friToken, body: { name: 'Fri Ejer', email: 'ikke-en-mail' } });
    check('en ugyldig e-mail afvises på egen profil', ugyldigMail.status === 400);

    const stjålenMail = await call('/api/auth/me', {
      method: 'PATCH', token: friToken, body: { name: 'Fri Ejer', email: 'en@example.dk' } });
    check('egen profil kan ikke tage en andens e-mail', stjålenMail.status === 409);

    const agentRetterAndre = await call(`/api/auth/team/${friId}`, {
      method: 'PATCH', token: tokenSofie, body: { name: 'Hacket' } });
    check('en sælger kan ikke rette andres profiler',
      agentRetterAndre.status === 401 || agentRetterAndre.status === 403);

    // ── CSV ──────────────────────────────────────────────────────────────────
    section('CSV-eksport');
    const csv = await call(`/api/lists/${listId}/export.csv`, { token: tokenA });
    check('CSV svarer 200', csv.status === 200);

    // The BOM has to be checked on the raw bytes: Response.text() decodes UTF-8
    // with BOM-stripping, so it would never show up in the string.
    const csvBytes = Buffer.from(await (await fetch(`${BASE}/api/lists/${listId}/export.csv`,
      { headers: { Authorization: `Bearer ${tokenA}` } })).arrayBuffer());
    check('CSV starter med UTF-8 BOM (Excel læser æøå korrekt)',
      csvBytes[0] === 0xef && csvBytes[1] === 0xbb && csvBytes[2] === 0xbf,
      [...csvBytes.subarray(0, 3)].map((b) => b.toString(16)).join(' '));
    check('CSV har æøå intakt', csvBytes.includes(Buffer.from('Virksomhed', 'utf8')));
    check('CSV bruger semikolon', csv.text.split('\r\n')[0].includes('CVR;Virksomhed'));
    check('CSV har en linje pr. lead + overskrift',
      csv.text.trim().split('\r\n').length === 46, `linjer: ${csv.text.trim().split('\r\n').length}`);
    check('CSV indeholder seneste note',
      csv.text.includes('receptionen tog den'));
    check('CSV-filnavn er sat', /filename=/.test(csv.headers.get('content-disposition') || ''));

    const csvFiltered = await call(`/api/lists/${listId}/export.csv?status=won`, { token: tokenA });
    check('CSV kan filtreres på status',
      csvFiltered.text.trim().split('\r\n').length === 2);

    const csvB = await call(`/api/lists/${listId}/export.csv`, { token: tokenB });
    check('Firma B kan ikke eksportere Firma A\'s liste', csvB.status === 404);

    // ── Deletion cascades ────────────────────────────────────────────────────
    // ── Enrichment: owner, region, purpose ───────────────────────────────────
    section('Berigede felter (ejer, region, formål)');
    const enriched = (await db.query(
      `SELECT owner_name, owner_role, region, purpose, capital, capital_currency
         FROM leads WHERE list_id = $1 LIMIT 1`, [listId])).rows[0];
    check('ejernavn gemmes', /^Ejer Ejersen/.test(enriched.owner_name ?? ''), enriched.owner_name);
    check('ejerrolle gemmes', enriched.owner_role === 'Direktør');
    check('region gemmes', enriched.region === 'Syddanmark');
    check('formål gemmes', /testvirksomhed/.test(enriched.purpose ?? ''));
    check('kapital gemmes som tal', Number(enriched.capital) === 40000, String(enriched.capital));

    const leadWithOwner = await call(`/api/lists/${listId}/leads?size=1`, { token: tokenA });
    check('API returnerer ejer og region på leads',
      !!leadWithOwner.json?.leads?.[0]?.owner_name && !!leadWithOwner.json?.leads?.[0]?.region);

    // ── Two-axis status model ────────────────────────────────────────────────
    section('Pipeline-stadier');
    const stageLead = (await db.query(
      `SELECT id FROM leads WHERE list_id = $1 AND stage = 'pipeline' LIMIT 1`, [listId])).rows[0].id;

    const readStage = async () =>
      (await call(`/api/leads/${stageLead}`, { token: tokenA })).json?.lead;

    check('nye leads starter i "pipeline"', (await readStage()).stage === 'pipeline');

    await call(`/api/leads/${stageLead}/outcome`, {
      method: 'POST', token: tokenA, body: { status: 'no_answer' } });
    // Et ubesvaret opkald er ikke fremdrift i en prognose — leadet skal
    // stadig ringes op, og bliver derfor i pipeline.
    check('"intet svar" bliver i "pipeline"', (await readStage()).stage === 'pipeline');

    await call(`/api/leads/${stageLead}/outcome`, {
      method: 'POST', token: tokenA, body: { status: 'interested' } });
    check('"interesseret" flytter til "upside"', (await readStage()).stage === 'upside');

    await call(`/api/leads/${stageLead}/outcome`, {
      method: 'POST', token: tokenA, body: { status: 'no_answer' } });
    const afterRelapse = await readStage();
    check('et senere "intet svar" trækker IKKE stadiet tilbage',
      afterRelapse.stage === 'upside', `stadie: ${afterRelapse.stage}`);
    check('opkaldsudfaldet opdateres stadig', afterRelapse.status === 'no_answer');

    await call(`/api/leads/${stageLead}/outcome`, {
      method: 'POST', token: tokenA, body: { status: 'not_interested' } });
    check('"ikke interesseret" er en konklusion og flytter til "tabt"',
      (await readStage()).stage === 'tabt');

    const dragged = await call(`/api/leads/${stageLead}`, {
      method: 'PATCH', token: tokenA, body: { stage: 'pipeline' } });
    check('kanban-træk kan flytte baglæns', dragged.json?.lead?.stage === 'pipeline');

    // 'commit' kan ikke nås af et udfald — kun ved at trække kortet. Det er
    // en vurdering, ikke noget der kan udledes af hvad der er sket.
    const tilCommit = await call(`/api/leads/${stageLead}`, {
      method: 'PATCH', token: tokenA, body: { stage: 'commit' } });
    check('"commit" kan sættes ved træk', tilCommit.json?.lead?.stage === 'commit');

    await call(`/api/leads/${stageLead}/outcome`, {
      method: 'POST', token: tokenA, body: { status: 'interested' } });
    check('et "interesseret" trækker ikke commit tilbage til upside',
      (await readStage()).stage === 'commit');

    const badStage = await call(`/api/leads/${stageLead}`, {
      method: 'PATCH', token: tokenA, body: { stage: 'noget-opfundet' } });
    check('ukendt stadie afvises', badStage.status === 400 && badStage.json.code === 'BAD_STAGE');

    const bStage = await call(`/api/leads/${stageLead}`, {
      method: 'PATCH', token: tokenB, body: { stage: 'vundet' } });
    check('Firma B kan ikke flytte Firma A\'s lead', bStage.status === 404);

    // ── VAT: the three-state model ───────────────────────────────────────────
    section('Momsstatus');
    const vatLead = (await db.query(
      'SELECT id, vat_status FROM leads WHERE list_id = $1 LIMIT 1', [listId])).rows[0];
    check('leads starter som momsstatus "unknown"', vatLead.vat_status === 'unknown');

    // A settled answer must be reused rather than re-queried; VIES is
    // rate-limited and this is the guard that keeps us off it.
    await db.query(
      `UPDATE leads SET vat_status = 'registered', vat_name = 'Test A/S', vat_checked_at = NOW()
        WHERE id = $1`, [vatLead.id]);
    const cachedVat = await call(`/api/leads/${vatLead.id}/vat-check`, {
      method: 'POST', token: tokenA, body: {} });
    check('afklaret momsstatus læses fra cache',
      cachedVat.json?.cached === true && cachedVat.json?.vatStatus === 'registered');
    check('momsnummer formateres som DK+CVR',
      /^DK\d{8}$/.test(cachedVat.json?.vatNumber ?? ''), cachedVat.json?.vatNumber);

    // 'unknown' means the last lookup failed — it must NOT be treated as a
    // settled "not registered", so it is always retried.
    await db.query(
      `UPDATE leads SET vat_status = 'unknown', vat_checked_at = NULL WHERE id = $1`, [vatLead.id]);
    const stillUnknown = (await db.query(
      'SELECT vat_status, vat_checked_at FROM leads WHERE id = $1', [vatLead.id])).rows[0];
    check('"unknown" har intet tjek-tidspunkt', stillUnknown.vat_checked_at === null);

    const bVat = await call(`/api/leads/${vatLead.id}/vat-check`, {
      method: 'POST', token: tokenB, body: {} });
    check('Firma B kan ikke momstjekke Firma A\'s lead', bVat.status === 404);

    // ── Options endpoint feeds the frontend both axes ────────────────────────
    section('Valgmuligheder til frontenden');
    const opts = await call('/api/meta/options', { token: tokenA });
    check('options leverer opkaldsudfald', Array.isArray(opts.json?.statuses) && opts.json.statuses.length > 0);
    // Ikke et hårdkodet antal: det tal skal rettes hver gang stigen ændres,
    // og en fejl siger så kun "det er ikke 6" uden at sige hvad der mangler.
    // Her sammenlignes med kilden, og at hvert trin har en etiket at vise.
    const { PIPELINE_STAGES } = require('../config/cvrOptions');
    const stadier = opts.json?.stages;
    check('options leverer pipeline-stadier',
      Array.isArray(stadier)
        && stadier.map((s) => s.value).join(',') === PIPELINE_STAGES.map((s) => s.value).join(',')
        && stadier.every((s) => typeof s.label === 'string' && s.label.length > 0),
      JSON.stringify(stadier?.map((s) => s.value)));
    check('selskabsformer bruger numeriske koder',
      typeof opts.json?.companyForms?.[0]?.value === 'number', JSON.stringify(opts.json?.companyForms?.[0]));

    // ── Forudbetalte pladser ─────────────────────────────────────────────────
    section('Forudbetalte pladser');
    cvr.lookupCompany = async (nr) => ({
      cvr: nr, name: `Virksomhed ${nr} ApS`, city: 'Odense', advertisingProtected: false,
    });

    const pladsOpret = await call('/api/auth/register', {
      method: 'POST',
      body: { name: 'Plads Ejer', cvr: '87654321', email: 'plads@example.dk',
              password: 'langnokkode123', pladser: 2 } });
    check('ekstra brugere kan vælges ved oprettelsen', pladsOpret.status === 201,
      JSON.stringify(pladsOpret.json));
    const pladsToken = pladsOpret.json?.token;

    const forMangeValgt = await call('/api/auth/register', {
      method: 'POST',
      body: { name: 'For Mange', cvr: '87654322', email: 'formange@example.dk',
              password: 'langnokkode123', pladser: 999 } });
    check('et urimeligt antal pladser afvises', forMangeValgt.status === 400);

    const pladsStatus = await call('/api/billing/status', { token: pladsToken });
    check('status viser de valgte pladser, kapaciteten og prisen',
      pladsStatus.json?.team?.betaltePladser === 2
        && pladsStatus.json?.team?.kapacitet === 3
        && pladsStatus.json?.team?.ialt === 179 + 2 * 99,
      JSON.stringify(pladsStatus.json?.team));

    const pladsKollega = (n) => call('/api/auth/team', {
      method: 'POST', token: pladsToken,
      body: { name: `Plads ${n}`, email: `plads${n}@example.dk`, password: 'langnokkode123' } });
    check('første købte plads kan bruges', (await pladsKollega(1)).status === 201);
    check('anden købte plads kan bruges', (await pladsKollega(2)).status === 201);
    const pladsFuld = await pladsKollega(3);
    check('når pladserne er brugt, afvises flere brugere',
      pladsFuld.status === 409 && pladsFuld.json.code === 'NO_SEATS', JSON.stringify(pladsFuld.json));
    const pladsFuldInv = await call('/api/auth/team/invitations', {
      method: 'POST', token: pladsToken, body: { name: 'Inv', email: 'pladsinv@example.dk' } });
    check('en invitation kræver også en ledig plads',
      pladsFuldInv.status === 409 && pladsFuldInv.json.code === 'NO_SEATS');

    const underBrugt = await call('/api/billing/seats', {
      method: 'POST', token: pladsToken, body: { pladser: 1 } });
    check('pladserne kan ikke sættes under det antal, der er i brug',
      underBrugt.status === 409 && underBrugt.json.code === 'SEATS_IN_USE', JSON.stringify(underBrugt.json));
    const ugyldigtAntal = await call('/api/billing/seats', {
      method: 'POST', token: pladsToken, body: { pladser: -1 } });
    check('et negativt antal afvises', ugyldigtAntal.status === 400);

    const flerePladser = await call('/api/billing/seats', {
      method: 'POST', token: pladsToken, body: { pladser: 4 } });
    check('uden abonnement gemmes det nye antal til betalingen',
      flerePladser.status === 200 && flerePladser.json?.afventerBetaling === true,
      JSON.stringify(flerePladser.json));
    check('den nye plads kan bruges med det samme', (await pladsKollega(3)).status === 201);

    // Token laves direkte: login er begrænset til ti forsøg i kvarteret, og
    // dem har testen allerede brugt.
    const { signToken } = require('../middleware/auth');
    const pladsSaelger = (await db.query(
      "SELECT id, org_id, email, role, name FROM users WHERE email = 'plads1@example.dk'")).rows[0];
    const pladsSaelgerToken = signToken(pladsSaelger);
    const saelgerKoeber = await call('/api/billing/seats', {
      method: 'POST', token: pladsSaelgerToken, body: { pladser: 10 } });
    check('en sælger kan ikke købe pladser', saelgerKoeber.status === 403, String(saelgerKoeber.status));

    // En betalende konto: pladserne kommer fra abonnementet, ikke fra ønsket.
    const pladsOrgId = (await db.query(
      `SELECT org_id FROM users WHERE email = 'plads@example.dk'`)).rows[0].org_id;
    await db.query(
      `UPDATE organizations SET stripe_subscription_id = 'sub_test', subscription_status = 'active',
              paid_seats = 3 WHERE id = $1`, [pladsOrgId]);
    const betaltStatus = await call('/api/billing/status', { token: pladsToken });
    check('en betalende konto har de pladser, abonnementet har',
      betaltStatus.json?.team?.betaltePladser === 3 && betaltStatus.json?.team?.kapacitet === 4
        && betaltStatus.json?.team?.ledige === 0,
      JSON.stringify(betaltStatus.json?.team));
    check('en fuld betalende konto afviser flere', (await pladsKollega(4)).status === 409);
    const udenStripe = await call('/api/billing/seats', {
      method: 'POST', token: pladsToken, body: { pladser: 5 } });
    check('uden Stripe kan et abonnement ikke ændres, og det siges ærligt',
      udenStripe.status === 503, JSON.stringify(udenStripe.json));

    // ── Ringelister pr. medarbejder ──────────────────────────────────────────
    section('Ringelister pr. medarbejder');
    const tokenMaria = mariaAccept.json?.token;
    const mariaId = mariaAccept.json?.user?.id;
    const tokenTom = tomAccept.json?.token;
    const tomId = tomAccept.json?.user?.id;

    const kampagne = await call('/api/lists', {
      method: 'POST', token: tokenA,
      body: { name: 'Kampagne Maria', filters: { industryCodes: ['620200'], region: 'fyn' },
              limit: 1000, assignedTo: mariaId } });
    check('ejeren kan oprette en liste direkte til en medarbejder',
      kampagne.status === 201 && kampagne.json?.list?.assigned_to === mariaId,
      JSON.stringify(kampagne.json).slice(0, 200));
    const kampagneId = kampagne.json?.list?.id;
    const importeret = kampagne.json?.imported ?? 0;

    const mariasLeads = await db.query(
      'SELECT COUNT(*)::int AS n FROM leads WHERE list_id = $1 AND assigned_to = $2', [kampagneId, mariaId]);
    check('listens virksomheder følger med til medarbejderen',
      importeret > 0 && mariasLeads.rows[0].n === importeret, `${mariasLeads.rows[0].n} af ${importeret}`);

    const mariasLister = await call('/api/lists', { token: tokenMaria });
    check('medarbejderen ser listen med sit navn på',
      mariasLister.json?.lists?.some((l) => l.id === kampagneId && l.assigned_to_name === 'Maria Berg'));
    const tomsLister = await call('/api/lists', { token: tokenTom });
    check('en kollega ser ikke listen',
      Array.isArray(tomsLister.json?.lists) && !tomsLister.json.lists.some((l) => l.id === kampagneId));
    check('en kollega kan ikke åbne listen',
      (await call(`/api/lists/${kampagneId}`, { token: tokenTom })).status === 404);
    check('en kollega kan ikke hente listens virksomheder',
      (await call(`/api/lists/${kampagneId}/leads`, { token: tokenTom })).status === 404);
    const tomsKoe = await call(`/api/leads/next?listId=${kampagneId}`, { token: tokenTom });
    check('listen er tom i kollegaens ringekø', tomsKoe.json?.lead === null, JSON.stringify(tomsKoe.json).slice(0, 120));
    const mariasKoe = await call(`/api/leads/next?listId=${kampagneId}`, { token: tokenMaria });
    check('medarbejderen får hele listen i sin ringekø',
      !!mariasKoe.json?.lead && mariasKoe.json.remaining === importeret, `remaining: ${mariasKoe.json?.remaining}`);

    const saelgerSender = await call(`/api/lists/${kampagneId}`, {
      method: 'PATCH', token: tokenMaria, body: { assignedTo: tomId } });
    check('kun ejeren kan sende lister ud', saelgerSender.status === 403);
    const fremmedModtager = await call(`/api/lists/${kampagneId}`, {
      method: 'PATCH', token: tokenA, body: { assignedTo: orgB.userId } });
    check('en liste kan ikke sendes til en fra en anden virksomhed', fremmedModtager.status === 400);

    const videre = await call(`/api/lists/${kampagneId}`, {
      method: 'PATCH', token: tokenA, body: { assignedTo: tomId } });
    check('ejeren kan sende listen videre til en anden',
      videre.status === 200 && videre.json?.list?.assigned_to === tomId && videre.json?.tildelteLeads === importeret,
      JSON.stringify(videre.json));
    check('den tidligere medarbejder kan ikke længere åbne den',
      (await call(`/api/lists/${kampagneId}`, { token: tokenMaria })).status === 404);

    const tilbage = await call(`/api/lists/${kampagneId}`, {
      method: 'PATCH', token: tokenA, body: { assignedTo: null } });
    const stadigTildelt = await db.query(
      'SELECT COUNT(*)::int AS n FROM leads WHERE list_id = $1 AND assigned_to IS NOT NULL', [kampagneId]);
    check('en liste taget tilbage frigiver sine åbne virksomheder',
      tilbage.status === 200 && tilbage.json?.list?.assigned_to === null && stadigTildelt.rows[0].n === 0,
      `${stadigTildelt.rows[0].n} stadig tildelt`);
    check('en fælles liste kan ses af alle i teamet',
      (await call(`/api/lists/${kampagneId}`, { token: tokenTom })).status === 200);

    await call(`/api/lists/${kampagneId}`, { method: 'PATCH', token: tokenA, body: { assignedTo: mariaId } });
    const teamOverblik = await call('/api/auth/team', { token: tokenA });
    const mariaRaekke = teamOverblik.json?.users?.find((u) => u.id === mariaId);
    check('teamet viser medarbejderens lister og åbne virksomheder',
      mariaRaekke?.lister === 1 && mariaRaekke?.aabne_leads === importeret, JSON.stringify(mariaRaekke));

    const kunMaria = await call(`/api/lists?assignedTo=${mariaId}`, { token: tokenA });
    check('ejeren kan se én medarbejders lister',
      kunMaria.json?.lists?.length === 1 && kunMaria.json.lists[0].id === kampagneId,
      JSON.stringify(kunMaria.json?.lists?.map((l) => l.id)));
    const ikkeSendtUd = await call('/api/lists?assignedTo=none', { token: tokenA });
    check('ejeren kan se de lister, der ikke er sendt ud',
      ikkeSendtUd.json?.lists?.every((l) => l.assigned_to === null)
        && !ikkeSendtUd.json?.lists?.some((l) => l.id === kampagneId));

    const nyVirksomhed = await call(`/api/lists/${kampagneId}/leads`, {
      method: 'POST', token: tokenA, body: { cvr: '55555555' } });
    const arvet = await db.query(
      'SELECT assigned_to FROM leads WHERE list_id = $1 AND cvr = $2', [kampagneId, '55555555']);
    check('nye virksomheder i listen får listens medarbejder',
      arvet.rows[0]?.assigned_to === mariaId, JSON.stringify(nyVirksomhed.json));

    // ── Kontaktformular og beskeder i admin ──────────────────────────────────
    section('Kontaktbeskeder');
    // Tokenet laves direkte: loginbremsen er brugt op af afsnittene ovenfor.
    const platform = await mkOrg('Platform', 'admin@example.dk');
    const adminToken = require('../middleware/auth').signToken({
      id: platform.userId, org_id: platform.orgId, email: 'admin@example.dk', role: 'owner', name: 'Admin' });

    const kontakt = (body, ip = '10.0.0.1') => fetch(`${BASE}/api/kontakt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Klient-IP': ip },
      body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

    const ny = await kontakt({ navn: 'Kunde Karl', epost: 'Karl@Kunde.dk', hvem: 'Tømrere på Fyn\nlinje to' });
    check('kontaktformularen kræver ikke login og gemmer beskeden', ny.status === 201, JSON.stringify(ny.json));
    check('ugyldig e-mail afvises',
      (await kontakt({ navn: 'X', epost: 'ikke-en-mail' })).json?.fejl === 'ugyldig_epost');
    check('manglende navn afvises',
      (await kontakt({ navn: '', epost: 'a@b.dk' })).json?.fejl === 'mangler_felter');
    const robot = await kontakt({ navn: 'Bot', epost: 'bot@spam.dk', hjemmeside: 'http://spam' });
    const robotRækker = await db.query(`SELECT COUNT(*)::int AS n FROM kontakt_beskeder WHERE navn = 'Bot'`);
    check('honeypot: robotten får ok, men intet gemmes', robot.status === 200 && robotRækker.rows[0].n === 0);
    let sidste;
    for (let i = 0; i < 6; i++) sidste = await kontakt({ navn: 'Flood', epost: 'f@f.dk' }, '10.0.0.9');
    check('for mange beskeder fra samme adresse bremses', sidste.status === 429);

    const kundeListe = await call('/api/admin/beskeder', { token: tokenA });
    check('en almindelig kunde kan ikke se beskederne', kundeListe.status === 404);

    const liste = await call('/api/admin/beskeder', { token: adminToken });
    const karl = liste.json?.beskeder?.find((b) => b.navn === 'Kunde Karl');
    check('admin ser beskeden med tekst og små bogstaver i e-mail',
      karl?.epost === 'karl@kunde.dk' && karl?.besked === 'Tømrere på Fyn\nlinje to', JSON.stringify(karl));
    check('den tæller som ulæst', liste.json?.ulaeste >= 1 && karl?.laest_at === null);

    const åbnet = await call(`/api/admin/beskeder/${karl.id}`, { token: adminToken });
    check('at åbne beskeden markerer den som læst', åbnet.json?.besked?.laest_at != null);

    const utenMail = await call(`/api/admin/beskeder/${karl.id}/svar`, {
      method: 'POST', token: adminToken, body: { tekst: 'Hej Karl' } });
    check('uden mailudbyder siges det tydeligt', utenMail.status === 503 && utenMail.json.code === 'MAIL_IKKE_OPSAT');

    const mailSvc = require('../services/mailService');
    const ægte = { k: mailSvc.erKonfigureret, s: mailSvc.sendKontaktSvar };
    const sendte = [];
    mailSvc.erKonfigureret = () => true;
    mailSvc.sendKontaktSvar = async (m) => { sendte.push(m); return true; };
    const svaret = await call(`/api/admin/beskeder/${karl.id}/svar`, {
      method: 'POST', token: adminToken, body: { tekst: 'Hej Karl, velkommen.' } });
    check('svaret sendes til kundens adresse med den oprindelige besked',
      svaret.status === 201 && sendte[0]?.til === 'karl@kunde.dk' && sendte[0]?.oprindelig.startsWith('Tømrere'),
      JSON.stringify(svaret.json));
    mailSvc.sendKontaktSvar = async () => false;
    const fejlet = await call(`/api/admin/beskeder/${karl.id}/svar`, {
      method: 'POST', token: adminToken, body: { tekst: 'Andet forsøg' } });
    check('en fejlet mail giver 502, men svaret gemmes som ikke sendt',
      fejlet.status === 502 && fejlet.json?.svar?.sendt === false);
    Object.assign(mailSvc, { erKonfigureret: ægte.k, sendKontaktSvar: ægte.s });

    const tråd = await call(`/api/admin/beskeder/${karl.id}`, { token: adminToken });
    check('tråden viser begge svar i rækkefølge',
      tråd.json?.svar?.length === 2 && tråd.json.svar[0].sendt && !tråd.json.svar[1].sendt);
    const listeEfter = await call('/api/admin/beskeder', { token: adminToken });
    check('kun sendte svar tælles i oversigten',
      listeEfter.json.beskeder.find((b) => b.id === karl.id)?.svar === 1);

    await call(`/api/admin/beskeder/${karl.id}`, {
      method: 'PATCH', token: adminToken, body: { arkiveret: true } });
    const aktive = await call('/api/admin/beskeder', { token: adminToken });
    const arkiv = await call('/api/admin/beskeder?arkiv=1', { token: adminToken });
    check('en arkiveret besked flytter til arkivet',
      !aktive.json.beskeder.some((b) => b.id === karl.id) && arkiv.json.beskeder.some((b) => b.id === karl.id));
    check('beskeder med skæve id\'er giver 404',
      (await call('/api/admin/beskeder/1%3B', { token: adminToken })).status === 404);

    section('Guides');
    const læs = (slug, token) => call(`/api/guides/${slug}/laest`, { method: 'POST', token });
    check('en guide kræver login', (await læs('kom-i-gang')).status === 401);
    check('åbning registreres', (await læs('kom-i-gang', tokenA)).status === 204);
    await læs('kom-i-gang', tokenA);
    await læs('kom-i-gang', tokenB);
    await læs('regler', friToken); // fritaget konto: tæller ikke med
    await læs('regler', friToken);
    check('skæve navne afvises', (await læs('Ikke_OK', tokenA)).status === 404);
    const gRække = await db.query(
      `SELECT antal FROM guide_visninger g JOIN users u ON u.id = g.user_id
        WHERE u.email = 'a@example.dk' AND slug = 'kom-i-gang'`);
    check('gentagne åbninger tæller op på én række', gRække.rows[0]?.antal === 2);
    check('en kunde kan ikke se guidetallene',
      (await call('/api/admin/guides', { token: tokenA })).status === 404);
    const gTal = (await call('/api/admin/guides', { token: adminToken })).json?.guides ?? [];
    const kig = gTal.find((g) => g.slug === 'kom-i-gang');
    check('admin ser læsere, konti og visninger',
      kig?.laesere === 2 && kig?.konti === 2 && kig?.visninger === 3, JSON.stringify(kig));
    check('fritagne konti tælles ikke med', !gTal.some((g) => g.slug === 'regler'), JSON.stringify(gTal));

    // ── Kunder oprettet fra admin ────────────────────────────────────────────
    section('Kunder oprettet fra admin');
    const kundeMails = [];
    const ægteKunde = mailSvc.sendKundeInvitation;
    mailSvc.sendKundeInvitation = async (m) => { kundeMails.push(m); return true; };
    const opretKunde = (body, token = adminToken) =>
      call('/api/admin/kunder', { method: 'POST', token, body });

    check('en kunde kan ikke oprette kunder',
      (await opretKunde({ cvr: '11112222', navn: 'X', email: 'x@kunde.dk' }, tokenA)).status === 404);
    check('ugyldigt CVR afvises',
      (await opretKunde({ cvr: '123', navn: 'X', email: 'x@kunde.dk' })).status === 400);

    const nyKunde = await opretKunde({ cvr: '11112222', navn: 'Kirsten Kunde', email: 'Kirsten@Kunde.dk', pladser: 0 });
    check('admin opretter kunden med navnet fra CVR',
      nyKunde.status === 201 && nyKunde.json.kunde.navn === 'Virksomhed 11112222 ApS' && nyKunde.json.mailSendt,
      JSON.stringify(nyKunde.json));
    check('mailen går til kontaktpersonen med linket',
      kundeMails[0]?.til === 'kirsten@kunde.dk' && kundeMails[0]?.link === nyKunde.json.link);

    check('samme CVR kan ikke oprettes to gange',
      (await opretKunde({ cvr: '11112222', navn: 'Y', email: 'y@kunde.dk' })).json?.code === 'CVR_TAKEN');
    check('en adresse med konto kan ikke blive ejer',
      (await opretKunde({ cvr: '11113333', navn: 'A', email: 'a@example.dk' })).json?.code === 'EMAIL_TAKEN');

    const kundeId = nyKunde.json.kunde.id;
    const iOverblik = async () => ((await call('/api/admin/overview', { token: adminToken })).json?.konti ?? [])
      .find((k) => k.id === kundeId);
    check('overblikket viser at kunden afventer',
      (await iOverblik())?.afventer_ejer?.email === 'kirsten@kunde.dk', JSON.stringify(await iOverblik()));

    const gammeltToken = nyKunde.json.link.split('/').pop();
    const gensendt = await call(`/api/admin/kunder/${kundeId}/gensend`, { method: 'POST', token: adminToken });
    const nytToken = gensendt.json?.link?.split('/').pop();
    check('invitationen kan sendes igen med et nyt link',
      gensendt.status === 200 && nytToken && nytToken !== gammeltToken && kundeMails.length === 2);
    check('det gamle link virker ikke længere',
      (await call(`/api/auth/invite/${gammeltToken}`)).status === 404);

    const visKunde = await call(`/api/auth/invite/${nytToken}`);
    check('linket viser en ejer-invitation til virksomheden',
      visKunde.json?.invitation?.rolle === 'owner' && visKunde.json?.invitation?.orgNavn === 'Virksomhed 11112222 ApS'
      && visKunde.json?.invitation?.nyKunde === true, JSON.stringify(visKunde.json));

    // Kontoen har ingen ekstra pladser: invitationen ER den ene plads. Talte
    // den med ved sit eget ja, ville kunden aldrig kunne komme ind.
    const kundeInd = await call(`/api/auth/invite/${nytToken}`, {
      method: 'POST', body: { password: 'kundenskode123' } });
    check('kunden vælger adgangskode og bliver ejer',
      kundeInd.status === 201 && kundeInd.json.user.role === 'owner' && kundeInd.json.user.orgId === kundeId,
      JSON.stringify(kundeInd.json));
    const kundeStatus = await call('/api/billing/status', { token: kundeInd.json?.token });
    check('kunden møder den almindelige betaling',
      kundeStatus.status === 200 && kundeStatus.json.fritaget === false, JSON.stringify(kundeStatus.json));
    check('overblikket viser ikke længere en afventende ejer', (await iOverblik())?.afventer_ejer === null);
    check('en aktiveret kunde kan ikke gensendes',
      (await call(`/api/admin/kunder/${kundeId}/gensend`, { method: 'POST', token: adminToken })).status === 409);
    check('en aktiveret kunde kan ikke fortrydes',
      (await call(`/api/admin/kunder/${kundeId}`, { method: 'DELETE', token: adminToken })).status === 409);
    check('en almindelig konto kan ikke slettes herfra',
      (await call(`/api/admin/kunder/${orgA.orgId}`, { method: 'DELETE', token: adminToken })).status === 409);

    const fejltastet = await opretKunde({ cvr: '11114444', navn: 'Fejl', email: 'fejl@kunde.dk' });
    const fortrudt = await call(`/api/admin/kunder/${fejltastet.json.kunde.id}`, { method: 'DELETE', token: adminToken });
    const kundeTilbage = await db.query('SELECT COUNT(*)::int AS n FROM organizations WHERE cvr = $1', ['11114444']);
    check('en oprettelse kan fortrydes før kunden logger ind',
      fortrudt.status === 200 && kundeTilbage.rows[0].n === 0);
    mailSvc.sendKundeInvitation = ægteKunde;

    section('Sletning');
    await call(`/api/lists/${listId}`, { method: 'DELETE', token: tokenA });
    const orphans = await db.query('SELECT COUNT(*)::int AS n FROM leads WHERE list_id = $1', [listId]);
    check('leads slettes med listen', orphans.rows[0].n === 0);
    const orphanActs = await db.query(
      'SELECT COUNT(*)::int AS n FROM lead_activities WHERE lead_id = $1', [someLead]);
    check('aktiviteter slettes med leadet', orphanActs.rows[0].n === 0);

  } finally {
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`${passed} bestået, ${failed} fejlet`);
    await db.pool.end().catch(() => {});
    await pg.stop().catch(() => {});
    fs.rmSync(dataDir, { recursive: true, force: true });
    process.exit(failed ? 1 : 0);
  }
}

main().catch((err) => {
  console.error('\nVERIFIKATION BRØD SAMMEN:', err);
  process.exit(1);
});
