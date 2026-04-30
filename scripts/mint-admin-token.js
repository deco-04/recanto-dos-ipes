'use strict';

/**
 * Mints a short-lived (15-minute) JWT for the first active ADMIN staff
 * member. Used by operational tooling that needs to authenticate against
 * the staff API from outside the staff app — e.g., curling the
 * /api/admin/airbnb-import endpoint to backfill financials from a CSV.
 *
 * Why a script and not an inline `node -e`:
 *   `railway ssh COMMAND` runs the remote command through `sh -c`, which
 *   parses parens and other JS syntax in the argv before node ever sees
 *   it ("Syntax error: '(' unexpected"). A standalone .js file sidesteps
 *   the shell entirely.
 *
 * Output: a single line — the JWT token. Suitable for capture into a
 * shell variable: `TOKEN=$(railway ssh ... node scripts/mint-admin-token.js)`
 * No other text is printed to stdout, so the captured value is safe to
 * use as a Bearer header value.
 *
 * Errors go to stderr (with non-zero exit) so command substitution can't
 * silently capture them.
 */

const jwt    = require('jsonwebtoken');
const prisma = require('../lib/db');

async function main() {
  if (!process.env.STAFF_JWT_SECRET) {
    console.error('STAFF_JWT_SECRET not set in environment');
    process.exit(1);
  }
  const admin = await prisma.staffMember.findFirst({
    where:  { role: 'ADMIN', active: true },
    select: { id: true, name: true, email: true },
  });
  if (!admin) {
    console.error('No active ADMIN staff member found in DB');
    process.exit(1);
  }
  // 15 minutes is enough for a single curl + plenty of margin; short
  // enough that an accidentally-leaked token doesn't have a long shelf
  // life.
  const token = jwt.sign({ sub: admin.id }, process.env.STAFF_JWT_SECRET, { expiresIn: '15m' });
  // Single line, no prefix — captures cleanly as "$(...)" in bash.
  process.stdout.write(token + '\n');
}

main()
  .catch(err => {
    console.error('mint-admin-token failed:', err.message);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
