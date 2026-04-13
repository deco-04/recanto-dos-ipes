'use strict';

/**
 * Staff Portal API — endpoints for the "Central da Equipe" Next.js PWA
 * All routes require x-staff-id header (validated against StaffMember.id)
 * Mounted at: /api/staff
 */

const express = require('express');
const jwt = require('jsonwebtoken');
const { z } = require('zod');
const prisma = require('../lib/db');

const router = express.Router();

// ── Auth middleware ─────────────────────────────────────────────────────────
async function requireStaff(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Não autenticado' });

  let payload;
  try {
    payload = jwt.verify(auth.slice(7), process.env.STAFF_JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Token inválido ou expirado' });
  }

  const staff = await prisma.staffMember.findUnique({
    where: { id: payload.sub },
    select: { id: true, role: true, active: true },
  });
  if (!staff || !staff.active) return res.status(401).json({ error: 'Acesso negado' });

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

router.use(requireStaff);

// Helper: serialize booking for front-end consumption
function serializeBooking(b) {
  const sourceMap = { BOOKING_COM: 'BOOKING', AIRBNB: 'AIRBNB', DIRECT: 'DIRECT' };
  return {
    id: b.id,
    guestName: b.user?.name || b.guestName || 'Hóspede',
    checkIn: b.checkIn.toISOString(),
    checkOut: b.checkOut.toISOString(),
    guests: b.guestCount,
    totalPrice: parseFloat(b.totalAmount?.toString() || '0'),
    status: b.status,
    source: sourceMap[b.source] || 'DIRECT',
  };
}

// ── GET /api/staff/reservas ─────────────────────────────────────────────────
router.get('/reservas', requireRole('ADMIN'), async (req, res) => {
  try {
    const bookings = await prisma.booking.findMany({
      orderBy: { checkIn: 'desc' },
      take: 100,
      include: { user: { select: { name: true } } },
    });
    res.json(bookings.map(serializeBooking));
  } catch (err) {
    console.error('[staff-portal] reservas error:', err);
    res.status(500).json({ error: 'Erro ao buscar reservas' });
  }
});

// ── GET /api/staff/reservas/:id ─────────────────────────────────────────────
router.get('/reservas/:id', requireRole('ADMIN', 'GUARDIA'), async (req, res) => {
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: req.params.id },
      include: { user: { select: { name: true } } },
    });
    if (!booking) return res.status(404).json({ error: 'Reserva não encontrada' });
    res.json(serializeBooking(booking));
  } catch (err) {
    console.error('[staff-portal] reserva/:id error:', err);
    res.status(500).json({ error: 'Erro ao buscar reserva' });
  }
});

// ── GET /api/staff/financeiro ────────────────────────────────────────────────
router.get('/financeiro', requireRole('ADMIN'), async (req, res) => {
  try {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

    const bookings = await prisma.booking.findMany({
      where: {
        status: { in: ['CONFIRMED'] },
        checkIn: { gte: start, lte: end },
      },
    });

    const totalDias = end.getDate();
    const faturamentoTotal = bookings.reduce(
      (sum, b) => sum + parseFloat(b.totalAmount?.toString() || '0'),
      0
    );
    const qtdReservas = bookings.length;

    const diariamedia = qtdReservas > 0
      ? bookings.reduce((sum, b) => {
          const n = Math.round((new Date(b.checkOut) - new Date(b.checkIn)) / (1000 * 60 * 60 * 24));
          return sum + parseFloat(b.totalAmount?.toString() || '0') / Math.max(n, 1);
        }, 0) / qtdReservas
      : 0;

    const occupied = new Set();
    for (const b of bookings) {
      const cur = new Date(b.checkIn);
      while (cur < new Date(b.checkOut)) {
        if (cur >= start && cur <= end) occupied.add(cur.toISOString().split('T')[0]);
        cur.setDate(cur.getDate() + 1);
      }
    }
    const taxaOcupacao = (occupied.size / totalDias) * 100;
    const ticketMedio = qtdReservas > 0 ? faturamentoTotal / qtdReservas : 0;

    const sourceMap = {};
    const LABELS = { DIRECT: 'Direto', AIRBNB: 'Airbnb', BOOKING_COM: 'Booking.com' };
    for (const b of bookings) {
      const src = b.source || 'DIRECT';
      if (!sourceMap[src]) sourceMap[src] = { total: 0, qtd: 0 };
      sourceMap[src].total += parseFloat(b.totalAmount?.toString() || '0');
      sourceMap[src].qtd += 1;
    }
    const porOrigem = Object.entries(sourceMap).map(([origem, data]) => ({
      origem: LABELS[origem] || origem,
      total: data.total,
      qtd: data.qtd,
    }));

    const porMes = [];
    for (let i = 5; i >= 0; i--) {
      const ms = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const me = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59);
      const mBookings = await prisma.booking.findMany({
        where: { status: { in: ['CONFIRMED'] }, checkIn: { gte: ms, lte: me } },
        select: { totalAmount: true },
      });
      const total = mBookings.reduce((s, b) => s + parseFloat(b.totalAmount?.toString() || '0'), 0);
      porMes.push({ mes: ms.toLocaleDateString('pt-BR', { month: 'short' }), total });
    }

    res.json({
      periodo: start.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' }),
      faturamentoTotal,
      variacaoPct: null,
      qtdReservas,
      diariamedia,
      taxaOcupacao,
      ticketMedio,
      porOrigem,
      porMes,
    });
  } catch (err) {
    console.error('[staff-portal] financeiro error:', err);
    res.status(500).json({ error: 'Erro ao buscar dados financeiros' });
  }
});

// ── GET /api/staff/casa/proximas ─────────────────────────────────────────────
router.get('/casa/proximas', async (req, res) => {
  try {
    const start = new Date();
    const end = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

    const bookings = await prisma.booking.findMany({
      where: { status: { in: ['CONFIRMED', 'PENDING'] }, checkIn: { gte: start, lte: end } },
      orderBy: { checkIn: 'asc' },
      include: {
        user: { select: { name: true } },
        inspections: { where: { type: 'PRE_CHECKIN' }, select: { id: true, status: true } },
      },
    });

    res.json(bookings.map((b) => ({
      bookingId: b.id,
      guestName: b.user?.name || b.guestName || 'Hóspede',
      checkIn: b.checkIn.toISOString(),
      checkOut: b.checkOut.toISOString(),
      guests: b.guestCount,
      inspectionId: b.inspections?.[0]?.id || null,
      inspectionStatus: b.inspections?.[0]?.status || null,
    })));
  } catch (err) {
    console.error('[staff-portal] casa/proximas error:', err);
    res.status(500).json({ error: 'Erro ao buscar próximas entradas' });
  }
});

// ── GET /api/staff/casa/calendario ──────────────────────────────────────────
router.get('/casa/calendario', async (req, res) => {
  try {
    const past = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const future = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);

    const bookings = await prisma.booking.findMany({
      where: {
        status: { in: ['CONFIRMED', 'PENDING'] },
        checkIn: { gte: past },
        checkOut: { lte: future },
      },
      orderBy: { checkIn: 'asc' },
      include: {
        user: { select: { name: true } },
        inspections: { select: { id: true, type: true } },
      },
    });

    res.json(bookings.map((b) => {
      const pre = b.inspections?.find((i) => i.type === 'PRE_CHECKIN');
      const chk = b.inspections?.find((i) => i.type === 'CHECKOUT');
      return {
        id: b.id,
        guestName: b.user?.name || b.guestName || 'Hóspede',
        checkIn: b.checkIn.toISOString(),
        checkOut: b.checkOut.toISOString(),
        guests: b.guestCount,
        status: b.status,
        inspectionPreCheckin: pre?.id || null,
        inspectionCheckout: chk?.id || null,
      };
    }));
  } catch (err) {
    console.error('[staff-portal] casa/calendario error:', err);
    res.status(500).json({ error: 'Erro ao buscar calendário' });
  }
});

// ── POST /api/staff/vistorias ────────────────────────────────────────────────
router.post('/vistorias', async (req, res) => {
  const schema = z.object({
    bookingId: z.string(),
    tipo: z.enum(['PRE_CHECKIN', 'CHECKOUT']),
    cabinId: z.string().optional(),
    checklist: z.array(z.object({
      label: z.string(),
      status: z.enum(['OK', 'PENDENTE', 'PROBLEMA', 'NAO_VERIFICADO']),
      observacao: z.string(),
    })),
    photos: z.array(z.object({ publicId: z.string(), url: z.string() })).optional().default([]),
    videoId: z.string().optional(),
    observacaoGeral: z.string().optional().default(''),
    assinaturaDataUrl: z.string().nullable().optional(),
    timestamp: z.string(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Dados inválidos' });

  const { bookingId, tipo, cabinId, checklist, photos, videoId, observacaoGeral, assinaturaDataUrl, timestamp } = parsed.data;

  try {
    const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
    if (!booking) return res.status(404).json({ error: 'Reserva não encontrada' });

    const existing = await prisma.inspectionReport.findFirst({
      where: { bookingId, type: tipo },
    });
    if (existing) return res.status(409).json({ error: 'Vistoria já registrada para esta reserva' });

    const property = await prisma.property.findFirst({ where: { active: true } });
    if (!property) return res.status(500).json({ error: 'Nenhuma propriedade ativa configurada' });

    // Save signature as a file instead of storing base64 in the DB
    let signatureUrl = null;
    if (assinaturaDataUrl) {
      try {
        const PNG_PREFIX = 'data:image/png;base64,';
        if (!assinaturaDataUrl.startsWith(PNG_PREFIX)) throw new Error('Invalid signature format');
        const base64Data = assinaturaDataUrl.slice(PNG_PREFIX.length);
        // Decoded size guard: base64 is ~4/3 raw bytes; 200 KB decoded ≈ 267 KB base64
        if (base64Data.length > 270_000) throw new Error('Signature too large');
        const sigBuffer = Buffer.from(base64Data, 'base64');
        const { saveFile } = require('../lib/storage');
        const sigPath = `signatures/${property.slug}/${bookingId}-${tipo.toLowerCase()}.png`;
        const result = await saveFile(sigBuffer, sigPath);
        signatureUrl = result.url;
      } catch (sigErr) {
        console.error('[staff-portal] signature save error (non-fatal):', sigErr.message);
        // Fall through — report is still saved, signature just won't be stored
      }
    }

    const report = await prisma.inspectionReport.create({
      data: {
        bookingId,
        propertyId: property.id,
        staffId: req.staff.id,
        type: tipo,
        status: 'SUBMITTED',
        signatureDataUrl: null,          // deprecated — no longer storing base64
        signatureUrl: signatureUrl,
        submittedAt: new Date(timestamp),
        notes: observacaoGeral || null,
        items: {
          create: checklist.map((item) => ({
            category: 'Checklist',
            description: item.label,
            status: item.status === 'PENDENTE' ? 'NAO_VERIFICADO' : item.status,
            problemDescription: item.observacao || null,
          })),
        },
        photos: {
          create: photos.map((p) => ({
            cloudinaryPublicId: p.publicId,
            cloudinaryUrl: p.url,
          })),
        },
        ...(videoId ? {
          videos: {
            create: [{
              storagePath: videoId,
              storageUrl: `${process.env.UPLOAD_PUBLIC_URL || 'http://localhost:3000'}/uploads/${videoId}`,
            }],
          },
        } : {}),
      },
    });

    // Auto-create ServiceTicket for any PROBLEMA items
    const problemas = checklist.filter(
      (i) => i.status === 'PROBLEMA' && i.observacao?.trim()
    );
    if (problemas.length > 0) {
      try {
        const tipoLabel = tipo === 'PRE_CHECKIN' ? 'Pré Check-in' : 'Checkout';
        await prisma.serviceTicket.create({
          data: {
            propertyId: property.id,
            openedById: req.staff.id,
            title: `Vistoria ${tipoLabel} — ${problemas.length} problema${problemas.length > 1 ? 's' : ''}`,
            description: problemas.map((i) => `• ${i.label}: ${i.observacao}`).join('\n'),
            photoUrls: [],
            priority: 'ALTA',
            status: 'ABERTO',
          },
        });
      } catch (ticketErr) {
        // Non-fatal — vistoria was saved successfully
        console.error('[staff-portal] auto-ticket error (non-fatal):', ticketErr);
      }
    }

    // CHECKOUT — send detailed alert email to admin with AI solutions + guest message draft
    if (tipo === 'CHECKOUT' && problemas.length > 0) {
      try {
        const { sendCheckoutProblemaAlert } = require('../lib/mailer');
        const staffMember = await prisma.staffMember.findUnique({
          where:  { id: req.staff.id },
          select: { name: true },
        });
        await sendCheckoutProblemaAlert({
          booking,
          staffName: staffMember?.name || 'Equipe',
          problemas,
          reportId: report.id,
          propertySlug: property.slug,
        });
      } catch (emailErr) {
        // Non-fatal — vistoria was saved successfully
        console.error('[staff-portal] checkout alert email error (non-fatal):', emailErr.message);
      }
    }

    res.json({ id: report.id, ok: true });
  } catch (err) {
    console.error('[staff-portal] vistorias POST error:', err);
    res.status(500).json({ error: 'Erro ao salvar vistoria' });
  }
});

// ── GET /api/staff/vistorias/:id ─────────────────────────────────────────────
router.get('/vistorias/:id', async (req, res) => {
  try {
    const report = await prisma.inspectionReport.findUnique({
      where: { id: req.params.id },
      include: {
        staff: { select: { name: true } },
        booking: { include: { user: { select: { name: true } } } },
        items: true,
        photos: true,
      },
    });
    if (!report) return res.status(404).json({ error: 'Vistoria não encontrada' });

    res.json({
      id: report.id,
      tipo: report.type,
      status: report.status,
      submittedAt: report.submittedAt?.toISOString() || report.createdAt.toISOString(),
      staffName: report.staff?.name || 'Equipe',
      guestName: report.booking?.user?.name || report.booking?.guestName || 'Hóspede',
      observacaoGeral: report.notes || '',
      checklist: report.items.map((i) => ({
        label: i.description,
        status: i.status === 'NAO_VERIFICADO' ? 'PENDENTE' : i.status,
        observacao: i.problemDescription || '',
      })),
      photos: report.photos.map((p) => ({ url: p.cloudinaryUrl })),
    });
  } catch (err) {
    console.error('[staff-portal] vistorias/:id error:', err);
    res.status(500).json({ error: 'Erro ao buscar vistoria' });
  }
});

// ── GET /api/staff/vistorias/:id/pdf ─────────────────────────────────────────
router.get('/vistorias/:id/pdf', async (req, res) => {
  try {
    const report = await prisma.inspectionReport.findUnique({
      where: { id: req.params.id },
      include: {
        staff: { select: { name: true } },
        booking: { select: { guestName: true, checkIn: true, checkOut: true } },
        property: { select: { name: true } },
        items: true,
        photos: true,
        videos: true,
      },
    });
    if (!report) return res.status(404).json({ error: 'Vistoria não encontrada' });

    // Lazy-load pdfkit to avoid startup cost when not needed
    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument({ margin: 40, size: 'A4' });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="vistoria-${report.id.slice(0, 8)}.pdf"`
    );
    doc.pipe(res);

    const tipoLabel = report.type === 'PRE_CHECKIN' ? 'Pré Check-in' : 'Checkout';
    const dateStr = report.submittedAt
      ? new Date(report.submittedAt).toLocaleDateString('pt-BR', { dateStyle: 'full' })
      : new Date(report.createdAt).toLocaleDateString('pt-BR', { dateStyle: 'full' });

    // Header
    doc.fontSize(18).font('Helvetica-Bold').text('Relatório de Vistoria', { align: 'center' });
    doc.fontSize(12).font('Helvetica').text(`${tipoLabel} — ${dateStr}`, { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(10).text(`Propriedade: ${report.property?.name || 'Recantos da Serra'}`);
    doc.text(`Responsável: ${report.staff?.name || 'Equipe'}`);
    doc.text(`Hóspede: ${report.booking?.guestName || 'Não informado'}`);
    doc.moveDown();

    // Checklist
    doc.fontSize(13).font('Helvetica-Bold').text('Checklist');
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(10);

    for (const item of report.items) {
      const statusLabel = item.status === 'OK' ? '✓ OK'
        : item.status === 'PROBLEMA' ? '⚠ Problema'
        : '— Pendente';
      doc.text(`${statusLabel}  ${item.description}`, { continued: false });
      if (item.problemDescription) {
        doc.fillColor('#c45c2e').text(`   Obs: ${item.problemDescription}`).fillColor('black');
      }
    }

    // Notes
    if (report.notes) {
      doc.moveDown();
      doc.fontSize(13).font('Helvetica-Bold').text('Observações Gerais');
      doc.font('Helvetica').fontSize(10).text(report.notes);
    }

    // Photos section header
    if (report.photos.length > 0) {
      doc.moveDown();
      doc.fontSize(13).font('Helvetica-Bold').text(`Fotos (${report.photos.length})`);
      doc.font('Helvetica').fontSize(9).fillColor('#888')
        .text('Imagens registradas durante a vistoria.')
        .fillColor('black');
    }

    // Video note
    if (report.videos && report.videos.length > 0) {
      doc.moveDown();
      doc.fontSize(10).font('Helvetica')
        .text(`Vídeo anexado: ${report.videos[0].storageUrl}`);
    }

    // Signature
    doc.moveDown();
    if (report.signatureUrl) {
      doc.fontSize(13).font('Helvetica-Bold').text('Assinatura');
      // Note: embedding remote image URLs in pdfkit requires fetching first
      // For now, include the URL as a reference
      doc.font('Helvetica').fontSize(9).fillColor('#888')
        .text(`(Assinatura registrada em: ${report.signatureUrl})`)
        .fillColor('black');
    }

    // Footer
    doc.moveDown(2);
    doc.fontSize(8).fillColor('#aaa')
      .text(`Gerado em ${new Date().toLocaleString('pt-BR')} — ID: ${report.id}`, { align: 'center' });

    doc.end();
  } catch (err) {
    console.error('[staff-portal] vistoria PDF error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Erro ao gerar PDF' });
  }
});

// ── GET /api/staff/piscina/proximas ──────────────────────────────────────────
router.get('/piscina/proximas', async (req, res) => {
  try {
    const start = new Date();
    const end = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

    const bookings = await prisma.booking.findMany({
      where: { status: { in: ['CONFIRMED', 'PENDING'] }, checkIn: { gte: start, lte: end } },
      orderBy: { checkIn: 'asc' },
      include: {
        user: { select: { name: true } },
        maintenanceLogs: {
          where: { logType: 'PRE_CHECKIN' },
          select: { id: true },
          take: 1,
        },
      },
    });

    res.json(bookings.map((b) => ({
      bookingId: b.id,
      guestName: b.user?.name || b.guestName || 'Hóspede',
      checkIn: b.checkIn.toISOString(),
      guests: b.guestCount,
      logId: b.maintenanceLogs?.[0]?.id || null,
    })));
  } catch (err) {
    console.error('[staff-portal] piscina/proximas error:', err);
    res.status(500).json({ error: 'Erro ao buscar próximas visitas' });
  }
});

// ── POST /api/staff/piscina/manutencao ──────────────────────────────────────
router.post('/piscina/manutencao', async (req, res) => {
  const schema = z.object({
    bookingId: z.string().optional(),
    checklist: z.array(z.object({
      label: z.string(),
      value: z.string(),
      ok: z.boolean().nullable(),
    })),
    observacoes: z.string().optional().default(''),
    timestamp: z.string(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Dados inválidos' });

  const { bookingId, checklist, observacoes, timestamp } = parsed.data;

  try {
    const property = await prisma.property.findFirst({ where: { active: true } });
    if (!property) return res.status(500).json({ error: 'Nenhuma propriedade ativa' });

    // Derive boolean fields from checklist for backward compatibility
    const getOk = (id) => checklist.find((i) => i.label.toLowerCase().includes(id))?.ok ?? false;

    const log = await prisma.maintenanceLog.create({
      data: {
        propertyId: property.id,
        staffId: req.staff.id,
        bookingId: bookingId || null,
        logType: bookingId ? 'PRE_CHECKIN' : 'ROUTINE',
        visitDate: new Date(timestamp),
        vacuumed: getOk('fundo') || getOk('aspira'),
        borderCleaned: getOk('parede') || getOk('borda'),
        filterCleaned: getOk('filtro') || getOk('skimmer'),
        waterTreated: getOk('quim') || getOk('trat'),
        checklistJson: checklist,
        notes: observacoes || null,
      },
    });

    res.json({ id: log.id, ok: true });
  } catch (err) {
    console.error('[staff-portal] piscina/manutencao error:', err);
    res.status(500).json({ error: 'Erro ao salvar manutenção' });
  }
});

// ── POST /api/staff/chamados ─────────────────────────────────────────────────
router.post('/chamados', async (req, res) => {
  const schema = z.object({
    titulo: z.string().min(5),
    descricao: z.string().min(10),
    prioridade: z.enum(['BAIXA', 'NORMAL', 'ALTA', 'URGENTE']),
    timestamp: z.string(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Dados inválidos' });

  const { titulo, descricao, prioridade, timestamp } = parsed.data;

  try {
    const property = await prisma.property.findFirst({ where: { active: true } });
    if (!property) return res.status(500).json({ error: 'Nenhuma propriedade ativa' });

    const ticket = await prisma.serviceTicket.create({
      data: {
        propertyId: property.id,
        openedById: req.staff.id,
        title: titulo,
        description: descricao,
        priority: prioridade,
        status: 'ABERTO',
        createdAt: new Date(timestamp),
      },
    });

    res.json({ id: ticket.id, ok: true });
  } catch (err) {
    console.error('[staff-portal] chamados error:', err);
    res.status(500).json({ error: 'Erro ao abrir chamado' });
  }
});

// ── GET /api/staff/push/vapid-key ─────────────────────────────────────────────
// Returns the VAPID public key so the PWA can create a PushSubscription.
router.get('/push/vapid-key', (_req, res) => {
  const key = process.env.VAPID_PUBLIC_KEY;
  if (!key) {
    return res.status(503).json({ error: 'Push notifications not configured' });
  }
  res.json({ publicKey: key });
});

// ── POST /api/staff/push/subscribe ────────────────────────────────────────────
// Body: { subscription: { endpoint, keys: { p256dh, auth } } }
router.post('/push/subscribe', async (req, res) => {
  try {
    const { subscription } = req.body;

    if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
      return res.status(400).json({ error: 'Invalid subscription object' });
    }

    await prisma.staffMember.update({
      where: { id: req.staff.id },
      data:  { pushSubscription: subscription },
    });

    res.json({ success: true });
  } catch (err) {
    console.error('[push] subscribe error:', err.message);
    res.status(500).json({ error: 'Erro ao salvar subscription' });
  }
});

// ── DELETE /api/staff/push/subscribe ─────────────────────────────────────────
router.delete('/push/subscribe', async (req, res) => {
  try {
    await prisma.staffMember.update({
      where: { id: req.staff.id },
      data:  { pushSubscription: null },
    });
    res.json({ success: true });
  } catch (err) {
    console.error('[push] unsubscribe error:', err.message);
    res.status(500).json({ error: 'Erro ao remover subscription' });
  }
});

// ── GET /api/staff/notificacoes ───────────────────────────────────────────────
router.get('/notificacoes', async (req, res) => {
  try {
    const notifications = await prisma.pushNotification.findMany({
      where: { staffId: req.staff.id },
      orderBy: { sentAt: 'desc' },
      take: 50,
    });
    res.json(notifications);
  } catch (err) {
    console.error('[staff] notificacoes error:', err.message);
    res.status(500).json({ error: 'Erro ao buscar notificações' });
  }
});

// ── PATCH /api/staff/notificacoes/:id/read ────────────────────────────────────
router.patch('/notificacoes/:id/read', async (req, res) => {
  try {
    const notification = await prisma.pushNotification.findUnique({
      where: { id: req.params.id },
    });
    if (!notification) return res.status(404).json({ error: 'Notificação não encontrada' });
    if (notification.staffId !== req.staff.id) return res.status(403).json({ error: 'Acesso negado' });

    const updated = await prisma.pushNotification.update({
      where: { id: req.params.id },
      data: { read: true },
    });
    res.json(updated);
  } catch (err) {
    console.error('[staff] notificacoes read error:', err.message);
    res.status(500).json({ error: 'Erro ao marcar notificação' });
  }
});

// ── GET /api/staff/piscina/programacao ───────────────────────────────────────
router.get('/piscina/programacao', requireRole('ADMIN', 'PISCINEIRO'), async (_req, res) => {
  try {
    const schedules = await prisma.maintenanceSchedule.findMany({
      orderBy: { nextDueAt: 'asc' },
    });
    res.json(schedules);
  } catch (err) {
    console.error('[staff] piscina/programacao error:', err.message);
    res.status(500).json({ error: 'Erro ao buscar programação' });
  }
});

module.exports = router;
