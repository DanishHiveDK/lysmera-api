// middleware/funktioner.js — funktioner, der kun er slået til for udvalgte konti.
//
// Hjemmesidefilteret er bygget til Look-A's eget hjemmesidesalg: find
// nyregistrerede firmaer uden hjemmeside. Det er ikke en del af det, kunderne
// betaler for, så det er slået til pr. adresse frem for for alle.
//
// Indehaveren står i koden, så en glemt variabel ikke slår det fra. Flere
// tilføjes via HJEMMESIDEFILTER_EMAILS (kommasepareret) uden en udrulning.
'use strict';

const HJEMMESIDEFILTER = new Set(
  ['lucca@look-a.dk']
    .concat((process.env.HJEMMESIDEFILTER_EMAILS || '').split(','))
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
);

function harHjemmesideFilter(email) {
  return HJEMMESIDEFILTER.has(String(email || '').trim().toLowerCase());
}

/**
 * Fjern filtre, brugeren ikke har adgang til. Kaldes lige efter
 * sanitizeFilters i ruterne — klienten skjuler valget, men det er serveren,
 * der afgør det.
 */
function begrænsFiltre(filters, email) {
  if (!harHjemmesideFilter(email)) delete filters.website;
  return filters;
}

module.exports = { harHjemmesideFilter, begrænsFiltre };
