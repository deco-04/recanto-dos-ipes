'use strict';

/**
 * Admin endpoints for WhatsApp template management + NPS dashboard data.
 *
 * All routes require a valid staff Bearer token (requireStaff middleware).
 * Template editing (PATCH) is admin-only.
 *
 * GET  /api/staff/wa-templates             — list all templates
 * PATCH /api/staff/wa-templates/:id        — update template name or active flag (admin only)
 * GET  /api/staff/nps                      — NPS dashboard data (all roles)
 * GET  /api/staff/message-log              — recent WA send/receive log (admin only)
 */

const express = require('express');
const prisma  = require('../lib/db');
const { requireStaff } = require('../lib/staff-auth-middleware');

const router = express.Router();

// ── GET /wa-templates ─────────────────────────────────────────────────────────
router.get('/wa-templates', requireStaff, async (req, res) => {
  try {
    const templates = await prisma.messageTemplate.findMany({
      orderBy: { triggerEvent: 'asc' },
    });
    res.json(templates);
  } catch (err) {
    console.error('[wa-admin] GET templates error:', err);
    res.status(500).json({ error: 'Erro ao carregar templates' });
  }
});

// ── PATCH /wa-templates/:id ───────────────────────────────────────────────────
router.patch('/wa-templates/:id', requireStaff, async (req, res) => {
  if (req.staff.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Apenas administradores podem editar templates' });
  }

  const { name, active } = req.body;

  // Validate Meta template name format: lowercase, underscores, numbers only
  if (name !== undefined) {
    if (typeof name !== 'string' || !/^[a-z0-9_]{1,512}$/.test(name)) {
      return res.status(400).json({ error: 'Nome do template inválido (use apenas letras minúsculas, números e _)' });
    }
  }

  try {
    const tpl = await prisma.messageTemplate.findUnique({
      where: { id: req.params.id },
    });
    if (!tpl) return res.status(404).json({ error: 'Template não encontrado' });

    const updated = await prisma.messageTemplate.update({
      where: { id: req.params.id },
      data: {
        ...(name   !== undefined && { name }),
        ...(active !== undefined && { active: Boolean(active) }),
      },
    });

    res.json(updated);
  } catch (err) {
    console.error('[wa-admin] PATCH template error:', err);
    res.status(500).json({ error: 'Erro ao atualizar template' });
  }
});

// ── GET /nps ──────────────────────────────────────────────────────────────────
// Returns NPS dashboard data. Accessible by all roles (team accountability).
//
// Query params:
//   period  = 'month' (default) | 'quarter' | 'year' | 'all'
//   offset  = month offset (0=current, 1=last month, etc.)
router.get('/nps', requireStaff, async (req, res) => {
  try {
    const period = req.query.period || 'month';
    const offset = parseInt(req.query.offset) || 0;

    const now   = new Date();
    let startDate = null;

    if (period === 'month') {
      startDate = new Date(now.getFullYear(), now.getMonth() - offset, 1);
      startDate.setHours(0, 0, 0, 0);
    } else if (period === 'quarter') {
      const quarterStart = Math.floor(now.getMonth() / 3) * 3;
      startDate = new Date(now.getFullYear(), quarterStart - offset * 3, 1);
      startDate.setHours(0, 0, 0, 0);
    } else if (period === 'year') {
      startDate = new Date(now.getFullYear() - offset, 0, 1);
      startDate.setHours(0, 0, 0, 0);
    }

    const where = {
      npsScore:    { not: null },
      respondedAt: { not: null },
      ...(startDate ? { respondedAt: { gte: startDate } } : {}),
    };

    const surveys = await prisma.survey.findMany({
      where,
      include: {
        booking: {
          select: { guestName: true, checkIn: true, checkOut: true, id: true },
        },
      },
      orderBy: { respondedAt: 'desc' },
    });

    // Total surveys sent (denominator for response rate)
    const totalSent = await prisma.booking.count({
      where: {
        surveyStatus: { in: ['ENVIADO', 'RESPONDIDO'] },
        ...(startDate ? { checkOut: { gte: startDate } } : {}),
      },
    });

    const promotores  = surveys.filter(s => s.npsClassification === 'promotor').length;
    const neutros     = surveys.filter(s => s.npsClassification === 'neutro').length;
    const detratores  = surveys.filter(s => s.npsClassification === 'detrator').length;
    const total       = surveys.length;

    // NPS score = % promotores − % detratores (−100 to +100)
    const npsScore = total > 0
      ? Math.round(((promotores - detratores) / total) * 100)
      : null;

    const avgNpsScore = total > 0
      ? Math.round(surveys.reduce((sum, s) => sum + (s.npsScore ?? 0), 0) / total * 10) / 10
      : null;

    // Trend: last 6 months regardless of period filter
    const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);
    const trendSurveys = await prisma.survey.findMany({
      where: {
        npsScore:    { not: null },
        respondedAt: { gte: sixMonthsAgo },
      },
      select: { npsScore: true, npsClassification: true, respondedAt: true },
    });

    const trendByMonth = {};
    for (const s of trendSurveys) {
      const key = s.respondedAt.toISOString().slice(0, 7); // YYYY-MM
      if (!trendByMonth[key]) trendByMonth[key] = { promotores: 0, detratores: 0, total: 0, sum: 0 };
      trendByMonth[key].total++;
      trendByMonth[key].sum += s.npsScore ?? 0;
      if (s.npsClassification === 'promotor')  trendByMonth[key].promotores++;
      if (s.npsClassification === 'detrator') trendByMonth[key].detratores++;
    }
    const trend = Object.entries(trendByMonth)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, d]) => ({
        month,
        npsScore:  Math.round(((d.promotores - d.detratores) / d.total) * 100),
        avgScore:  Math.round(d.sum / d.total * 10) / 10,
        count:     d.total,
      }));

    res.json({
      period,
      total,
      totalSent,
      responseRate: totalSent > 0 ? Math.round((total / totalSent) * 100) : 0,
      npsScore,
      avgNpsScore,
      promotores,
      neutros,
      detratores,
      trend,
      recentResponses: surveys.slice(0, 50).map(s => ({
        id:             s.id,
        bookingId:      s.bookingId,
        guestName:      s.booking?.guestName ?? 'Hóspede',
        checkIn:        s.booking?.checkIn ?? null,
        checkOut:       s.booking?.checkOut ?? null,
        npsScore:       s.npsScore,
        starScore:      s.score,
        classification: s.npsClassification,
        comment:        s.comment,
        respondedAt:    s.respondedAt,
        followUpSent:   s.npsFollowUpSent,
        googleReviewSent: s.googleReviewLinkSent,
      })),
    });
  } catch (err) {
    console.error('[wa-admin] GET nps error:', err);
    res.status(500).json({ error: 'Erro ao carregar dados NPS' });
  }
});

// ── GET /message-log ──────────────────────────────────────────────────────────
router.get('/message-log', requireStaff, async (req, res) => {
  if (req.staff.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Acesso restrito a administradores' });
  }

  try {
    const { page = '1', limit = '50' } = req.query;
    const parsedPage  = Math.max(1, parseInt(page)  || 1);
    const parsedLimit = Math.min(100, parseInt(limit) || 50);
    const skip        = (parsedPage - 1) * parsedLimit;

    const [logs, total] = await Promise.all([
      prisma.messageLog.findMany({
        orderBy: { sentAt: 'desc' },
        skip,
        take:    parsedLimit,
        include: { booking: { select: { guestName: true } } },
      }),
      prisma.messageLog.count(),
    ]);

    res.json({
      logs: logs.map(l => ({
        id:           l.id,
        guestPhone:   l.guestPhone,
        guestName:    l.booking?.guestName ?? null,
        templateName: l.templateName,
        direction:    l.direction,
        body:         l.body,
        status:       l.status,
        errorMessage: l.errorMessage,
        sentAt:       l.sentAt,
      })),
      total,
      page: parsedPage,
    });
  } catch (err) {
    console.error('[wa-admin] GET message-log error:', err);
    res.status(500).json({ error: 'Erro ao carregar log de mensagens' });
  }
});

module.exports = router;
