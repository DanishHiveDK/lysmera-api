// services/cvrService.js — company extraction from the Danish CVR registry.
//
// Primary provider is Virk Distribution (Erhvervsstyrelsen's system-to-system
// access), an Elasticsearch index over the full register. That is the only
// source that supports bulk filtering by industry, geography and size — which
// is what a lead extraction actually is.
//
// cvrapi.dk is kept as a fallback for SINGLE-company lookups so the app still
// does something useful before Virk credentials are in place. It cannot filter.
'use strict';

const { divisionsForCategories } = require('../config/cvrOptions');

const VIRK_BASE  = (process.env.VIRK_BASE_URL || 'http://distribution.virk.dk').replace(/\/+$/, '');
const VIRK_INDEX = (process.env.VIRK_INDEX || 'cvr-permanent/_search').replace(/^\/+/, '');
const VIRK_USER  = process.env.VIRK_USERNAME || '';
const VIRK_PASS  = process.env.VIRK_PASSWORD || '';

const CVRAPI_UA = process.env.CVRAPI_USER_AGENT
  || 'Lysmera lead research - hej@lysmera.dk';

// Excluding advertising-protected companies is a legal requirement when CVR
// data is used for marketing, so it defaults to on and only an explicit
// "false" turns it off.
const EXCLUDE_PROTECTED = process.env.EXCLUDE_ADVERTISING_PROTECTED !== 'false';

const FIELD = 'Vrvirksomhed';
const META  = `${FIELD}.virksomhedMetadata`;

/** Statuses that mean the company is trading. Everything else is dead or dying. */
const ACTIVE_STATUSES = ['NORMAL', 'AKTIV'];

/**
 * CVR reports headcount in four separate places and no company has all of
 * them. Ordered freshest-first: the Erhvervsstyrelsen monthly figure is
 * current but only covers ~300k companies, while the annual figure is older
 * and covers ~900k. Reading and filtering both means a size filter doesn't
 * silently drop everyone whose newest number happens to live elsewhere.
 *
 * There is NO `nyesteAntalAnsatte` field, despite what the field naming
 * elsewhere in the schema suggests.
 */
const EMPLOYMENT_FIELDS = [
  'nyesteErstMaanedsbeskaeftigelse',
  'nyesteMaanedsbeskaeftigelse',
  'nyesteKvartalsbeskaeftigelse',
  'nyesteAarsbeskaeftigelse',
];

/** Best coverage of the four — used to order results by company size. */
const SORT_EMPLOYMENT_FIELD = `${META}.nyesteAarsbeskaeftigelse.antalAnsatte`;

/**
 * Most CVR string fields are indexed as analysed `text`, not `keyword`, so a
 * `terms` query silently matches NOTHING ("Odense" is indexed as the token
 * "odense"). match_phrase runs the same analyser over the input, so it works
 * regardless of case. Numeric and boolean fields are exempt.
 */
function anyPhrase(field, values) {
  return {
    bool: {
      should: values.map((v) => ({ match_phrase: { [field]: v } })),
      minimum_should_match: 1,
    },
  };
}

function hasVirkCredentials() {
  return Boolean(VIRK_USER && VIRK_PASS);
}

class CvrError extends Error {
  constructor(message, status = 502, code = 'CVR_ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// ── Query building ───────────────────────────────────────────────────────────

/**
 * Translate Lysmera search filters into an Elasticsearch query.
 *
 * filters = {
 *   query, industryCodes[], zipFrom, zipTo, zipCodes[], municipalities[],
 *   companyForms[], employeesMin, employeesMax, establishedFrom, establishedTo,
 *   requirePhone, requireEmail, website ('med'|'uden'), onlyActive,
 *   includeAdvertisingProtected
 * }
 */
/**
 * Indekset folder danske bogstaver: æ→ae, ø→oe, å→aa.
 *
 * Efterprøvet mod registret, ikke gættet:
 *     prefix "tandlæge"  →     0 træffere
 *     prefix "tandlaege" →  4977
 *     prefix "århus"     →     0
 *     prefix "aarhus"    →  3727
 *
 * `match` analyserer selv sit input og folder derfor med. `prefix` gør IKKE,
 * så foldningen skal ske her. Uden den ville hvert eneste søgeord med æ, ø
 * eller å give nul træffere — altså det meste af dansk.
 */
function foldDansk(s) {
  return String(s)
    .toLowerCase()
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'oe')
    .replace(/å/g, 'aa');
}

/**
 * Navnesøgning.
 *
 * Var før en `match` med operator AND. Den slår op på HELE ord, og dansk
 * sætter ord sammen: "Sexologisk Klinik" er tokenet "sexologisk", som et
 * opslag på "sex" aldrig rammer. Målt mod registret gav det:
 *
 *     "sex"       19 af mindst 101
 *     "erotik"     4 af 8
 *     "tandlæge" 1980 af 3525
 *
 * Nu bliver hvert ord til en `prefix`, og de lægges sammen med OG, så
 * "erotik shop" stadig kræver begge dele.
 *
 * Hvorfor prefix og ikke wildcard `*ord*`: wildcard finder også ord hvor
 * søgeordet ligger inde midt i et andet ord, og på dansk giver det ravage.
 * `*sex*` fandt "Smørebrødsexperten" og "GRÆSRODSEXPORT" — sammensætninger
 * hvor "…ds" + "ex…" tilfældigvis danner strengen. En sælger, der leder efter
 * erotikbranchen, skal ikke have en smørrebrødsforretning i listen.
 *
 * Det præcise navn lægges oveni som `should`, så det ranker først uden at
 * udelukke resten.
 */
function buildNameQuery(raw) {
  const ord = foldDansk(raw)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6);            // Loft, så en indsat tekst ikke bygger en kæmpe forespørgsel.
  if (!ord.length) return null;

  return {
    bool: {
      must: ord.map((o) => ({ prefix: { [`${META}.nyesteNavn.navn`]: o } })),
      should: [{ match_phrase: { [`${META}.nyesteNavn.navn`]: String(raw).trim() } }],
    },
  };
}

function buildQuery(filters = {}) {
  const must = [];
  const mustNot = [];
  const filter = [];

  if (filters.query) {
    const navneQuery = buildNameQuery(filters.query);
    if (navneQuery) must.push(navneQuery);
  }

  // Brancher kan komme to veje: præcise koder, og overordnede områder der
  // oversættes til præfikser på hovedafdelingen (86 = alt inden for sundhed).
  //
  // De lægges sammen med ELLER, ikke OG. En virksomhed har én hovedbranche, så
  // "sundhed OG el-installation" ville altid give nul — det brugeren mener er
  // "vis mig begge dele".
  const codes = (filters.industryCodes || []).map((c) => String(c).trim()).filter(Boolean);
  const divisions = divisionsForCategories(filters.industryCategories || []);

  if (codes.length || divisions.length) {
    const should = [];
    if (codes.length) {
      should.push({ terms: { [`${META}.nyesteHovedbranche.branchekode`]: codes } });
    }
    for (const d of divisions) {
      should.push({ prefix: { [`${META}.nyesteHovedbranche.branchekode`]: d } });
    }
    filter.push({ bool: { should, minimum_should_match: 1 } });
  }

  const zips = (filters.zipCodes || []).map((z) => String(z).trim()).filter(Boolean);
  if (zips.length) {
    filter.push({ terms: { [`${META}.nyesteBeliggenhedsadresse.postnummer`]: zips } });
  }
  if (filters.zipFrom || filters.zipTo) {
    const range = {};
    if (filters.zipFrom) range.gte = Number(filters.zipFrom);
    if (filters.zipTo)   range.lte = Number(filters.zipTo);
    filter.push({ range: { [`${META}.nyesteBeliggenhedsadresse.postnummer`]: range } });
  }

  const municipalities = (filters.municipalities || []).map((m) => String(m).trim()).filter(Boolean);
  if (municipalities.length) {
    filter.push(anyPhrase(`${META}.nyesteBeliggenhedsadresse.kommune.kommuneNavn`, municipalities));
  }

  // Filter on the numeric form code, not the "APS"/"A/S" text: the code is an
  // integer field with 99.9% coverage, so it matches exactly and can't be
  // defeated by the analyser.
  const formCodes = (filters.companyForms || [])
    .map((f) => Number(f)).filter((n) => Number.isInteger(n));
  if (formCodes.length) {
    filter.push({ terms: { [`${META}.nyesteVirksomhedsform.virksomhedsformkode`]: formCodes } });
  }

  if (filters.employeesMin != null || filters.employeesMax != null) {
    const range = {};
    if (filters.employeesMin != null) range.gte = Number(filters.employeesMin);
    if (filters.employeesMax != null) range.lte = Number(filters.employeesMax);
    filter.push({
      bool: {
        should: EMPLOYMENT_FIELDS.map((f) => ({ range: { [`${META}.${f}.antalAnsatte`]: range } })),
        minimum_should_match: 1,
      },
    });
  }

  if (filters.establishedFrom || filters.establishedTo) {
    const range = {};
    if (filters.establishedFrom) range.gte = filters.establishedFrom;
    if (filters.establishedTo)   range.lte = filters.establishedTo;
    filter.push({ range: { [`${META}.stiftelsesDato`]: range } });
  }

  // Default to trading companies only — a bankrupt company is not a lead.
  if (filters.onlyActive !== false) {
    filter.push(anyPhrase(`${META}.sammensatStatus`, ACTIVE_STATUSES));
  }

  // Respect CVR advertising protection. The env default can only be loosened
  // per-search when the operator has explicitly opted in.
  const includeProtected = filters.includeAdvertisingProtected === true && !EXCLUDE_PROTECTED;
  if (!includeProtected) {
    mustNot.push({ term: { [`${FIELD}.reklamebeskyttet`]: true } });
  }

  if (filters.requirePhone) {
    // Cheap pre-filter only. It cannot tell a current number from one that
    // expired in 2002, because the validity period sits in a sibling object
    // that Elasticsearch can't constrain here — applyPostFilters does the
    // real work once the record is normalised.
    filter.push({ exists: { field: `${FIELD}.telefonNummer.kontaktoplysning` } });
  }

  if (filters.requireEmail) {
    // Samme forbehold som ved telefon: gyldighedsperioden ligger i et
    // sideordnet objekt, så det her er kun en billig forhåndsfrasortering.
    // applyPostFilters gør det rigtige arbejde bagefter.
    filter.push({ exists: { field: `${FIELD}.elektroniskPost.kontaktoplysning` } });
  }

  if (filters.website === 'med') {
    // Billig forhåndsfrasortering som ved telefon og mail; applyPostFilters
    // smider dem ud, hvis eneste hjemmeside er udløbet.
    filter.push({ exists: { field: `${FIELD}.hjemmeside.kontaktoplysning` } });
  } else if (filters.website === 'uden') {
    // Her er det omvendt: ingen post overhovedet. Et firma, hvis eneste
    // hjemmeside er udløbet, kommer derfor ikke med — det er prisen for at
    // tallet i toppen passer. Efterfiltrering ville give sider med færre end
    // 25 og et total, der lyver.
    mustNot.push({ exists: { field: `${FIELD}.hjemmeside.kontaktoplysning` } });
  }

  const bool = {};
  if (must.length)    bool.must = must;
  if (filter.length)  bool.filter = filter;
  if (mustNot.length) bool.must_not = mustNot;

  return Object.keys(bool).length ? { bool } : { match_all: {} };
}

// ── Normalisation ────────────────────────────────────────────────────────────

/** Pick the currently valid entry from a CVR period-stamped array. */
function currentValue(entries, { allowSecret = false } = {}) {
  if (!Array.isArray(entries)) return null;
  const valid = entries.filter((e) => {
    if (!e?.kontaktoplysning) return false;
    if (!allowSecret && e.hemmelig === true) return false; // unlisted — do not call
    return !e.periode?.gyldigTil; // no end date = still current
  });
  const chosen = valid.length ? valid[valid.length - 1] : null;
  return chosen?.kontaktoplysning ?? null;
}

function formatAddress(a) {
  if (!a) return null;
  const street = [a.vejnavn, a.husnummerFra].filter(Boolean).join(' ');
  const houseSuffix = [a.bogstavFra, a.etage && `${a.etage}.`, a.sidedoer]
    .filter(Boolean).join(' ');
  return [street, houseSuffix].filter(Boolean).join(' ').trim() || null;
}

/**
 * Headcount from the freshest of CVR's four employment records that actually
 * has a number. Returns the year too, so the UI can say how old the figure is
 * — an annual number from 2018 is not the same claim as this month's.
 */
function readEmployment(meta) {
  for (const field of EMPLOYMENT_FIELDS) {
    const e = meta?.[field];
    if (e && e.antalAnsatte != null) {
      return {
        employees: e.antalAnsatte,
        employeesInterval: e.intervalKodeAntalAnsatte ?? null,
        employeesYear: e.aar ?? null,
      };
    }
  }
  return { employees: null, employeesInterval: null, employeesYear: null };
}

/**
 * The person behind the company — what a salesperson actually wants to ask
 * for by name.
 *
 * `deltagerRelation` lists every participant with the organisations they sit
 * in; the role names live in `organisationer[].organisationsNavn[].navn`
 * ("Direktion", "Stiftere", "EJERREGISTER", "Bestyrelse"). Roles are ranked so
 * a one-person ApS surfaces its director rather than an auditor.
 *
 * Only PERSON participants are returned. A parent company as owner is a fact
 * about ownership, not somebody you can ring.
 */
const ROLE_PRIORITY = [
  [/direkt/i,       'Direktør'],
  [/indehaver/i,    'Indehaver'],
  [/ejerregister/i, 'Ejer'],
  [/reelle ejere/i, 'Reel ejer'],
  [/fuldt ansvarlig deltager/i, 'Ansvarlig deltager'],
  // Sole traders and partnerships file their owner under "Interessenter".
  [/interessent/i,  'Indehaver'],
  [/stifter/i,      'Stifter'],
  [/bestyrelse/i,   'Bestyrelse'],
];

// A human participant is typed PERSON, but foreign individuals and others
// without a Danish CPR come through as ANDEN_DELTAGER — excluding those loses
// the director of plenty of small companies. VIRKSOMHED is a parent company:
// a fact about ownership, not somebody you can ring.
const HUMAN_TYPES = new Set(['PERSON', 'ANDEN_DELTAGER']);

function readOwner(v) {
  const relations = Array.isArray(v?.deltagerRelation) ? v.deltagerRelation : [];
  let best = null;

  for (const rel of relations) {
    if (!HUMAN_TYPES.has(rel?.deltager?.enhedstype)) continue;

    // Names are period-stamped; the last entry is the current one.
    const names = rel.deltager.navne ?? [];
    const name = names.length ? names[names.length - 1]?.navn : null;
    if (!name) continue;

    const roleNames = (rel.organisationer ?? [])
      .flatMap((o) => (o.organisationsNavn ?? []).map((n) => n.navn))
      .filter(Boolean);

    // This participant's highest-ranking role, if any.
    const rank = ROLE_PRIORITY.findIndex(([p]) => roleNames.some((r) => p.test(r)));
    const candidate = rank === -1
      // Someone with no recognised role still beats nobody, but ranks last.
      ? { name, role: null, rank: ROLE_PRIORITY.length }
      : { name, role: ROLE_PRIORITY[rank][1], rank };

    if (!best || candidate.rank < best.rank) best = candidate;
  }

  // Count only the people — a salesperson reading "3 deltagere" should not be
  // counting holding companies.
  const humanCount = relations.filter((r) => HUMAN_TYPES.has(r?.deltager?.enhedstype)).length;

  return best
    ? { ownerName: best.name, ownerRole: best.role, ownerCount: humanCount }
    : { ownerName: null, ownerRole: null, ownerCount: humanCount };
}

/**
 * `attributter` is a loose key/value bag. FORMÅL — the company's own statement
 * of what it does — beats an industry code for qualifying a lead, and KAPITAL
 * hints at how substantial a brand-new company is.
 */
function readAttributes(v) {
  const out = { purpose: null, capital: null, capitalCurrency: null };
  for (const attr of v?.attributter ?? []) {
    const value = attr?.vaerdier?.length ? attr.vaerdier[attr.vaerdier.length - 1]?.vaerdi : null;
    if (value == null) continue;
    if (attr.type === 'FORMÅL')        out.purpose = String(value).slice(0, 2000);
    if (attr.type === 'KAPITAL')       out.capital = Number(value) || null;
    if (attr.type === 'KAPITALVALUTA') out.capitalCurrency = String(value);
  }
  return out;
}

/**
 * Danish region from the postcode. CVR carries the municipality but not the
 * region, and the partner's UI filters on region.
 */
function regionFromZip(zip) {
  const n = Number(zip);
  if (!Number.isFinite(n)) return null;
  if (n >= 1000 && n <= 2999) return 'Hovedstaden';
  if (n >= 3000 && n <= 3699) return 'Hovedstaden';
  if (n >= 3700 && n <= 3799) return 'Hovedstaden';   // Bornholm
  if (n >= 4000 && n <= 4999) return 'Sjælland';
  if (n >= 5000 && n <= 5999) return 'Syddanmark';    // Fyn
  if (n >= 6000 && n <= 6999) return 'Syddanmark';
  if (n >= 7000 && n <= 7999) return 'Midtjylland';
  if (n >= 8000 && n <= 8999) return 'Midtjylland';
  if (n >= 9000 && n <= 9999) return 'Nordjylland';
  return null;
}

/** Map one Virk `_source` document to the flat shape Lysmera stores. */
function normalizeVirk(source) {
  const v = source?.[FIELD] ?? source?.Vrvirksomhed ?? {};
  const m = v.virksomhedMetadata ?? {};
  const addr = m.nyesteBeliggenhedsadresse ?? {};
  const employment = readEmployment(m);
  const owner = readOwner(v);
  const attrs = readAttributes(v);
  const zipcode = addr.postnummer != null ? String(addr.postnummer) : null;

  return {
    cvr:                 v.cvrNummer != null ? String(v.cvrNummer) : null,
    name:                m.nyesteNavn?.navn ?? null,
    address:             formatAddress(addr),
    zipcode,
    city:                addr.postdistrikt ?? null,
    municipality:        addr.kommune?.kommuneNavn ?? null,
    region:              regionFromZip(zipcode),
    phone:               currentValue(v.telefonNummer),
    email:               currentValue(v.elektroniskPost),
    website:             currentValue(v.hjemmeside),
    industryCode:        m.nyesteHovedbranche?.branchekode ?? null,
    industryText:        m.nyesteHovedbranche?.branchetekst ?? null,
    companyType:         m.nyesteVirksomhedsform?.kortBeskrivelse ?? null,
    employees:           employment.employees,
    employeesInterval:   employment.employeesInterval,
    employeesYear:       employment.employeesYear,
    establishedOn:       m.stiftelsesDato ?? null,
    status:              m.sammensatStatus ?? null,
    advertisingProtected: v.reklamebeskyttet === true,

    // The person to ask for, and what the company says it does.
    ownerName:           owner.ownerName,
    ownerRole:           owner.ownerRole,
    ownerCount:          owner.ownerCount,
    purpose:             attrs.purpose,
    capital:             attrs.capital,
    capitalCurrency:     attrs.capitalCurrency,
  };
}

/**
 * cvrapi.dk returns dates as Danish text ("28/11 - 1931"), not ISO. The
 * established_on column is a DATE, so this has to be converted or the insert
 * fails. Virk already returns ISO, so only the fallback needs it.
 */
function parseDanishDate(value) {
  if (!value) return null;
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})\s*\/\s*(\d{1,2})\s*-\s*(\d{4})$/);
  if (!m) return null;
  const [, day, month, year] = m;
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

/** Map a cvrapi.dk response to the same shape. */
function normalizeCvrApi(d) {
  return {
    cvr:                 d.vat != null ? String(d.vat) : null,
    name:                d.name ?? null,
    address:             d.address ?? null,
    zipcode:             d.zipcode != null ? String(d.zipcode) : null,
    city:                d.city ?? null,
    municipality:        d.municipality?.name ?? null,
    phone:               d.phone ?? null,
    email:               d.email ?? null,
    website:             d.website ?? null,
    industryCode:        d.industrycode != null ? String(d.industrycode) : null,
    industryText:        d.industrydesc ?? null,
    companyType:         d.companydesc ?? null,
    employees:           d.employees != null ? Number(d.employees) : null,
    employeesInterval:   null,
    establishedOn:       parseDanishDate(d.startdate),
    status:              d.enddate ? 'OPHØRT' : 'NORMAL',
    advertisingProtected: d.protected === true,
  };
}

// ── Virk transport ───────────────────────────────────────────────────────────

async function virkFetch(pathname, body, { timeoutMs = 30000 } = {}) {
  if (!hasVirkCredentials()) {
    throw new CvrError(
      'Virk Distribution-adgang mangler. Sæt VIRK_USERNAME og VIRK_PASSWORD i .env.',
      503, 'CVR_NOT_CONFIGURED'
    );
  }

  const auth = Buffer.from(`${VIRK_USER}:${VIRK_PASS}`).toString('base64');
  let res;
  try {
    res = await fetch(`${VIRK_BASE}/${pathname}`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json',
        'User-Agent': CVRAPI_UA,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new CvrError('CVR-registret svarede ikke i tide — prøv igen.', 504, 'CVR_TIMEOUT');
    }
    throw new CvrError(`Kunne ikke nå CVR-registret: ${err.message}`, 502, 'CVR_UNREACHABLE');
  }

  if (res.status === 401 || res.status === 403) {
    throw new CvrError('Virk afviste vores login — tjek VIRK_USERNAME/VIRK_PASSWORD.', 502, 'CVR_AUTH_FAILED');
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new CvrError(`Virk svarede HTTP ${res.status}: ${text.slice(0, 300)}`, 502, 'CVR_BAD_RESPONSE');
  }
  return res.json();
}

/**
 * Enforce the parts of a filter Elasticsearch can't express.
 *
 * "Only companies with a phone number" has to mean a number you can actually
 * dial today. CVR keeps every number a company has ever registered, each with
 * a validity period, and normalizeVirk already discards expired and unlisted
 * ones — so a record can satisfy the ES `exists` filter and still normalise to
 * no phone at all. About 10% of a typical result set. Dropping them here is
 * what makes the promise on the search form true.
 */
function applyPostFilters(companies, filters) {
  let ud = companies;
  if (filters?.requirePhone) ud = ud.filter((c) => Boolean(c.phone));
  if (filters?.requireEmail) ud = ud.filter((c) => Boolean(c.email));
  if (filters?.website === 'med') ud = ud.filter((c) => Boolean(c.website));
  return ud;
}

/** Total-hits shape differs between Elasticsearch major versions. */
function readTotal(json) {
  const t = json?.hits?.total;
  if (t == null) return 0;
  return typeof t === 'object' ? (t.value ?? 0) : t;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Paged search — used for the preview grid before the user saves a list.
 * @returns {{ total:number, results:object[], provider:string }}
 */
/**
 * Sortering af søgeresultater.
 *
 * Sker i registret og ikke på de 25 rækker brugeren ser: sorterer man kun
 * siden, får man "den største af 25 vilkårlige", og det er vildledende når der
 * står 4.000 træffere ovenover.
 *
 * KUN TAL OG DATOER KAN SORTERES. Navn, branchetekst og telefonnummer er
 * indekseret som fritekst uden `.keyword`-underfelt, og Elasticsearch kan ikke
 * sortere på dem.
 *
 * Det er værd at vide hvordan det ser ud når man prøver: forespørgslen fejler
 * IKKE. Sætter man `unmapped_type`, accepterer Elasticsearch et felt der ikke
 * findes, behandler hver værdi som manglende og returnerer rækkerne i
 * indeksrækkefølge. Stigende og faldende giver da nøjagtig det samme, og det
 * ligner sortering lige indtil man kigger efter. Derfor står kun de felter her
 * som er efterprøvet ved at læse værdierne ud og se om de faktisk stiger.
 */
const SORTERBARE = {
  // Byen sorteres på POSTNUMMER, ikke på bynavnet: det er sådan man tænker
  // geografi når man planlægger en ringerunde. Bynavnet er fritekst og kunne
  // alligevel ikke.
  by:      { felt: `${META}.nyesteBeliggenhedsadresse.postnummer`, type: 'long' },
  form:    { felt: `${META}.nyesteVirksomhedsform.virksomhedsformkode`, type: 'long' },
  ansatte: { felt: SORT_EMPLOYMENT_FIELD, type: 'integer' },
  stiftet: { felt: `${META}.stiftelsesDato`, type: 'date' },
};

/** Navngivne standardsorteringer, brugt når ingen kolonne er valgt. */
const STANDARD = {
  // Størst først — det man vil have når man leder i en branche.
  size:   { kolonne: 'ansatte', retning: 'desc' },
  // Nyeste først — hele pointen med "nyregistrerede".
  newest: { kolonne: 'stiftet', retning: 'desc' },
};

function byggSortering(sort = 'size', order) {
  const valg = SORTERBARE[sort]
    ? { kolonne: sort, retning: order === 'asc' ? 'asc' : 'desc' }
    : (STANDARD[sort] ?? STANDARD.size);
  const k = SORTERBARE[valg.kolonne];
  return [{
    [k.felt]: {
      order: valg.retning,
      // Tomme værdier ligger altid nederst, uanset retning. Ellers ville
      // "sorter efter telefon" begynde med en skærmfuld streger.
      missing: '_last',
      unmapped_type: k.type,
    },
  }];
}

async function searchCompanies({ filters = {}, page = 1, size = 25, sort = 'size', order } = {}) {
  const safeSize = Math.min(Math.max(Number(size) || 25, 1), 100);
  const safePage = Math.max(Number(page) || 1, 1);
  const from = (safePage - 1) * safeSize;

  // Elasticsearch refuses from + size beyond the index.max_result_window
  // (10 000 by default). Deep paging is the wrong tool anyway — narrow the
  // filters or run a full extraction instead.
  if (from + safeSize > 10000) {
    throw new CvrError(
      'Du kan højst bladre 10.000 resultater igennem. Indsnævr søgningen, eller lav et fuldt udtræk.',
      400, 'CVR_PAGE_TOO_DEEP'
    );
  }

  // unmapped_type keeps a sort from erroring on the sibling indices behind the
  // cvr-permanent alias (production units, participants), which lack the field.
  const json = await virkFetch(VIRK_INDEX, {
    from,
    size: safeSize,
    query: buildQuery(filters),
    sort: byggSortering(sort, order),
  });

  const results = applyPostFilters(
    (json?.hits?.hits ?? []).map((h) => normalizeVirk(h._source)),
    filters
  );

  return {
    // `total` is what CVR matched; a phone-only search drops a few more when
    // normalised, so treat it as an upper bound rather than an exact count.
    total: readTotal(json),
    results,
    provider: 'virk',
  };
}

/**
 * Full extraction via the scroll API — this is what fills a lead list.
 * Capped by `limit` so an over-broad filter can't pull half the register.
 *
 * @param {function(object[]):Promise<void>} [onBatch] called per scroll page,
 *        letting the caller stream rows into the database instead of buffering.
 * @returns {{ total:number, fetched:number, results:object[] }}
 *          `results` is empty when onBatch is supplied.
 */
async function extractCompanies({ filters = {}, limit = 5000, onBatch = null } = {}) {
  const cap = Math.min(Math.max(Number(limit) || 1000, 1), 50000);
  const pageSize = Math.min(cap, 500);

  let json = await virkFetch(`${VIRK_INDEX}?scroll=2m`, {
    size: pageSize,
    query: buildQuery(filters),
  });

  const total = readTotal(json);
  const collected = [];
  let fetched = 0;
  let scrollId = json._scroll_id;

  try {
    while (json?.hits?.hits?.length && fetched < cap) {
      const batch = applyPostFilters(
        json.hits.hits
          .slice(0, cap - fetched)
          .map((h) => normalizeVirk(h._source))
          .filter((c) => c.cvr), // a record without a CVR number is unusable
        filters
      );

      fetched += batch.length;
      if (onBatch) await onBatch(batch);
      else collected.push(...batch);

      if (fetched >= cap || !scrollId) break;

      json = await virkFetch('_search/scroll', { scroll: '2m', scroll_id: scrollId });
      scrollId = json._scroll_id ?? scrollId;
    }
  } finally {
    // Scroll contexts are a finite server resource — always hand it back.
    if (scrollId) await clearScroll(scrollId);
  }

  return { total, fetched, results: collected };
}

async function clearScroll(scrollId) {
  try {
    const auth = Buffer.from(`${VIRK_USER}:${VIRK_PASS}`).toString('base64');
    await fetch(`${VIRK_BASE}/_search/scroll`, {
      method: 'DELETE',
      headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ scroll_id: [scrollId] }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Best effort — the context expires on its own after the scroll TTL.
  }
}

/**
 * Single-company lookup by CVR number.
 * Uses Virk when configured, otherwise falls back to cvrapi.dk.
 */
async function lookupCompany(cvrNumber) {
  const clean = String(cvrNumber ?? '').replace(/[\s\-.]/g, '');
  if (!/^\d{8}$/.test(clean)) {
    throw new CvrError('Et dansk CVR-nummer er 8 cifre.', 400, 'CVR_INVALID_NUMBER');
  }

  if (hasVirkCredentials()) {
    const json = await virkFetch(VIRK_INDEX, {
      size: 1,
      query: { term: { [`${FIELD}.cvrNummer`]: Number(clean) } },
    });
    const hit = json?.hits?.hits?.[0];
    return hit ? normalizeVirk(hit._source) : null;
  }

  // Fallback: cvrapi.dk. Single lookups only — it has no filtering API.
  let res;
  try {
    res = await fetch(`https://cvrapi.dk/api?search=${encodeURIComponent(clean)}&country=dk`, {
      headers: { 'User-Agent': CVRAPI_UA },
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new CvrError('CVR-registret svarede ikke i tide — prøv igen.', 504, 'CVR_TIMEOUT');
    }
    throw new CvrError(`Kunne ikke nå CVR-registret: ${err.message}`, 502, 'CVR_UNREACHABLE');
  }
  // An unknown CVR number comes back as a 404, not as a 200 with an error body.
  if (res.status === 404) return null;
  if (!res.ok) throw new CvrError(`cvrapi.dk svarede HTTP ${res.status}`, 502, 'CVR_BAD_RESPONSE');

  const data = await res.json();
  if (data.error) return null;
  return normalizeCvrApi(data);
}

/**
 * Slår FLERE CVR-numre op i ét kald.
 *
 * Et enkeltopslag pr. nummer ville betyde 25 forespørgsler mod Virk for én
 * markering på en søgeside — langsomt for brugeren og unødigt hårdt ved et
 * register vi deler med alle andre.
 *
 * Numre der ikke findes, udelades stille. Kaldstedet ved hvad det bad om og
 * kan sammenligne selv.
 */
async function lookupCompanies(cvrNumbers) {
  const numre = [...new Set(
    (cvrNumbers || []).map((n) => String(n).replace(/[\s\-.]/g, '')).filter((n) => /^\d{8}$/.test(n))
  )].slice(0, 200);
  if (!numre.length) return [];

  if (!hasVirkCredentials()) {
    throw new CvrError(
      'Virk Distribution-adgang mangler. Sæt VIRK_USERNAME og VIRK_PASSWORD i .env.',
      503, 'CVR_NOT_CONFIGURED'
    );
  }

  const json = await virkFetch(VIRK_INDEX, {
    size: numre.length,
    query: { terms: { [`${FIELD}.cvrNummer`]: numre.map(Number) } },
  });
  return (json?.hits?.hits ?? []).map((h) => normalizeVirk(h._source));
}

module.exports = {
  CvrError,
  hasVirkCredentials,
  buildQuery,
  normalizeVirk,
  searchCompanies,
  SORTERBARE,
  extractCompanies,
  lookupCompany,
  lookupCompanies,
  EXCLUDE_PROTECTED,
};
