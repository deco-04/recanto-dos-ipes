-- ── Cabanas da Serra — property + cabin seed ─────────────────────────────────
-- Uses stable string IDs so routes/mailer can reference them as constants.
-- Idempotent: ON CONFLICT DO NOTHING safe to re-run.

INSERT INTO "Property" ("id", "name", "type", "city", "state", "websiteUrl", "active", "createdAt")
VALUES (
  'cds_property_main',
  'Cabanas da Serra',
  'CABANA_COMPLEX',
  'Jaboticatubas',
  'MG',
  'https://cabanasdaserra.com',
  true,
  NOW()
)
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "Cabin" ("id", "propertyId", "name", "slug", "capacity", "description", "active", "createdAt")
VALUES
  (
    'cds_cabin_a',
    'cds_property_main',
    'Cabana A',
    'cabana-a',
    4,
    'Cabana aconchegante para casais e famílias pequenas. Até 4 pessoas.',
    true,
    NOW()
  ),
  (
    'cds_cabin_b',
    'cds_property_main',
    'Cabana B',
    'cabana-b',
    4,
    'Cabana aconchegante para casais e famílias pequenas. Até 4 pessoas.',
    true,
    NOW()
  )
ON CONFLICT ("id") DO NOTHING;
