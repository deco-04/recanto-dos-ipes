'use strict';

/**
 * Admin route: ingest the Airbnb host "completed bookings" CSV as ground
 * truth for OTA financials. The CLI script (scripts/import-airbnb-
 * financial-csv.js) does the same work, but doesn't run from a local
 * machine because Postgres is on Railway's internal network. This route
 * exposes the same function over HTTPS so the operator can curl the
 * CSV up directly.
 *
 *   POST /api/admin/airbnb-import?commit=true
 *     Body: text/csv
 *     Auth: requireAdmin (Bearer token)
 *     Response: { matched, unmatched, updated, nameFixed, unmatchedSample }
 *
 * Why a route instead of fixing the CLI:
 *   - Railway's `ssh COMMAND` always allocates a TTY → stdin pipes
 *     don't reach the remote process.
 *   - Railway's `run` injects env vars locally → can't reach the
 *     internal postgres.railway.internal hostname.
 *   - Adding public networking to Postgres for one-off scripts is
 *     overkill and a permanent attack surface.
 *   - A curl-able admin endpoint is reusable monthly and could grow
 *     into a UI button later.
 *
 * Operator usage:
 *   curl -X POST https://www.sitiorecantodosipes.com/api/admin/airbnb-import \
 *        -H "Authorization: Bearer <admin-jwt>" \
 *        -H "Content-Type: text/csv" \
 *        --data-binary @uploads/.../airbnb-completed-all.csv
 *
 * Append ?commit=true to actually write. Defaults to dry run.
 */

const express = require('express');
const { requireAdmin } = require('../lib/staff-auth-middleware');
const { runImport }    = require('../scripts/import-airbnb-financial-csv');

const router = express.Router();

// Larger body limit — Airbnb CSVs grow over time. 5MB covers years of
// bookings comfortably (~20KB per year of activity at this property's volume).
router.use(express.text({ type: 'text/csv', limit: '5mb' }));
router.use(express.text({ type: 'text/plain', limit: '5mb' }));

router.post('/', requireAdmin, async (req, res) => {
  const csvText = String(req.body || '');
  if (!csvText.trim()) {
    return res.status(400).json({
      error: 'CSV body is empty. Send the CSV contents as text/csv in the request body.',
      code:  'CSV_EMPTY',
    });
  }
  // Sanity: the Airbnb header should always start with "Date,Arriving by date".
  // If it doesn't, the operator probably sent the wrong file (e.g. the bank
  // statement CSV) and we'd silently match zero bookings.
  if (!csvText.startsWith('Date,Arriving by date,Type,Confirmation code')) {
    return res.status(400).json({
      error: 'CSV header doesn\'t match the expected Airbnb host export format.',
      code:  'CSV_FORMAT_UNRECOGNIZED',
      hint:  'Download from Airbnb host dashboard → Earnings → Export CSV → "All transactions completed".',
    });
  }

  const commit = req.query.commit === 'true' || req.query.commit === '1';

  try {
    const summary = await runImport(csvText, { commit });
    res.json({
      ok: true,
      ...summary,
      mode: commit ? 'COMMIT' : 'DRY_RUN',
    });
  } catch (err) {
    console.error('[admin-airbnb-import] failed:', err);
    res.status(500).json({
      error: 'Import failed — check Railway logs for details.',
      message: err.message,
    });
  }
});

module.exports = router;
