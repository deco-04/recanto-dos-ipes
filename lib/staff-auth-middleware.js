'use strict';

/**
 * Shared auth middleware for all staff-facing routes.
 *
 * requireStaff  — any active staff member (role from DB, not JWT claim)
 * requireAdmin  — must be ADMIN per DB (prevents demoted admins retaining access)
 * requireRole   — factory: passes if req.staff.role is in the allowed list
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

module.exports = { requireStaff, requireAdmin, requireRole };
