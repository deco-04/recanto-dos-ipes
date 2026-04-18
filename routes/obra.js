'use strict';

/**
 * Obra Management routes — Phase 5 (CDS Obra Management)
 *
 * All routes require ADMIN role.
 *
 * Obra (project) → ObraEtapa (phases/stages) → ObraUpdate (field updates + photos)
 * Expenses with category OBRAS_CONSTRUCAO / MATERIAIS_MELHORIAS can be linked via obraId.
 *
 * Mounted at: /api/admin/obra
 */

const router  = require('express').Router();
const prisma  = require('../lib/db');
const { requireAdmin } = require('../lib/staff-auth-middleware');
const { sendPushToRole } = require('../lib/push');
const crypto  = require('crypto');

router.use(requireAdmin);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const OBRA_STATUSES   = ['PLANEJAMENTO', 'EM_ANDAMENTO', 'PAUSADA', 'CONCLUIDA', 'CANCELADA'];
const ETAPA_STATUSES  = ['PENDENTE', 'EM_ANDAMENTO', 'CONCLUIDA'];

function obraWithProgress(obra) {
  const total     = obra.etapas.length;
  const concluidas = obra.etapas.filter(e => e.status === 'CONCLUIDA').length;
  const pct        = total > 0 ? Math.round((concluidas / total) * 100) : 0;
  // Sum expenses linked to this obra
  const gastoTotal = obra.expenses
    ? obra.expenses.reduce((s, e) => s + Number(e.amount), 0)
    : 0;
  return { ...obra, _progress: pct, _gastoTotal: gastoTotal };
}

// ─────────────────────────────────────────────────────────────────────────────
// Obras CRUD
// ─────────────────────────────────────────────────────────────────────────────

/** GET /api/admin/obra?propertyId=X  — list obras for a property */
router.get('/', async (req, res) => {
  try {
    const { propertyId } = req.query;
    if (!propertyId) return res.status(400).json({ error: 'propertyId obrigatório' });

    const obras = await prisma.obra.findMany({
      where: { propertyId },
      include: {
        etapas: {
          orderBy: { order: 'asc' },
          select: { id: true, title: true, order: true, status: true },
        },
        expenses: { select: { amount: true } },
        fornecedor: { select: { id: true, name: true } },
        createdBy:  { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({ obras: obras.map(obraWithProgress) });
  } catch (err) {
    console.error('[obra] GET /', err);
    res.status(500).json({ error: 'Erro ao listar obras' });
  }
});

/** POST /api/admin/obra — create new obra */
router.post('/', async (req, res) => {
  try {
    const {
      propertyId, title, description,
      startDate, estimatedEndDate, orcamento,
      contractorName, contractorPhone, fornecedorId,
      etapas = [],   // optional: [{ title, description, order }]
    } = req.body;

    if (!propertyId) return res.status(400).json({ error: 'propertyId obrigatório' });
    if (!title?.trim()) return res.status(400).json({ error: 'Título obrigatório' });

    const obra = await prisma.obra.create({
      data: {
        id:          crypto.randomUUID(),
        propertyId,
        title:       title.trim(),
        description: description?.trim() || null,
        startDate:   startDate   ? new Date(startDate)   : null,
        estimatedEndDate: estimatedEndDate ? new Date(estimatedEndDate) : null,
        orcamento:   orcamento != null ? parseFloat(orcamento) : null,
        contractorName:  contractorName?.trim()  || null,
        contractorPhone: contractorPhone?.trim() || null,
        fornecedorId: fornecedorId || null,
        createdById: req.staff.id,
        etapas: etapas.length > 0 ? {
          create: etapas.map((e, i) => ({
            id:          crypto.randomUUID(),
            title:       e.title.trim(),
            description: e.description?.trim() || null,
            order:       e.order ?? i,
          })),
        } : undefined,
      },
      include: {
        etapas:     { orderBy: { order: 'asc' } },
        expenses:   { select: { amount: true } },
        fornecedor: { select: { id: true, name: true } },
        createdBy:  { select: { id: true, name: true } },
      },
    });

    res.status(201).json(obraWithProgress(obra));
  } catch (err) {
    console.error('[obra] POST /', err);
    res.status(500).json({ error: 'Erro ao criar obra' });
  }
});

/** GET /api/admin/obra/:id — full obra detail with etapas + updates + expenses */
router.get('/:id', async (req, res) => {
  try {
    const obra = await prisma.obra.findUnique({
      where: { id: req.params.id },
      include: {
        etapas: {
          orderBy: { order: 'asc' },
          include: {
            updates: {
              orderBy: { createdAt: 'desc' },
              include: { author: { select: { id: true, name: true } } },
            },
          },
        },
        expenses: {
          orderBy: { date: 'desc' },
          select: { id: true, date: true, amount: true, description: true, category: true, payee: true },
        },
        fornecedor: { select: { id: true, name: true, phone: true } },
        createdBy:  { select: { id: true, name: true } },
      },
    });

    if (!obra) return res.status(404).json({ error: 'Obra não encontrada' });
    res.json(obraWithProgress(obra));
  } catch (err) {
    console.error('[obra] GET /:id', err);
    res.status(500).json({ error: 'Erro ao buscar obra' });
  }
});

/** PATCH /api/admin/obra/:id — update obra fields */
router.patch('/:id', async (req, res) => {
  try {
    const {
      title, description, status,
      startDate, estimatedEndDate, actualEndDate,
      orcamento, contractorName, contractorPhone, fornecedorId,
    } = req.body;

    if (status && !OBRA_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Status inválido' });
    }

    const existing = await prisma.obra.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Obra não encontrada' });

    const data = {};
    if (title       != null) data.title       = title.trim();
    if (description != null) data.description = description.trim() || null;
    if (status      != null) data.status      = status;
    if (startDate   != null) data.startDate   = startDate ? new Date(startDate) : null;
    if (estimatedEndDate != null) data.estimatedEndDate = estimatedEndDate ? new Date(estimatedEndDate) : null;
    if (actualEndDate    != null) data.actualEndDate    = actualEndDate    ? new Date(actualEndDate)    : null;
    if (orcamento        != null) data.orcamento        = orcamento != '' ? parseFloat(orcamento) : null;
    if (contractorName   != null) data.contractorName  = contractorName.trim()  || null;
    if (contractorPhone  != null) data.contractorPhone = contractorPhone.trim() || null;
    if (fornecedorId     != null) data.fornecedorId    = fornecedorId || null;

    // Auto-set actualEndDate when marking CONCLUIDA (if not explicitly provided)
    if (status === 'CONCLUIDA' && !data.actualEndDate && !existing.actualEndDate) {
      data.actualEndDate = new Date();
    }

    const updated = await prisma.obra.update({
      where: { id: req.params.id },
      data,
      include: {
        etapas:     { orderBy: { order: 'asc' }, select: { id: true, title: true, order: true, status: true } },
        expenses:   { select: { amount: true } },
        fornecedor: { select: { id: true, name: true } },
        createdBy:  { select: { id: true, name: true } },
      },
    });

    // Push notification to all admins if status changed to CONCLUIDA
    if (status === 'CONCLUIDA' && existing.status !== 'CONCLUIDA') {
      sendPushToRole('ADMIN', {
        title: '🏗️ Obra concluída',
        body:  `"${updated.title}" foi marcada como concluída.`,
        data:  { url: `/admin/obra/${updated.id}` },
      }).catch(() => {});
    }

    res.json(obraWithProgress(updated));
  } catch (err) {
    console.error('[obra] PATCH /:id', err);
    res.status(500).json({ error: 'Erro ao atualizar obra' });
  }
});

/** DELETE /api/admin/obra/:id — delete obra (cascades to etapas + updates) */
router.delete('/:id', async (req, res) => {
  try {
    const existing = await prisma.obra.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Obra não encontrada' });

    await prisma.obra.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) {
    console.error('[obra] DELETE /:id', err);
    res.status(500).json({ error: 'Erro ao remover obra' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Etapas CRUD
// ─────────────────────────────────────────────────────────────────────────────

/** POST /api/admin/obra/:id/etapas — add a new etapa */
router.post('/:id/etapas', async (req, res) => {
  try {
    const { title, description } = req.body;
    if (!title?.trim()) return res.status(400).json({ error: 'Título obrigatório' });

    // Auto-order: place after the last existing etapa
    const lastEtapa = await prisma.obraEtapa.findFirst({
      where:   { obraId: req.params.id },
      orderBy: { order: 'desc' },
      select:  { order: true },
    });
    const order = lastEtapa ? lastEtapa.order + 1 : 0;

    const etapa = await prisma.obraEtapa.create({
      data: {
        id:          crypto.randomUUID(),
        obraId:      req.params.id,
        title:       title.trim(),
        description: description?.trim() || null,
        order,
      },
    });

    res.status(201).json(etapa);
  } catch (err) {
    console.error('[obra] POST /:id/etapas', err);
    res.status(500).json({ error: 'Erro ao adicionar etapa' });
  }
});

/** PATCH /api/admin/obra/:id/etapas/:etapaId — update etapa */
router.patch('/:id/etapas/:etapaId', async (req, res) => {
  try {
    const { title, description, status, order } = req.body;

    if (status && !ETAPA_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Status inválido' });
    }

    const existing = await prisma.obraEtapa.findFirst({
      where: { id: req.params.etapaId, obraId: req.params.id },
    });
    if (!existing) return res.status(404).json({ error: 'Etapa não encontrada' });

    const data = {};
    if (title       != null) data.title       = title.trim();
    if (description != null) data.description = description.trim() || null;
    if (status      != null) data.status      = status;
    if (order       != null) data.order       = parseInt(order);

    // Timestamps on status transitions
    if (status === 'EM_ANDAMENTO' && existing.status === 'PENDENTE' && !existing.startedAt) {
      data.startedAt = new Date();
    }
    if (status === 'CONCLUIDA' && existing.status !== 'CONCLUIDA') {
      data.concluidaAt = new Date();
    }

    const updated = await prisma.obraEtapa.update({
      where: { id: req.params.etapaId },
      data,
    });

    // If all etapas are now CONCLUIDA, push admin notification
    if (status === 'CONCLUIDA') {
      const pending = await prisma.obraEtapa.count({
        where: { obraId: req.params.id, status: { not: 'CONCLUIDA' } },
      });
      if (pending === 0) {
        const obra = await prisma.obra.findUnique({ where: { id: req.params.id }, select: { title: true } });
        sendPushToRole('ADMIN', {
          title: '✅ Todas as etapas concluídas',
          body:  `Todas as etapas de "${obra?.title}" foram finalizadas.`,
          data:  { url: `/admin/obra/${req.params.id}` },
        }).catch(() => {});
      }
    }

    res.json(updated);
  } catch (err) {
    console.error('[obra] PATCH /:id/etapas/:etapaId', err);
    res.status(500).json({ error: 'Erro ao atualizar etapa' });
  }
});

/** DELETE /api/admin/obra/:id/etapas/:etapaId */
router.delete('/:id/etapas/:etapaId', async (req, res) => {
  try {
    const existing = await prisma.obraEtapa.findFirst({
      where: { id: req.params.etapaId, obraId: req.params.id },
    });
    if (!existing) return res.status(404).json({ error: 'Etapa não encontrada' });

    await prisma.obraEtapa.delete({ where: { id: req.params.etapaId } });
    res.json({ ok: true });
  } catch (err) {
    console.error('[obra] DELETE etapa', err);
    res.status(500).json({ error: 'Erro ao remover etapa' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Updates (field progress logs per etapa)
// ─────────────────────────────────────────────────────────────────────────────

/** POST /api/admin/obra/:id/etapas/:etapaId/updates */
router.post('/:id/etapas/:etapaId/updates', async (req, res) => {
  try {
    const { body, photoUrls = [] } = req.body;
    if (!body?.trim()) return res.status(400).json({ error: 'Texto do update obrigatório' });

    const etapa = await prisma.obraEtapa.findFirst({
      where: { id: req.params.etapaId, obraId: req.params.id },
    });
    if (!etapa) return res.status(404).json({ error: 'Etapa não encontrada' });

    const update = await prisma.obraUpdate.create({
      data: {
        id:        crypto.randomUUID(),
        etapaId:   req.params.etapaId,
        authorId:  req.staff.id,
        body:      body.trim(),
        photoUrls: Array.isArray(photoUrls) ? photoUrls : [],
      },
      include: { author: { select: { id: true, name: true } } },
    });

    res.status(201).json(update);
  } catch (err) {
    console.error('[obra] POST update', err);
    res.status(500).json({ error: 'Erro ao adicionar update' });
  }
});

/** DELETE /api/admin/obra/:id/etapas/:etapaId/updates/:updateId */
router.delete('/:id/etapas/:etapaId/updates/:updateId', async (req, res) => {
  try {
    const update = await prisma.obraUpdate.findFirst({
      where: { id: req.params.updateId, etapaId: req.params.etapaId },
    });
    if (!update) return res.status(404).json({ error: 'Update não encontrado' });

    await prisma.obraUpdate.delete({ where: { id: req.params.updateId } });
    res.json({ ok: true });
  } catch (err) {
    console.error('[obra] DELETE update', err);
    res.status(500).json({ error: 'Erro ao remover update' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Expenses linked to an obra (link / unlink existing expense)
// ─────────────────────────────────────────────────────────────────────────────

/** PATCH /api/admin/obra/:id/expenses/:expenseId — link expense to this obra */
router.patch('/:id/expenses/:expenseId', async (req, res) => {
  try {
    const updated = await prisma.expense.update({
      where: { id: req.params.expenseId },
      data:  { obraId: req.params.id },
      select: { id: true, amount: true, description: true, date: true, category: true },
    });
    res.json(updated);
  } catch (err) {
    console.error('[obra] PATCH link expense', err);
    res.status(500).json({ error: 'Erro ao vincular despesa' });
  }
});

/** DELETE /api/admin/obra/:id/expenses/:expenseId — unlink expense from obra */
router.delete('/:id/expenses/:expenseId', async (req, res) => {
  try {
    await prisma.expense.update({
      where: { id: req.params.expenseId },
      data:  { obraId: null },
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[obra] DELETE unlink expense', err);
    res.status(500).json({ error: 'Erro ao desvincular despesa' });
  }
});

module.exports = router;
