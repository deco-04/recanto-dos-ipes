'use strict';

/**
 * Shared auth middleware for all staff-facing routes.
 *
 * requireStaff           — any active staff member (role from DB, not JWT claim)
 * requireAdmin           — must be ADMIN per DB (prevents demoted admins retaining access)
 * requireRole            — factory: passes if req.staff.role is in the allowed list
 * hasPropertyAccess      — async predicate: does this staff have access to this propertyId?
 * requirePropertyAccess  — factory: rejects 403 PROPERTY_NOT_ASSIGNED when staff has no
 *                          StaffPropertyAssignment row for the requested propertyId.
 *                          ADMIN role bypasses (admins see all properties by design).
 */

const jwt    = require('jsonwebtoken');
const prisma = require('./db');

async function requireStaff(req, res, next) {
  const auth = req.headers['authorization'] || '';
  if (!auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Não autenticado' });

  let payload;
  try {
    payload = jwt.verify(auth.slice(7), process.env.STAFF_JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Token inválido ou expirado' });
  }

  const staff = await prisma.staffMember.findUnique({
    where:  { id: payload.sub },
    select: { id: true, name: true, email: true, role: true, active: true },
  });

  if (!staff || !staff.active) return res.status(401).json({ error: 'Acesso negado' });

  req.staff = staff;
  next();
}

async function requireAdmin(req, res, next) {
  const auth = req.headers['authorization'] || '';
  if (!auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Não autenticado' });

  let payload;
  try {
    payload = jwt.verify(auth.slice(7), process.env.STAFF_JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Token inválido ou expirado' });
  }

  const staff = await prisma.staffMember.findUnique({
    where:  { id: payload.sub },
    select: { id: true, name: true, email: true, role: true, active: true },
  });

  if (!staff || !staff.active) return res.status(401).json({ error: 'Acesso negado' });
  // Use DB role — prevents a demoted ADMIN from retaining access via a long-lived JWT
  if (staff.role !== 'ADMIN') return res.status(403).json({ error: 'Permissão insuficiente' });

  req.staff = staff;
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.staff?.role)) {
      return res.status(403).json({ error: 'Permissão insuficiente' });
    }
    next();
  };
}

/**
 * Confirms a staff member has access to a given property.
 *
 * ADMIN bypasses by design — admins see across every property in the system.
 * Non-admin staff (GOVERNANTA, PISCINEIRO, etc.) are validated against
 * StaffPropertyAssignment rows.
 *
 * Use as a predicate when you have programmatic propertyId already in hand
 * (e.g., from a related entity look-up). For request-time checks based on
 * URL/query/body, prefer the requirePropertyAccess() middleware factory.
 *
 * @param {{ id: string, role: string } | null | undefined} staff
 * @param {string | null | undefined} propertyId
 * @returns {Promise<boolean>}
 */
async function hasPropertyAccess(staff, propertyId) {
  if (!staff || !staff.id) return false;
  if (staff.role === 'ADMIN') return true;
  if (!propertyId) return false;

  const assignment = await prisma.staffPropertyAssignment.findUnique({
    where:  { staffId_propertyId: { staffId: staff.id, propertyId } },
    select: { id: true },
  });
  return Boolean(assignment);
}

/**
 * Express middleware factory enforcing property scoping. Use AFTER
 * requireStaff. Accepts an optional getPropertyId(req) function — defaults
 * to checking req.params.propertyId, req.query.propertyId, req.body.propertyId
 * in that order.
 *
 * Behavior:
 *   - ADMIN role → bypass (no DB call).
 *   - propertyId missing on the request → 400 PROPERTY_ID_REQUIRED. Forces
 *     non-admin callers to be explicit about which property they want, so
 *     scoping can't be silently bypassed.
 *   - StaffPropertyAssignment row missing → 403 PROPERTY_NOT_ASSIGNED.
 *
 * Example usages:
 *   router.get('/api/staff/bookings',
 *     requireStaff,
 *     requirePropertyAccess(req => req.query.propertyId),
 *     handler);
 *
 *   router.get('/api/staff/properties/:propertyId/bookings',
 *     requireStaff,
 *     requirePropertyAccess(),  // defaults to req.params.propertyId
 *     handler);
 *
 * @param {(req: import('express').Request) => string | undefined} [getPropertyId]
 */
function requirePropertyAccess(getPropertyId) {
  return async (req, res, next) => {
    if (req.staff?.role === 'ADMIN') return next();

    const propertyId = (typeof getPropertyId === 'function')
      ? getPropertyId(req)
      : (req.params?.propertyId || req.query?.propertyId || req.body?.propertyId);

    if (!propertyId) {
      return res.status(400).json({
        error: 'propertyId é obrigatório',
        code:  'PROPERTY_ID_REQUIRED',
      });
    }

    const allowed = await hasPropertyAccess(req.staff, propertyId);
    if (!allowed) {
      return res.status(403).json({
        error: 'Sem acesso à propriedade solicitada',
        code:  'PROPERTY_NOT_ASSIGNED',
      });
    }
    next();
  };
}

/**
 * Returns the set of property IDs this staff can access.
 *   ADMIN → null sentinel meaning "all properties" (caller should treat as
 *   unrestricted, e.g. apply `where.propertyId = { not: null }` to skip
 *   orphans but include every property).
 *   Non-admin → string[] of assigned property IDs (possibly empty when the
 *   staff has no StaffPropertyAssignment rows yet).
 *
 * @param {{ id: string, role: string } | null | undefined} staff
 * @returns {Promise<string[] | null>}
 */
async function getAccessiblePropertyIds(staff) {
  if (!staff?.id) return [];
  if (staff.role === 'ADMIN') return null;

  const rows = await prisma.staffPropertyAssignment.findMany({
    where:  { staffId: staff.id },
    select: { propertyId: true },
  });
  return rows.map(r => r.propertyId);
}

/**
 * Builds a Prisma `propertyId` filter fragment for list endpoints that scope
 * by the requesting staff's accessible properties. Use this in routes that
 * accept an optional `?propertyId=` query string AND must protect non-admin
 * staff from cross-property data leaks.
 *
 * Returns either:
 *   { propertyId: <Prisma filter> }  — merge into your where clause
 *   null                              — response was already sent by this
 *                                        helper (403 unauthorized property,
 *                                        or 200 [] for staff with no
 *                                        assignments). Caller MUST stop
 *                                        processing when result is null.
 *
 * Behavior matrix:
 *   ADMIN + specific propertyId    → { propertyId: <id> }
 *   ADMIN + no/ALL                 → { propertyId: { not: null } }   // sees all
 *   non-admin + their property     → { propertyId: <id> }
 *   non-admin + other property     → 403 PROPERTY_NOT_ASSIGNED, returns null
 *   non-admin + no/ALL             → { propertyId: { in: [their ids] } }
 *   non-admin + zero assignments   → 200 with `emptyResultBody`, returns null
 *
 * @param {object} args
 * @param {import('express').Request}  args.req
 * @param {import('express').Response} args.res
 * @param {string | undefined}         args.requestedPropertyId
 * @param {*}                          [args.emptyResultBody] body to return
 *   when a non-admin staff has zero assignments. Defaults to [] (works for
 *   list endpoints; pass {} for object endpoints).
 * @returns {Promise<{ propertyId: any } | null>}
 */
async function applyPropertyScope({ req, res, requestedPropertyId, emptyResultBody = [] }) {
  const staff = req.staff;
  if (staff?.role === 'ADMIN') {
    if (requestedPropertyId && requestedPropertyId !== 'ALL') {
      return { propertyId: requestedPropertyId };
    }
    return { propertyId: { not: null } };
  }

  const accessibleIds = await getAccessiblePropertyIds(staff);

  if (requestedPropertyId && requestedPropertyId !== 'ALL') {
    if (!accessibleIds.includes(requestedPropertyId)) {
      res.status(403).json({
        error: 'Sem acesso à propriedade solicitada',
        code:  'PROPERTY_NOT_ASSIGNED',
      });
      return null;
    }
    return { propertyId: requestedPropertyId };
  }

  if (accessibleIds.length === 0) {
    // Staff with no assignments can't access any property's data. Return
    // the empty body so the UI shows an empty state rather than 500.
    res.status(200).json(emptyResultBody);
    return null;
  }
  return { propertyId: { in: accessibleIds } };
}

module.exports = {
  requireStaff,
  requireAdmin,
  requireRole,
  hasPropertyAccess,
  requirePropertyAccess,
  getAccessiblePropertyIds,
  applyPropertyScope,
};
