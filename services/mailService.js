// services/mailService.js — udgående post: teaminvitationer og tildelte ringelister.
//
// Der er ingen mailudbyder i afhængighederne: Resends HTTP-API er ét kald, og
// et bibliotek til det ville være en afhængighed mere at holde opdateret.
//
// Vigtigst: **mailen er ikke det der bærer invitationen**. Invitationen ligger
// i databasen, og den inviterede kan se den på sit eget overblik og acceptere
// derfra. Mailen er en genvej, og linket kan ejeren kopiere selv. Derfor må et
// manglende RESEND_API_KEY aldrig få en invitation til at fejle — det ville
// gøre en glemt miljøvariabel til en funktion der ikke virker.
'use strict';

const NØGLE = process.env.RESEND_API_KEY || '';
const FRA   = process.env.MAIL_FROM || 'Lysmera <ingen-svar@lysmera.dk>';

function erKonfigureret() {
  return Boolean(NØGLE);
}

/** Undgå at fremmed tekst — et firmanavn med & eller < — brækker HTML'en. */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

async function send({ til, emne, html, tekst }) {
  if (!erKonfigureret()) return false;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${NØGLE}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: FRA, to: [til], subject: emne, html, text: tekst }),
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

module.exports = { erKonfigureret, sendInvitation, sendListeTildelt };
