// middleware/auth.js — JWT auth. Every request carries the caller's org_id,
// which every query in the app filters on.
'use strict';

const jwt = require('jsonwebtoken');
const db  = require('../db');

const SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  console.error('[FATAL] JWT_SECRET is not set. Generate one and put it in .env.');
  process.exit(1);
}

const TOKEN_TTL = process.env.JWT_TTL || '12h';
// "Husk mig": et længere token, der fornyes hver gang appen åbnes (GET /auth/me).
// Så forbliver man logget ind, så længe man bruger Lysmera mindst én gang i
// perioden. `husk` står i nyttelasten, så et token der udstedes på ny (ny
// profil, skiftet organisation) beholder samme levetid.
const HUSK_TTL = process.env.JWT_HUSK_TTL || '30d';

function signToken(user, { husk = false } = {}) {
  return jwt.sign(
    { id: user.id, orgId: user.org_id, email: user.email, role: user.role, name: user.name,
      ...(husk ? { husk: true } : {}) },
    SECRET,
    { expiresIn: husk ? HUSK_TTL : TOKEN_TTL }
  );
}

async function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Log ind for at fortsætte.', code: 'NO_TOKEN' });
  }

  let payload;
  try {
    payload = jwt.verify(header.slice(7).trim(), SECRET);
  } catch (err) {
    const expired = err.name === 'TokenExpiredError';
    return res.status(401).json({
      error: expired ? 'Din session er udløbet — log ind igen.' : 'Ugyldigt login.',
      code: expired ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID',
    });
  }

  // A deactivated user must lose access immediately, not when their token
  // happens to expire — so this is checked against the database per request.
  try {
    const { rows } = await db.query(
      'SELECT id, org_id, email, name, role, is_active FROM users WHERE id = $1',
      [payload.id]
    );
    const user = rows[0];
    if (!user || !user.is_active) {
      return res.status(401).json({ error: 'Kontoen er deaktiveret.', code: 'USER_INACTIVE' });
    }
    req.user = user;
    req.orgId = user.org_id;
    req.husk = payload.husk === true;
    next();
  } catch (err) {
    console.error('[auth]', err.message);
    return res.status(500).json({ error: 'Kunne ikke bekræfte login.' });
  }
}

/** Restrict a route to organisation owners. Must follow authenticate. */
function requireOwner(req, res, next) {
  if (req.user?.role !== 'owner') {
    return res.status(403).json({ error: 'Kun ejeren af kontoen kan gøre det.', code: 'FORBIDDEN' });
  }
  next();
}

module.exports = { authenticate, requireOwner, signToken };
