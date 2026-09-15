-- 010 — forudbetalte pladser og ringelister pr. medarbejder.
--
-- paid_seats: ekstra pladser ud over ejerens, som der er betalt for i Stripe.
-- Stripe er kilden; webhooken skriver tallet her, så hvert kald kan spørge
-- uden et netværkskald.
--
-- requested_seats: det antal kunden valgte ved oprettelsen, før der findes et
-- abonnement. Det følger med ind i checkout og er loftet indtil da.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS paid_seats      INTEGER NOT NULL DEFAULT 0 CHECK (paid_seats >= 0),
  ADD COLUMN IF NOT EXISTS requested_seats INTEGER NOT NULL DEFAULT 0 CHECK (requested_seats >= 0);

-- Eksisterende kunder har hidtil betalt pr. aktiv bruger ud over ejeren. De
-- får præcis de pladser, de allerede betaler for, så ingen faktura ændrer sig.
UPDATE organizations o
   SET paid_seats = GREATEST(0,
         (SELECT COUNT(*)::int FROM users u WHERE u.org_id = o.id AND u.is_active) - 1)
 WHERE o.stripe_subscription_id IS NOT NULL;

-- En liste kan sendes til én medarbejder. Listens leads følger med, og nye
-- leads i listen får samme medarbejder.
ALTER TABLE lead_lists
  ADD COLUMN IF NOT EXISTS assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS lead_lists_assigned_idx
  ON lead_lists (org_id, assigned_to)
  WHERE archived_at IS NULL;
