// services/mailService.js — udgående post: teaminvitationer og tildelte ringelister.
//
// To veje ud, valgt efter hvad der er sat op:
//   - Google Workspace over SMTP (SMTP_USER + SMTP_PASS): postkassen
//     lkk@eurohive.eu med et app-kodeord. Afsenderen skal være en adresse
//     kontoen må sende som — lucca@lysmera.dk er en alternativ adresse på den.
//     Gmail skriver ellers stille From om til kontoens egen adresse.
//     Sendte mails ligger bagefter i postkassens "Sendt".
//   - Resend (RESEND_API_KEY): ét HTTP-kald, intet bibliotek.
// SMTP vinder, hvis begge er sat.
//
// Vigtigst: **mailen er ikke det der bærer invitationen**. Invitationen ligger
// i databasen, og den inviterede kan se den på sit eget overblik og acceptere
// derfra. Mailen er en genvej, og linket kan ejeren kopiere selv. Derfor må et
// manglende RESEND_API_KEY aldrig få en invitation til at fejle — det ville
// gøre en glemt miljøvariabel til en funktion der ikke virker.
'use strict';

const NØGLE     = process.env.RESEND_API_KEY || '';
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = (process.env.SMTP_PASS || '').replace(/\s+/g, ''); // Google viser koden i blokke
const BRUG_SMTP = Boolean(SMTP_USER && SMTP_PASS);

// Over Gmail findes ingen-svar@ ikke som adresse, så standarden er en, der gør.
const FRA = process.env.MAIL_FROM
  || (BRUG_SMTP ? 'Lysmera <lucca@lysmera.dk>' : 'Lysmera <ingen-svar@lysmera.dk>');

// Svar på kontaktbeskeder kommer fra en rigtig postkasse, så kundens svar
// lander et sted, hvor nogen læser det — ikke på ingen-svar@.
const SVAR_FRA    = process.env.MAIL_SVAR_FROM || 'Lucca fra Lysmera <lucca@lysmera.dk>';
const SVAR_TIL    = process.env.MAIL_SVAR_REPLY_TO || 'lucca@lysmera.dk';
const KONTAKT_TIL = process.env.KONTAKT_MODTAGER || 'lucca@look-a.dk';

function erKonfigureret() {
  return BRUG_SMTP || Boolean(NØGLE);
}

let transport = null;
function smtp() {
  if (!transport) {
    transport = require('nodemailer').createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: Number(process.env.SMTP_PORT || 465),
      secure: Number(process.env.SMTP_PORT || 465) === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
      // Samme grund som timeouten på Resend-kaldet nedenfor.
      connectionTimeout: 8000,
      greetingTimeout: 8000,
      socketTimeout: 15000,
    });
  }
  return transport;
}

/** Undgå at fremmed tekst — et firmanavn med & eller < — brækker HTML'en. */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

async function send({ til, emne, html, tekst, fra = FRA, svarTil }) {
  if (!erKonfigureret()) return false;
  if (BRUG_SMTP) {
    try {
      await smtp().sendMail({
        from: fra, to: til, subject: emne, html, text: tekst,
        ...(svarTil ? { replyTo: svarTil } : {}),
      });
      return true;
    } catch (err) {
      console.error('[mail] SMTP afviste:', err.responseCode ?? '', err.message);
      return false;
    }
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${NØGLE}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fra, to: [til], subject: emne, html, text: tekst,
        ...(svarTil ? { reply_to: svarTil } : {}),
      }),
      // Uden en grænse kan en langsom mailudbyder holde HTTP-svaret til ejeren
      // tilbage. Invitationen er allerede oprettet på det tidspunkt.
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.error('[mail] afvist af Resend:', res.status, (await res.text()).slice(0, 300));
      return false;
    }
    return true;
  } catch (err) {
    console.error('[mail]', err.message);
    return false;
  }
}

/**
 * Invitation til et team. `link` går til /invitation/:token i frontenden, hvor
 * modtageren enten logger ind eller vælger en adgangskode.
 */
async function sendInvitation({ til, navn, orgNavn, inviteretAf, link }) {
  const hilsen = navn ? `Hej ${navn}` : 'Hej';
  const afsender = inviteretAf ? `${inviteretAf} hos ${orgNavn}` : orgNavn;

  return send({
    til,
    emne: `${orgNavn} har inviteret dig til deres team i Lysmera`,
    tekst:
      `${hilsen}\n\n${afsender} har inviteret dig til at være med i teamet i Lysmera.\n\n` +
      `Sig ja her: ${link}\n\nInvitationen udløber om 14 dage.\n`,
    html:
      `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.6;color:#111">
         <p>${esc(hilsen)}</p>
         <p><strong>${esc(afsender)}</strong> har inviteret dig til at være med i teamet i Lysmera.</p>
         <p><a href="${esc(link)}" style="display:inline-block;background:#111;color:#fff;
               padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">
            Se invitationen</a></p>
         <p style="color:#555;font-size:13px">Virker knappen ikke, så kopier linket:<br>
            <span style="word-break:break-all">${esc(link)}</span></p>
         <p style="color:#555;font-size:13px">Invitationen udløber om 14 dage.
            Kender du ikke afsenderen, kan du roligt lade den ligge.</p>
       </div>`,
  });
}

/**
 * En ringeliste er sendt til en medarbejder. Som invitationen er mailen en
 * genvej: listen står på medarbejderens egen listeside, uanset om mailen når frem.
 */
async function sendListeTildelt({ til, navn, listeNavn, antal, tildeltAf, link }) {
  const hilsen = navn ? `Hej ${navn}` : 'Hej';
  const fra = tildeltAf || 'En kollega';
  const leads = `${antal} ${antal === 1 ? 'virksomhed' : 'virksomheder'}`;

  return send({
    til,
    emne: `Ny ringeliste til dig: ${listeNavn}`,
    tekst:
      `${hilsen}\n\n${fra} har sendt ringelisten "${listeNavn}" til dig med ${leads} at ringe til.\n\n` +
      `Åbn listen: ${link}\n`,
    html:
      `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.6;color:#111">
         <p>${esc(hilsen)}</p>
         <p><strong>${esc(fra)}</strong> har sendt ringelisten <strong>${esc(listeNavn)}</strong>
            til dig med ${esc(leads)} at ringe til.</p>
         <p><a href="${esc(link)}" style="display:inline-block;background:#111;color:#fff;
               padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">
            Åbn listen</a></p>
         <p style="color:#555;font-size:13px">Listen ligger også under Lister, når du logger ind.</p>
       </div>`,
  });
}

/**
 * Ny besked fra kontaktformularen. Beskeden står i admin; mailen er en
 * genvej, og trykker man svar i mailprogrammet, går det til den, der skrev.
 */
async function sendKontaktNotifikation({ navn, epost, besked, link }) {
  return send({
    til: KONTAKT_TIL,
    svarTil: epost,
    emne: `Ny besked på lysmera.dk — ${navn}`,
    tekst:
      `${navn} <${epost}> skrev:\n\n${besked || '(ingen tekst)'}\n\n` +
      `Svar fra admin: ${link}\n`,
    html:
      `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.6;color:#111">
         <p><strong>${esc(navn)}</strong> &lt;${esc(epost)}&gt; skrev:</p>
         <p style="white-space:pre-wrap;border-left:3px solid #7c3aed;padding-left:12px">${esc(besked || '(ingen tekst)')}</p>
         <p><a href="${esc(link)}" style="display:inline-block;background:#111;color:#fff;
               padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">
            Svar fra admin</a></p>
       </div>`,
  });
}

/** Svar på en kontaktbesked, sendt som Lysmera med den oprindelige besked citeret. */
async function sendKontaktSvar({ til, navn, emne, tekst, oprindelig, dato }) {
  const citat = oprindelig
    ? `\n\n${navn} skrev ${dato}:\n` + oprindelig.split('\n').map((l) => `> ${l}`).join('\n')
    : '';
  return send({
    til,
    fra: SVAR_FRA,
    svarTil: SVAR_TIL,
    emne,
    tekst: `${tekst}${citat}\n`,
    html:
      `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.6;color:#111">
         <p style="white-space:pre-wrap">${esc(tekst)}</p>
         ${oprindelig ? `<p style="color:#555;font-size:13px;margin-top:24px">${esc(navn)} skrev ${esc(dato)}:</p>
         <blockquote style="white-space:pre-wrap;color:#555;font-size:13px;border-left:3px solid #ddd;margin:0;padding-left:12px">${esc(oprindelig)}</blockquote>` : ''}
       </div>`,
  });
}

module.exports = {
  erKonfigureret, sendInvitation, sendListeTildelt, sendKontaktNotifikation, sendKontaktSvar,
};
