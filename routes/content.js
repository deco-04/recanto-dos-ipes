'use strict';

/**
 * Content Agent routes — AI Content Approval Pipeline
 *
 * All endpoints require a valid staff Bearer token.
 * POST /gerar-agora/:brand requires ADMIN role.
 */

const express = require('express');
const { z }   = require('zod');
const prisma  = require('../lib/db');
const { createWeeklyPackage, regeneratePost, createImprovedAlternative, createRdiBlogPost } = require('../lib/conteudo-agent');
const { schedulePost, cancelScheduledPost }   = require('../lib/ghl-social');
const { sendPushToRole } = require('../lib/push');
const { requireStaff, requireAdmin } = require('../lib/staff-auth-middleware');
const { slugForBrand, parseGerarBody } = require('../lib/content-gerar-helpers');

const router = express.Router();

// ── Helpers ───────────────────────────────────────────────────────────────────
function serializePost(p) {
  return {
    id:           p.id,
    brand:        p.brand,
    title:        p.title,
    body:         p.body,
    contentType:  p.contentType,
    pillar:       p.pillar,
    stage:        p.stage,
    aiGenerated:  p.aiGenerated,
    ghlPostId:    p.ghlPostId,
    scheduledFor: p.scheduledFor,
    publishedAt:  p.publishedAt,
    mediaUrls:    p.mediaUrls,
    imagePrompt:  p.imagePrompt   ?? null,
    feedbackNotes: p.feedbackNotes ?? null,
    parentPostId: p.parentPostId  ?? null,
    createdAt:    p.createdAt,
    updatedAt:    p.updatedAt,
    comments:     p.comments?.map(c => ({
      id:        c.id,
      body:      c.body,
      staffId:   c.staffId,
      name:      c.staff?.name ?? null,
      createdAt: c.createdAt,
    })) ?? [],
  };
}

const ALL_STAGES = ['GERADO', 'EM_REVISAO', 'APROVADO', 'AGENDADO', 'PUBLICADO', 'AJUSTE_NECESSARIO', 'REJEITADO'];

// ── GET /conteudo/pending-count — count of posts needing attention ───────────────
router.get('/pending-count', requireStaff, async (req, res) => {
  try {
    const property = await prisma.property.findFirst({ where: { active: true } });
    if (!property) return res.json({ count: 0 });
    const count = await prisma.contentPost.count({
      where: {
        propertyId: property.id,
        // Includes rejection/adjustment stages so badge stays red until resolved
        stage: { in: ['GERADO', 'EM_REVISAO', 'AJUSTE_NECESSARIO', 'REJEITADO'] },
      },
    });
    res.json({ count });
  } catch {
    res.json({ count: 0 }); // fail silently — it's just a badge
  }
});

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

    // Group by all stages including rejection/adjustment
    const grouped = Object.fromEntries(
      ALL_STAGES.map(s => [s, posts.filter(p => p.stage === s).map(serializePost)])
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
    title:        z.string().max(200).optional(),
    body:         z.string().optional(),
    stage:        z.enum(['GERADO', 'EM_REVISAO', 'APROVADO', 'AGENDADO', 'PUBLICADO', 'AJUSTE_NECESSARIO', 'REJEITADO']).optional(),
    scheduledFor: z.string().datetime().optional(),
    mediaUrls:    z.array(z.string()).optional(),
    imagePrompt:  z.string().optional(),
    feedbackNotes: z.string().max(2000).optional(), // admin feedback for rejection/adjustment
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Dados inválidos' });

  try {
    const post = await prisma.contentPost.findUnique({ where: { id: req.params.id } });
    if (!post) return res.status(404).json({ error: 'Post não encontrado' });

    const data = { ...parsed.data };
    if (data.scheduledFor) data.scheduledFor = new Date(data.scheduledFor);

    // ── On PUBLICADO → set publishedAt if not already set ────────────────────
    if (parsed.data.stage === 'PUBLICADO' && post.stage !== 'PUBLICADO' && !post.publishedAt) {
      data.publishedAt = new Date();
    }

    // ── On AJUSTE_NECESSARIO or REJEITADO → save feedback + auto-generate alternative ──
    const isRejectionStage = parsed.data.stage === 'AJUSTE_NECESSARIO' || parsed.data.stage === 'REJEITADO';
    if (isRejectionStage && post.stage !== parsed.data.stage) {
      const feedback = parsed.data.feedbackNotes || '';
      if (feedback) data.feedbackNotes = feedback;

      // Persist stage change first so we respond quickly
      const updated = await prisma.contentPost.update({
        where:   { id: req.params.id },
        data,
        include: { comments: { include: { staff: { select: { name: true } } } } },
      });

      // Auto-generate an improved alternative in background (only if feedback given)
      if (feedback) {
        createImprovedAlternative(req.params.id, feedback)
          .then(alt => {
            sendPushToRole('ADMIN', {
              title: 'Alternativa gerada 🔄',
              body:  `Nova versão de "${post.title}" aguarda revisão`,
              type:  'CONTENT_ALTERNATIVE_READY',
              data:  { postId: alt.id, parentPostId: req.params.id },
            }).catch(() => {});
          })
          .catch(e => console.error('[content] createImprovedAlternative error:', e.message));
      }

      return res.json(serializePost(updated));
    }

    // ── On APROVADO for BLOG content → publish immediately, skip GHL ─────────
    if (parsed.data.stage === 'APROVADO' && post.stage !== 'APROVADO' && post.contentType === 'BLOG') {
      data.stage       = 'PUBLICADO';
      data.publishedAt = new Date();

      const updated = await prisma.contentPost.update({
        where:   { id: req.params.id },
        data,
        include: { comments: { include: { staff: { select: { name: true } } } } },
      });

      return res.json(serializePost(updated));
    }

    // ── On APROVADO for non-BLOG content → schedule to GHL Social Planner ────
    if (parsed.data.stage === 'APROVADO' && post.stage !== 'APROVADO') {
      const property = await prisma.property.findFirst({ where: { active: true } });
      const config   = await prisma.brandContentConfig.findFirst({
        where: { brand: post.brand, propertyId: property?.id },
      }) || {};

      let ghlPostId = null;
      let ghlFailed = false;
      try {
        const id = await schedulePost({ ...post, ...data }, config);
        if (id) {
          ghlPostId = id;
          data.stage = 'AGENDADO';
        }
      } catch (e) {
        console.error('[content] GHL schedule error:', e.message);
        ghlFailed = true;
        // Still continue — post will be APROVADO without ghlPostId
      }

      if (ghlPostId) data.ghlPostId = ghlPostId;

      // Atomic update — only succeeds if another request hasn't already approved it
      const result = await prisma.contentPost.updateMany({
        where: { id: req.params.id, stage: { not: 'APROVADO' } },
        data,
      });

      if (result.count === 0) {
        return res.status(409).json({ error: 'Post já aprovado por outra requisição' });
      }

      // Fetch the updated post with comments for response
      const updated = await prisma.contentPost.findUnique({
        where:   { id: req.params.id },
        include: { comments: { include: { staff: { select: { name: true } } } } },
      });

      const response = serializePost(updated);
      if (ghlFailed) response.ghlError = true;
      return res.json(response);
    }

    // ── Cancel GHL post if admin moves back from AGENDADO ────────────────────
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

// ── POST /conteudo/:id/alternativa — manually trigger an improved alternative ────
// Used by the staff app "Gerar alternativa" button on rejected/flagged cards.
router.post('/:id/alternativa', requireStaff, async (req, res) => {
  const { feedback } = req.body;
  if (!feedback?.trim()) return res.status(400).json({ error: 'feedback é obrigatório' });
  try {
    const alt = await createImprovedAlternative(req.params.id, feedback);
    res.json(serializePost({ ...alt, comments: [] }));
  } catch (err) {
    console.error('[content] alternativa error:', err);
    res.status(500).json({ error: err.message || 'Erro ao criar alternativa' });
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
  const slug = slugForBrand(req.params.brand);
  if (!slug) return res.status(400).json({ error: 'Brand inválida' });

  try {
    const property = await prisma.property.findFirst({ where: { slug, active: true } });
    const config   = await prisma.brandContentConfig.findFirst({
      where: { brand: req.params.brand, propertyId: property?.id },
    });
    res.json(config || { brand: req.params.brand, postsPerWeek: 5 });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao carregar configuração' });
  }
});

// ── PUT /conteudo/config/:brand — write brand config ─────────────────────────
router.put('/config/:brand', requireStaff, requireAdmin, async (req, res) => {
  const slug = slugForBrand(req.params.brand);
  if (!slug) return res.status(400).json({ error: 'Brand inválida' });

  const schema = z.object({
    voiceNotes:      z.string().max(2000).optional(),
    upcomingThemes:  z.string().max(2000).optional(),
    pillarMix:       z.record(z.number()).optional(),
    postsPerWeek:    z.number().int().min(1).max(20).optional(),
    postingSchedule: z.array(z.any()).optional(),
    defaultHashtags: z.string().max(500).optional(),
    imageLibraryUrl: z.string().url().nullable().optional().or(z.literal('')),
    aiImageFallback: z.boolean().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    // Surface the exact Zod issue list so the admin knows what's wrong rather
    // than seeing a generic "Dados inválidos". Cost: leaks the field name,
    // which is fine for authenticated admins.
    console.error('[content] PUT config zod fail:', JSON.stringify(parsed.error.errors));
    return res.status(400).json({ error: 'Dados inválidos', details: parsed.error.errors });
  }

  // Normalize empty string → null for the nullable URL field
  const data = { ...parsed.data };
  if (data.imageLibraryUrl === '') data.imageLibraryUrl = null;

  try {
    const property = await prisma.property.findFirst({ where: { slug, active: true } });
    if (!property) {
      console.error(`[content] PUT config no active property for slug "${slug}" (brand=${req.params.brand})`);
      return res.status(400).json({ error: `Propriedade "${slug}" não está ativa` });
    }

    const config = await prisma.brandContentConfig.upsert({
      where:  { brand_propertyId: { brand: req.params.brand, propertyId: property.id } },
      update: data,
      create: { brand: req.params.brand, propertyId: property.id, ...data },
    });

    res.json(config);
  } catch (err) {
    console.error('[content] PUT config upsert error:', err?.code, err?.message, err?.meta);
    res.status(500).json({
      error:   'Erro ao salvar configuração',
      details: { code: err?.code, message: err?.message },
    });
  }
});

// ── POST /conteudo/gerar-agora/:brand — manual trigger ────────────────────────
// Body (optional):
//   { contentTypes?: ContentType[], count?: number }
// Both fields are sanitized by parseGerarBody before reaching the agent.
router.post('/gerar-agora/:brand', requireStaff, requireAdmin, async (req, res) => {
  const { brand } = req.params;
  const slug = slugForBrand(brand);
  if (!slug) return res.status(400).json({ error: 'Brand inválida' });

  try {
    // D1: pick the property that matches the brand, not "first active". Prevents
    // CDS posts from silently attaching to the RDI property (and vice versa).
    const property = await prisma.property.findFirst({ where: { slug, active: true } });
    if (!property) return res.status(400).json({ error: `Propriedade "${slug}" não está ativa` });

    // D2: accept an optional channel + count filter so the admin can request
    // "just one BLOG" or "only Instagram" instead of the full weekly mix.
    const { contentTypes, count } = parseGerarBody(req.body);

    res.json({ ok: true, message: 'Gerando…', brand, propertyId: property.id, contentTypes, count });

    // Run in background
    createWeeklyPackage(brand, property.id, { contentTypes, count })
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

// ── POST /conteudo/gerar-blog-rdi — manual trigger for RDI SEO blog post ─────
router.post('/gerar-blog-rdi', requireStaff, requireAdmin, async (req, res) => {
  try {
    const property = await prisma.property.findFirst({
      where: { active: true, type: 'SITIO' },
    });
    if (!property) return res.status(500).json({ error: 'No active SITIO property' });

    res.json({ ok: true, message: 'Gerando post de blog…' }); // respond immediately

    createRdiBlogPost(property.id)
      .then(post => {
        sendPushToRole('ADMIN', {
          title: 'Blog RDI gerado ✍️',
          body:  `"${post.title}" aguarda revisão`,
          type:  'CONTENT_BLOG_READY',
          data:  { postId: post.id },
        }).catch(() => {});
      })
      .catch(e => console.error('[content] gerar-blog-rdi error:', e.message));
  } catch (err) {
    console.error('[content] gerar-blog-rdi error:', err);
    res.status(500).json({ error: 'Erro ao gerar blog' });
  }
});

// ── Public blog API (no auth required) ────────────────────────────────────────
function slugify(title) {
  return title
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80);
}

function serializePublicPost(p) {
  return {
    id:          p.id,
    title:       p.title,
    body:        p.body,
    slug:        slugify(p.title),
    publishedAt: p.publishedAt,
    mediaUrls:   p.mediaUrls,
    pillar:      p.pillar,
  };
}

// Public blog endpoints — mounted at /api/blog by server.js
// Routes: GET /api/blog/posts  and  GET /api/blog/posts/:id
router.get('/posts', async (req, res) => {
  try {
    const posts = await prisma.contentPost.findMany({
      where: { contentType: 'BLOG', stage: 'PUBLICADO', brand: 'RDI' },
      select: { id: true, title: true, body: true, publishedAt: true, mediaUrls: true, pillar: true },
      orderBy: { publishedAt: 'desc' },
    });
    res.json(posts.map(serializePublicPost));
  } catch (err) {
    console.error('[blog] GET /posts error:', err);
    res.status(500).json({ error: 'Erro ao carregar posts' });
  }
});

router.get('/posts/:id', async (req, res) => {
  try {
    const post = await prisma.contentPost.findUnique({
      where: { id: req.params.id },
      select: { id: true, title: true, body: true, publishedAt: true, mediaUrls: true, pillar: true, stage: true, contentType: true, brand: true },
    });
    if (!post || post.stage !== 'PUBLICADO' || post.contentType !== 'BLOG' || post.brand !== 'RDI') {
      return res.status(404).json({ error: 'Post não encontrado' });
    }
    res.json(serializePublicPost(post));
  } catch (err) {
    console.error('[blog] GET /posts/:id error:', err);
    res.status(500).json({ error: 'Erro ao carregar post' });
  }
});

module.exports = router;
