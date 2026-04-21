'use strict';

/**
 * Admin endpoints for reviewing "Solicitar acesso" submissions.
 * Mounted at: /api/staff/admin
 * All routes require ADMIN role.
 *
 * Persistence contract: POST /api/staff/auth/request-access writes an
 * AccessRequest row BEFORE firing the notification email so the record
 * survives even when Gmail OAuth is broken. These endpoints power the
 * /admin/equipe/solicitacoes review UI.
 */

const express = require('express');
const crypto = require('crypto');
const { z } = require('zod');
const prisma = require('../lib/db');
const { requireAdmin } = require('../lib/staff-auth-middleware');
const { sendStaffInvite } = require('../lib/mailer');

const router = express.Router();

router.use(requireAdmin);

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

// GET /api/staff/admin/access-requests?status=PENDING|APPROVED|DECLINED|ALL
router.get('/access-requests', async (req, res) => {
  try {
    const rawStatus = typeof req.query.status === 'string' ? req.query.status.toUpperCase() : 'PENDING';
    const validStatuses = ['PENDING', 'APPROVED', 'DECLINED'];
    const where = validStatuses.includes(rawStatus) ? { status: rawStatus } : {};

    const rows = await prisma.accessRequest.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: { handledBy: { select: { id: true, name: true } } },
    });

    res.json(rows);
  } catch (e) {
    console.error('[admin] access-requests list error:', e.message);
    res.status(500).json({ error: 'Erro ao listar solicitações' });
  }
});

// POST /api/staff/admin/access-requests/:id/approve
// Creates StaffMember + property assignments + marks request APPROVED.
router.post('/access-requests/:id/approve', async (req, res) => {
  try {
    const schema = z.object({
      role: z.enum(['ADMIN', 'GOVERNANTA', 'PISCINEIRO']),
      propertyIds: z.array(z.string()).default([]),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Dados inválidos', details: parsed.error.issues });

    const ar = await prisma.accessRequest.findUnique({ where: { id: req.params.id } });
    if (!ar) return res.status(404).json({ error: 'Solicitação não encontrada' });
    if (ar.status !== 'PENDING') return res.status(400).json({ error: 'Solicitação já foi processada' });

    // Avoid duplicate StaffMember for the same email
    const existingStaff = ar.email
      ? await prisma.staffMember.findUnique({ where: { email: ar.email } })
      : null;

    // Generate invite token (hashed in DB, raw sent by email) — same
    // pattern admin-staff.js uses for admin-created staff.
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = sha256(rawToken);
    const tokenExpiry = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000); // 14 days

    const staff = existingStaff ?? await prisma.staffMember.create({
      data: {
        name:  ar.name,
        email: ar.email,
        phone: ar.phone,
        role:  parsed.data.role,
        active: true,
        firstLoginDone: false,
        inviteToken: tokenHash,
        inviteTokenExpiry: tokenExpiry,
      },
    });

    for (const propertyId of parsed.data.propertyIds) {
      await prisma.staffPropertyAssignment.upsert({
        where: { staffId_propertyId: { staffId: staff.id, propertyId } },
        create: { staffId: staff.id, propertyId },
        update: {},
      });
    }

    const updated = await prisma.accessRequest.update({
      where: { id: ar.id },
      data:  {
        status: 'APPROVED',
        handledAt: new Date(),
        handledById: req.staff?.id ?? null,
      },
    });

    // Send the invite email (same helper admin-staff.js uses). Only send
    // when we created a brand-new StaffMember — if the email already
    // belonged to an existing staff, admin can resend manually.
    if (!existingStaff && ar.email) {
      const inviteUrl = `${process.env.STAFF_APP_URL}/aceitar-convite?token=${rawToken}`;
      try {
        await sendStaffInvite({ to: ar.email, name: ar.name, inviteUrl });
      } catch (err) {
        console.error('[admin] access-request approve — invite email failed:', err.message);
        // Don't fail the request; admin can resend via /admin/equipe
      }
    }

    res.json({ staffId: staff.id, accessRequestId: updated.id });
  } catch (e) {
    console.error('[admin] access-request approve error:', e.message);
    res.status(500).json({ error: 'Erro ao aprovar solicitação' });
  }
});

// POST /api/staff/admin/access-requests/:id/decline
router.post('/access-requests/:id/decline', async (req, res) => {
  try {
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 500) : null;

    const ar = await prisma.accessRequest.findUnique({ where: { id: req.params.id } });
    if (!ar) return res.status(404).json({ error: 'Solicitação não encontrada' });
    if (ar.status !== 'PENDING') return res.status(400).json({ error: 'Solicitação já foi processada' });

    const updated = await prisma.accessRequest.update({
      where: { id: ar.id },
      data: {
        status: 'DECLINED',
        handledAt: new Date(),
        handledById: req.staff?.id ?? null,
        message: reason
          ? (ar.message ? `${ar.message}\n\n[RECUSADA: ${reason}]` : `[RECUSADA: ${reason}]`)
          : ar.message,
      },
    });

    res.json({ id: updated.id });
  } catch (e) {
    console.error('[admin] access-request decline error:', e.message);
    res.status(500).json({ error: 'Erro ao recusar solicitação' });
  }
});

module.exports = router;
