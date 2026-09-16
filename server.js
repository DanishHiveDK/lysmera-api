// server.js — Lysmera API. Serves the built frontend from dist/ in production;
// in development Vite serves the frontend and proxies /api here.
'use strict';

require('dotenv').config();

const path        = require('path');
const fs          = require('fs');
const express     = require('express');
const helmet      = require('helmet');
const cors        = require('cors');
const compression = require('compression');

const db  = require('./db');
const cvr = require('./services/cvrService');

const app  = express();
const PORT = Number(process.env.PORT) || 4000;

app.set('trust proxy', 1); // behind Railway's proxy — needed for rate limiting by IP
app.disable('x-powered-by');

app.use(helmet({
  // The SPA is same-origin; the default CSP would block the Vite bundle.
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));
app.use(compression());

// Stripes webhook skal have den RÅ body for at signaturen kan verificeres, så
// den monteres før JSON-parseren. Bliver den parset og serialiseret igen,
// afvises hver eneste begivenhed.
app.use('/webhooks', require('./routes/stripeWebhook'));

app.use(express.json({ limit: '1mb' }));

const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5173')
  .split(',').map((o) => o.trim()).filter(Boolean);

/**
 * The frontend lives in its own repo and is served from another origin, so
 * CORS_ORIGINS is what lets it talk to this API at all — it is not optional in
 * production.
 *
 * Same-origin requests must always pass too. When this service also serves a
 * built SPA, the browser DOES send an Origin header for Vite's `crossorigin`
 * module script — rejecting it turns the whole app into a blank page, and curl
 * won't reproduce it because curl sends no Origin.
 */
function originAllowed(origin, req) {
  if (!origin) return true; // no Origin header: same-origin doc or server-side caller
  if (allowedOrigins.includes(origin)) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

const corsMiddleware = cors((req, callback) => {
  callback(null, { origin: originAllowed(req.headers.origin, req), credentials: false });
});

// Static assets are same-origin and need no CORS headers at all — scoping this
// to the API keeps one misconfigured origin from taking the frontend down.
app.use('/api', corsMiddleware);
app.use('/health', corsMiddleware);

// ── Routes ───────────────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  let dbOk = false;
  try {
    await db.query('SELECT 1');
    dbOk = true;
  } catch { /* reported below */ }
  res.status(dbOk ? 200 : 503).json({
    status: dbOk ? 'ok' : 'degraded',
    db: dbOk,
    cvr: cvr.hasVirkCredentials() ? 'virk' : 'cvrapi-fallback',
  });
});

app.use('/api/auth', require('./routes/auth'));
app.use('/api/billing', require('./routes/billing'));
app.use('/api/admin', require('./routes/admin'));
// Offentlig: kontaktformularen på lysmera.dk. Skal stå før login-muren.
app.use('/api/kontakt', require('./routes/kontakt'));
// Guiderne er gratis og skal kunne læses uden abonnement.
app.use('/api/guides', require('./routes/guides'));

// Alt herunder kræver et aktivt abonnement eller en løbende prøveperiode.
// Spærringen ligger her og ikke kun i frontendens sløring: en sløret skærm
// kan omgås med et enkelt kald direkte til API'et.
//
// `authenticate` skal køre først — uden den er req.orgId ikke sat, og muren
// ville lade alt passere. Samtlige ruter herunder kræver login i forvejen.
const { authenticate } = require('./middleware/auth');
const requireSubscription = require('./middleware/subscription');
app.use('/api', authenticate, requireSubscription);

app.use('/api', require('./routes/search'));
app.use('/api', require('./routes/lists'));
app.use('/api', require('./routes/leads'));

app.use('/api', (req, res) => res.status(404).json({ error: 'Endpoint findes ikke.' }));

// ── Optional single-service mode ─────────────────────────────────────────────
// The frontend (lysmera-web) normally deploys separately. Drop its build
// output in ./dist here and this service will serve it too — useful for a
// quick demo from one URL, and it keeps the door open if the split ever turns
// out not to be worth it.
const DIST = path.join(__dirname, 'dist');
if (fs.existsSync(DIST)) {
  app.use(express.static(DIST));
  // SPA fallback — client-side routing owns everything that isn't /api.
  app.get('*', (req, res) => res.sendFile(path.join(DIST, 'index.html')));
} else {
  app.get('/', (req, res) => res.json({
    service: 'lysmera-api',
    health: '/health',
    note: 'Brugerfladen ligger i lysmera-web og deployes for sig.',
  }));
}

// ── Error handler ────────────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars -- Express needs the 4-arg signature
app.use((err, req, res, next) => {
  console.error('[unhandled]', err.message);
  // Never echo err.message to the client — it can carry connection strings.
  res.status(500).json({ error: 'Der skete en uventet fejl.' });
});

const server = app.listen(PORT, () => {
  console.log(`Lysmera API kører på http://localhost:${PORT}`);
  console.log(`[CORS] Tillader: ${allowedOrigins.join(', ')} (+ samme origin)`);

  if (!cvr.hasVirkCredentials()) {
    console.warn('[CVR] VIRK_USERNAME/VIRK_PASSWORD mangler — udtræk er slået fra.');
    console.warn('[CVR] Enkeltopslag falder tilbage på cvrapi.dk.');
  }
  // The frontend is on another origin in production, so an unset CORS_ORIGINS
  // means every request from it is blocked and the app looks broken with no
  // error in the server log. Say so at boot rather than letting them hunt.
  if (process.env.NODE_ENV === 'production' && !process.env.CORS_ORIGINS) {
    console.warn('[CORS] ADVARSEL: CORS_ORIGINS er ikke sat i produktion.');
    console.warn('[CORS] Frontenden vil blive blokeret. Sæt fx CORS_ORIGINS=https://app.lysmera.dk');
  }
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`\n${signal} modtaget — lukker ned.`);
    server.close(() => db.pool.end().then(() => process.exit(0)));
  });
}

module.exports = app;
