// routes/stripeWebhook.js — Stripe fortæller os hvad der er sket.
//
// Uden den her ville integrationen kun kende til den allerførste betaling.
// Fornyelser, mislykkede træk og opsigelser sker asynkront og længe efter at
// brugeren har forladt betalingssiden — de findes kun her.
//
// Ruten monteres FØR express.json(), fordi signaturen regnes på den rå body.
// Er den blevet parset og serialiseret igen, passer signaturen ikke.
'use strict';

const express = require('express');
const db      = require('../db');
const stripeService = require('../services/stripeService');

const router = express.Router();

/** Sekunder siden epoch → dato, eller null. */
function tid(sek) {
  return sek ? new Date(sek * 1000) : null;
}

/**
 * Hvornår den nuværende periode slutter.
 *
 * Fra API-version 2026-07-29 findes `current_period_end` IKKE længere på
 * abonnementet selv — den ligger på hver linje, fordi linjer kan have
 * forskellige perioder. De to øvrige kilder er reserver: ældre API-versioner
 * har feltet på øverste niveau, og under en prøveperiode er trial_end det
 * samme tidspunkt.
 */
function periodeSlut(sub) {
  return sub.items?.data?.[0]?.current_period_end
      ?? sub.current_period_end
      ?? sub.trial_end
      ?? null;
}

/**
 * Skriv abonnementets tilstand over på organisationen.
 *
 * Organisationen findes via metadata på abonnementet, med kunde-id'et som
 * reserve — metadata kan mangle på abonnementer oprettet i dashboardet.
 */
async function gemAbonnement(sub) {
  const orgId = Number(sub.metadata?.org_id) || null;
  const kundeId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;

  // Ekstra pladser læses af selve abonnementet. Stripe er kilden: ændres
  // antallet i dashboardet, følger databasen med herfra.
  const pladser = stripeService.pladserFraAbonnement(sub);

  const felter = [
    sub.status,
    tid(periodeSlut(sub)),
    sub.id,
    kundeId,
    pladser,
  ];

  const { rowCount } = orgId
    ? await db.query(
        `UPDATE organizations
            SET subscription_status = $1, current_period_end = $2,
                stripe_subscription_id = $3, stripe_customer_id = $4,
                paid_seats = COALESCE($5::int, paid_seats)
          WHERE id = $6`,
        [...felter, orgId]
      )
    : await db.query(
        `UPDATE organizations
            SET subscription_status = $1, current_period_end = $2,
                stripe_subscription_id = $3,
                paid_seats = COALESCE($5::int, paid_seats)
          WHERE stripe_customer_id = $4`,
        felter
      );

  if (!rowCount) {
    // Ikke en fejl vi kan rette her, men den skal være synlig: en betaling er
    // gået igennem uden at nogen organisation blev opdateret.
    console.error('[stripe:webhook] ingen organisation matchede abonnement', sub.id);
  }
}

router.post('/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = stripeService.verificerWebhook(req.body, req.headers['stripe-signature']);
  } catch (err) {
    // 400 uden detaljer: den der rammer her uden gyldig signatur skal ikke
    // have at vide hvorfor det mislykkedes.
    console.error('[stripe:webhook] afvist signatur:', err.message);
    return res.status(400).send('Ugyldig signatur');
  }

  try {
    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await gemAbonnement(event.data.object);
        break;

      case 'checkout.session.completed': {
        // Knyt kunden til organisationen med det samme, så portalen virker
        // også før det første abonnements-event når frem.
        const s = event.data.object;
        const orgId = Number(s.client_reference_id || s.metadata?.org_id) || null;
        if (orgId && s.customer) {
          await db.query(
            'UPDATE organizations SET stripe_customer_id = $1 WHERE id = $2',
            [s.customer, orgId]
          );
        }
        break;
      }

      case 'customer.subscription.trial_will_end':
        // Tre dage før prøveperioden udløber. Her skal varslingsmailen sendes,
        // når afsendelsen er sat op.
        console.log('[stripe:webhook] prøveperiode udløber snart:', event.data.object.id);
        break;

      case 'invoice.upcoming':
        // Varsel før en fornyelse. Samme sted som ovenfor.
        console.log('[stripe:webhook] fornyelse på vej:', event.data.object.id);
        break;

      case 'invoice.payment_failed':
        console.warn('[stripe:webhook] betaling mislykkedes:', event.data.object.id);
        break;

      default:
        break; // Resten er vi ligeglade med, men de skal kvitteres.
    }
  } catch (err) {
    // 500 får Stripe til at prøve igen, hvilket er dét vi vil have hvis
    // databasen var nede et øjeblik.
    console.error('[stripe:webhook]', event.type, err.message);
    return res.status(500).send('Kunne ikke behandle begivenheden');
  }

  return res.json({ received: true });
});

module.exports = router;
