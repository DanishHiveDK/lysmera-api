// services/filterSchema.js — one place that decides what a search filter may
// contain. Both the preview endpoint and the list-extraction endpoint run
// user input through this, so a saved list can never carry fields the preview
// never validated.
'use strict';

const { REGIONS, CATEGORY_VALUES } = require('../config/cvrOptions');

const MAX_TERMS = 50;

function toArray(value, limit = MAX_TERMS) {
  if (value == null) return [];
  const arr = Array.isArray(value) ? value : [value];
  return arr.map((v) => String(v).trim()).filter(Boolean).slice(0, limit);
}

function toInt(value, { min, max } = {}) {
  if (value === '' || value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  if (min != null && rounded < min) return min;
  if (max != null && rounded > max) return max;
  return rounded;
}

function toDate(value) {
  const s = String(value ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

/**
 * Normalise raw request input into the filter object cvrService understands.
 * Unknown keys are dropped rather than passed through.
 */
function sanitizeFilters(raw = {}) {
  const filters = {
    query:            String(raw.query ?? '').trim().slice(0, 120) || null,
    industryCodes:    toArray(raw.industryCodes).filter((c) => /^\d{2,6}$/.test(c)),
    zipCodes:         toArray(raw.zipCodes).filter((z) => /^\d{4}$/.test(z)),
    municipalities:   toArray(raw.municipalities).map((m) => m.slice(0, 60)),
    // Numeric CVR form codes (10 = ENK, 80 = ApS, 60 = A/S, …)
    companyForms:     toArray(raw.companyForms)
                        .map((f) => Number(f))
                        .filter((n) => Number.isInteger(n) && n > 0 && n < 10000),
    zipFrom:          toInt(raw.zipFrom, { min: 1000, max: 9999 }),
    zipTo:            toInt(raw.zipTo,   { min: 1000, max: 9999 }),
    employeesMin:     toInt(raw.employeesMin, { min: 0, max: 500000 }),
    employeesMax:     toInt(raw.employeesMax, { min: 0, max: 500000 }),
    establishedFrom:  toDate(raw.establishedFrom),
    establishedTo:    toDate(raw.establishedTo),
    requirePhone:     raw.requirePhone === true || raw.requirePhone === 'true',
    requireEmail:     raw.requireEmail === true || raw.requireEmail === 'true',
    // 'med' eller 'uden' hjemmeside i CVR. Kun for udvalgte konti — se
    // middleware/funktioner.js; ruterne fjerner det for alle andre.
    website:          ['med', 'uden'].includes(raw.website) ? raw.website : null,
    // Frasorterer virksomheder organisationen allerede har som lead. Bruges
    // i rutelaget, ikke i CVR-forespørgslen — registret kender ikke vores
    // database.
    excludeExisting:  raw.excludeExisting === true || raw.excludeExisting === 'true',
    // Skjulte ryger altid ud; det her beder om at se dem alligevel.
    includeHidden:    raw.includeHidden === true || raw.includeHidden === 'true',
    // Overordnede brancheområder. Oversættes til præfiksopslag i cvrService.
    industryCategories: toArray(raw.industryCategories).filter((v) => CATEGORY_VALUES.includes(v)),
    onlyActive:       raw.onlyActive !== false && raw.onlyActive !== 'false',
    includeAdvertisingProtected: false, // never settable from the client
  };

  // A named region is shorthand for a postcode range.
  if (raw.region) {
    const region = REGIONS.find((r) => r.value === raw.region);
    if (region) {
      filters.zipFrom = region.zipFrom;
      filters.zipTo   = region.zipTo;
      filters.region  = region.value;
    }
  }

  // Swap reversed ranges instead of returning nothing — a reversed range is
  // always a slip, and an empty result set gives the user no clue why.
  if (filters.zipFrom != null && filters.zipTo != null && filters.zipFrom > filters.zipTo) {
    [filters.zipFrom, filters.zipTo] = [filters.zipTo, filters.zipFrom];
  }
  if (filters.employeesMin != null && filters.employeesMax != null
      && filters.employeesMin > filters.employeesMax) {
    [filters.employeesMin, filters.employeesMax] = [filters.employeesMax, filters.employeesMin];
  }

  // Strip empties so the stored JSON stays readable
  for (const [k, v] of Object.entries(filters)) {
    if (v == null || (Array.isArray(v) && v.length === 0)) delete filters[k];
  }
  return filters;
}

/** True when nothing meaningful was supplied — used to block "extract everything". */
function isEmptyFilter(filters) {
  const meaningful = ['query', 'industryCodes', 'zipCodes', 'municipalities', 'companyForms',
    'zipFrom', 'zipTo', 'employeesMin', 'employeesMax', 'establishedFrom', 'establishedTo'];
  // En kategori indsnævrer lige så meget som en branchekode.
  if (filters.industryCategories?.length) return false;
  return !meaningful.some((k) => filters[k] != null);
}

module.exports = { sanitizeFilters, isEmptyFilter };
