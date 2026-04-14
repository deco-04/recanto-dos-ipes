'use strict';

/**
 * Content Agent routes — AI Content Approval Pipeline
 *
 * All endpoints require a valid staff Bearer token.
 * POST /gerar-agora/:brand requires ADMIN role.
 */

const express = require('express');
const jwt     = require('jsonwebtoken');
const { z }   = require('zod');
const prisma  = require('../lib/db');
const { createWeeklyPackage, regeneratePost } = require('../lib/conteudo-agent');
const { schedulePost, cancelScheduledPost }   = require('../lib/ghl-social');
const { sendPushToRole } = require('../lib/push');

const router = express.Router();

// ── Auth middleware ────────────────────────────────────────────────────────────
async function requireStaff(req, res, next) {
  const auth  = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  let payload;
  try {
    payload = jwt.verify(token, process.env.STAFF_JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Token inválido' });
  }

  const staff = await prisma.staffMember.findUnique({
    where:  { id: payload.sub },
    select: { id: true, role: true, active: true },
  });
  if (!staff || !staff.active) return res.status(401).json({ error: 'Acesso negado' });

  req.staff = staff;
  next();
}

function requireAdmin(req, res, next) {
  if (req.staff?.role !== 'ADMIN') return res.status(403).json({ error: 'Acesso negado' });
  next();
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function serializePost(p) {
  return {
    id:          p.id,
    brand:       p.brand,
    title:       p.title,
    body:        p.body,
    contentType: p.contentType,
    pillar:      p.pillar,
    stage:       p.stage,
    aiGenerated: p.aiGenerated,
    ghlPostId:   p.ghlPostId,
    scheduledFor: p.scheduledFor,
    publishedAt:  p.publishedAt,
    mediaUrls:   p.mediaUrls,
    createdAt:   p.createdAt,
    updatedAt:   p.updatedAt,
    comments:    p.comments?.map(c => ({
      id:       c.id,
      body:     c.body,
      staffId:  c.staffId,
      name:     c.staff?.name ?? null,
      createdAt: c.createdAt,
    })) ?? [],
  };
}

// ── GET /conteudo — posts grouped by stage ─────────────────────────────────────
router.get('/', requireStaff, async (req, res) => {
  try {
    const { brand } = req.query;
    const property = await prisma.property.findFirst({ where: { active: true } });
    if (!property) return res.status(500).json({ error: 'No active property' });

    const where = { propertyId: property.id };
    if (brand && ['RDI', 'RDS', 'CDS'].includes(brand)) where.brand = brand;

    const posts = await prisma.contentPost.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        comments: {
          include: { staff: { select: { name: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    // Group by stage
    const stages = ['GERADO', 'EM_REVISAO', 'APROVADO', 'AGENDADO', 'PUBLICADO'];
    const grouped = Object.fromEntries(
      stages.map(s => [s, posts.filter(p => p.stage === s).map(serializePost)])
    );

    res.json(grouped);
  } catch (err) {
    console.error('[content] GET / error:', err);
    res.status(500).json({ error: 'Erro ao carregar posts' });
  }
});

// ── PATCH /conteudo/:id — update body/stage; auto-schedule on APROVADO ─────────
router.patch('/:id', requireStaff, async (req, res) => {
  const schema = z.object({
    title:       z.string().max(200).optional(),
    body:        z.string().optional(),
    stage:       z.enum(['GERADO', 'EM_REVISAO', 'APROVADO', 'AGENDADO', 'PUBLICADO']).optional(),
    scheduledFor: z.string().datetime().optional(),
    mediaUrls:   z.array(z.string()).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Dados inválidos' });

  try {
    const post = await prisma.contentPost.findUnique({ where: { id: req.params.id } });
    if (!post) return res.status(404).json({ error: 'Post não encontrado' });

    const data = { ...parsed.data };
    if (data.scheduledFor) data.scheduledFor = new Date(data.scheduledFor);

    // On APROVADO → schedule to GHL Social Planner
    if (parsed.data.stage === 'APROVADO' && post.stage !== 'APROVADO') {
      const property = await prisma.property.findFirst({ where: { active: true } });
      const config   = await prisma.brandContentConfig.findFirst({
        where: { brand: post.brand, propertyId: property?.id },
      }) || {};

      try {
        const ghlPostId = await schedulePost({ ...post, ...data }, config);
        if (ghlPostId) {
          data.ghlPostId = ghlPostId;
          data.stage     = 'AGENDADO';
        }
      } catch (e) {
        console.error('[content] GHL schedule error:', e.message);
        // Still mark as APROVADO even if GHL fails
      }
    }

    // Cancel GHL post if admin moves back from AGENDADO
    if (post.stage === 'AGENDADO' && parsed.data.stage && parsed.data.stage !== 'AGENDADO' && parsed.data.stage !== 'PUBLICADO') {
      if (post.ghlPostId) {
        await cancelScheduledPost(post.ghlPostId);
        data.ghlPostId = null;
      }
    }

    const updated = await prisma.contentPost.update({
      where:   { id: req.params.id },
      data,
      include: { comments: { include: { staff: { select: { name: true } } } } },
    });

    res.json(serializePost(updated));
  } catch (err) {
    console.error('[content] PATCH error:', err);
    res.status(500).json({ error: err.message || 'Erro ao atualizar post' });
  }
});

// ── POST /conteudo/:id/regenerar — regenerate with optional feedback ───────────
router.post('/:id/regenerar', requireStaff, async (req, res) => {
  const { feedback } = req.body;
  try {
    const updated = await regeneratePost(req.params.id, feedback);
    res.json(serializePost({ ...updated, comments: [] }));
  } catch (err) {
    console.error('[content] regenerar error:', err);
    res.status(500).json({ error: err.message || 'Erro ao regenerar post' });
  }
});

// ── POST /conteudo/:id/comentar — add a comment ────────────────────────────────
router.post('/:id/comentar', requireStaff, async (req, res) => {
  const { body } = req.body;
  if (!body?.trim()) return res.status(400).json({ error: 'body é obrigatório' });

  try {
    const comment = await prisma.contentComment.create({
      data: {
        postId:  req.params.id,
        staffId: req.staff.id,
        body,
      },
      include: { staff: { select: { name: true } } },
    });

    // Push to ADMIN if commenter is not ADMIN
    if (req.staff.role !== 'ADMIN') {
      sendPushToRole('ADMIN', {
        title: 'Novo comentário no post ✏️',
        body:  body.length > 60 ? body.slice(0, 60) + '…' : body,
        type:  'CONTENT_COMMENT',
        data:  { postId: req.params.id },
      }).catch(() => {});
    }

    res.json({ id: comment.id, body: comment.body, staffId: comment.staffId, name: comment.staff?.name ?? null, createdAt: comment.createdAt });
  } catch (err) {
    console.error('[content] comentar error:', err);
    res.status(500).json({ error: 'Erro ao adicionar comentário' });
  }
});

// ── DELETE /conteudo/:id — discard post ────────────────────────────────────────
router.delete('/:id', requireStaff, requireAdmin, async (req, res) => {
  try {
    const post = await prisma.contentPost.findUnique({ where: { id: req.params.id } });
    if (!post) return res.status(404).json({ error: 'Post não encontrado' });

    // Cancel GHL if scheduled
    if (post.ghlPostId) {
      await cancelScheduledPost(post.ghlPostId);
    }

    await prisma.contentPost.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) {
    console.error('[content] DELETE error:', err);
    res.status(500).json({ error: 'Erro ao excluir post' });
  }
});

// ── GET /conteudo/config/:brand — read brand config ───────────────────────────
router.get('/config/:brand', requireStaff, async (req, res) => {
  const { brand } = req.params;
  if (!['RDI', 'RDS', 'CDS'].includes(brand)) {
    return res.status(400).json({ error: 'Brand inválida' });
  }
  try {
    const property = await prisma.property.findFirst({ where: { active: true } });
    const config   = await prisma.brandContentConfig.findFirst({
      where: { brand, propertyId: property?.id },
    });
    res.json(config || { brand, postsPerWeek: 5 });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao carregar configuração' });
  }
});

// ── PUT /conteudo/config/:brand — write brand config ─────────────────────────
router.put('/config/:brand', requireStaff, requireAdmin, async (req, res) => {
  const { brand } = req.params;
  if (!['RDI', 'RDS', 'CDS'].includes(brand)) {
    return res.status(400).json({ error: 'Brand inválida' });
  }

  const schema = z.object({
    voiceNotes:      z.string().max(2000).optional(),
    upcomingThemes:  z.string().max(2000).optional(),
    pillarMix:       z.record(z.number()).optional(),
    postsPerWeek:    z.number().int().min(1).max(20).optional(),
    postingSchedule: z.array(z.any()).optional(),
    defaultHashtags: z.string().max(500).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Dados inválidos' });

  try {
    const property = await prisma.property.findFirst({ where: { active: true } });
    if (!property) return res.status(500).json({ error: 'No active property' });

    const config = await prisma.brandContentConfig.upsert({
      where:  { brand_propertyId: { brand, propertyId: property.id } },
      update: parsed.data,
      create: { brand, propertyId: property.id, ...parsed.data },
    });

    res.json(config);
  } catch (err) {
    console.error('[content] PUT config error:', err);
    res.status(500).json({ error: 'Erro ao salvar configuração' });
  }
});

// ── POST /conteudo/gerar-agora/:brand — manual trigger ────────────────────────
router.post('/gerar-agora/:brand', requireStaff, requireAdmin, async (req, res) => {
  const { brand } = req.params;
  if (!['RDI', 'RDS', 'CDS'].includes(brand)) {
    return res.status(400).json({ error: 'Brand inválida' });
  }

  try {
    const property = await prisma.property.findFirst({ where: { active: true } });
    if (!property) return res.status(500).json({ error: 'No active property' });

    res.json({ ok: true, message: 'Gerando…' }); // respond immediately

    // Run in background
    createWeeklyPackage(brand, property.id)
      .then(posts => {
        sendPushToRole('ADMIN', {
          title: `Conteúdo ${brand} gerado ✨`,
          body:  `${posts.length} posts aguardando revisão`,
          type:  'CONTENT_PACKAGE_READY',
          data:  { brand, propertyId: property.id },
        }).catch(() => {});
      })
      .catch(e => console.error(`[content] gerar-agora ${brand} error:`, e.message));
  } catch (err) {
    console.error('[content] gerar-agora error:', err);
    res.status(500).json({ error: 'Erro ao gerar conteúdo' });
  }
});

module.exports = router;
