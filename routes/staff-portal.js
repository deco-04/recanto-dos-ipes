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

// GET /api/staff/me — returns full staff profile (used by WebAuthn + token exchange)
router.get('/me', async (req, res) => {
  try {
    const staff = await prisma.staffMember.findUnique({
      where:  { id: req.staff.id },
      select: {
        id: true, name: true, email: true, phone: true,
        role: true, fontSizePreference: true, firstLoginDone: true,
        properties: { select: { property: { select: { id: true, name: true, slug: true } } } },
      },
    });
    if (!staff) return res.status(404).json({ error: 'Não encontrado' });
    res.json({
      id:                 staff.id,
      name:               staff.name,
      email:              staff.email,
      phone:              staff.phone,
      role:               staff.role,
      fontSizePreference: staff.fontSizePreference,
      firstLoginDone:     staff.firstLoginDone,
      properties:         staff.properties.map(p => p.property),
    });
  } catch (err) {
    console.error('[staff-portal] GET /me error:', err);
    res.status(500).json({ error: 'Erro ao buscar perfil' });
  }
});

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
        videos: true,
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
      signatureUrl: report.signatureUrl || null,
      checklist: report.items.map((i) => ({
        label: i.description,
        status: i.status === 'NAO_VERIFICADO' ? 'PENDENTE' : i.status,
        observacao: i.problemDescription || '',
      })),
      photos: report.photos
        .map((p) => ({ url: p.thumbnailUrl || p.cloudinaryUrl }))
        .filter((p) => p.url),
      video: report.videos[0]
        ? { url: report.videos[0].storageUrl }
        : null,
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
        property: { select: { name: true, slug: true } },
        items: true,
        photos: true,
        videos: true,
      },
    });
    if (!report) return res.status(404).json({ error: 'Vistoria não encontrada' });

    // Helper: resolve a storage URL to a Buffer for PDF embedding.
    // Prefers the thumbnail for photos (smaller, sufficient for PDF grid).
    async function resolveBuffer(storageUrl) {
      if (!storageUrl) return null;
      const { UPLOAD_DIR } = require('../lib/storage');
      const publicBase = process.env.UPLOAD_PUBLIC_URL || 'http://localhost:3000';

      if (process.env.STORAGE_PROVIDER === 'r2') {
        try {
          const res2 = await fetch(storageUrl, { signal: AbortSignal.timeout(5000) });
          if (!res2.ok) return null;
          return Buffer.from(await res2.arrayBuffer());
        } catch { return null; }
      }

      // Local storage — derive fs path from URL
      try {
        const relPath = storageUrl.startsWith(publicBase)
          ? storageUrl.slice(publicBase.length).replace(/^\/uploads\//, '')
          : storageUrl.replace(/^\/uploads\//, '');
        const fullPath = require('path').join(UPLOAD_DIR, relPath);
        return await require('fs').promises.readFile(fullPath);
      } catch { return null; }
    }

    // Lazy-load pdfkit to avoid startup cost when not needed
    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument({ margin: 45, size: 'A4', autoFirstPage: true });

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
    const pageW = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    // ── Header ────────────────────────────────────────────────────────────────
    doc.rect(0, 0, doc.page.width, 80).fill('#3D2B1A');
    doc.fillColor('white')
      .fontSize(16).font('Helvetica-Bold')
      .text('Relatório de Vistoria', doc.page.margins.left, 18, { width: pageW, align: 'center' });
    doc.fontSize(10).font('Helvetica')
      .text(`${tipoLabel} — ${dateStr}`, doc.page.margins.left, 42, { width: pageW, align: 'center' });
    doc.fillColor('black');
    doc.y = 100;

    // ── Meta ─────────────────────────────────────────────────────────────────
    doc.fontSize(10).font('Helvetica');
    doc.text(`Propriedade: ${report.property?.name || 'Recantos da Serra'}`);
    doc.text(`Responsável: ${report.staff?.name || 'Equipe'}`);
    doc.text(`Hóspede: ${report.booking?.guestName || 'Não informado'}`);
    doc.moveDown(0.5);
    doc.moveTo(doc.page.margins.left, doc.y)
      .lineTo(doc.page.margins.left + pageW, doc.y)
      .strokeColor('#e7e5e4').stroke();
    doc.moveDown(0.5);

    // ── Checklist ────────────────────────────────────────────────────────────
    doc.fontSize(12).font('Helvetica-Bold').fillColor('#3D2B1A').text('Checklist');
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(9).fillColor('black');

    for (const item of report.items) {
      const isProblema = item.status === 'PROBLEMA';
      const statusLabel = item.status === 'OK' ? '✓ OK'
        : item.status === 'PROBLEMA' ? '⚠ Problema'
        : '– Pendente';
      doc.fillColor(isProblema ? '#b91c1c' : item.status === 'OK' ? '#15803d' : '#78716c');
      doc.text(statusLabel, { continued: true, width: 70 });
      doc.fillColor('black').text(`  ${item.description}`);
      if (item.problemDescription) {
        doc.fillColor('#c45c2e').text(`    ↳ ${item.problemDescription}`).fillColor('black');
      }
    }

    // ── Notes ────────────────────────────────────────────────────────────────
    if (report.notes) {
      doc.moveDown(0.5);
      doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.margins.left + pageW, doc.y)
        .strokeColor('#e7e5e4').stroke();
      doc.moveDown(0.5);
      doc.fontSize(12).font('Helvetica-Bold').fillColor('#3D2B1A').text('Observações Gerais');
      doc.font('Helvetica').fontSize(9).fillColor('black').text(report.notes);
    }

    // ── Video note ────────────────────────────────────────────────────────────
    if (report.videos && report.videos.length > 0) {
      doc.moveDown(0.5);
      doc.fontSize(9).font('Helvetica').fillColor('#57534e')
        .text(`🎥  Vídeo anexado ao relatório — acesse pelo aplicativo para visualizar.`)
        .fillColor('black');
    }

    // ── Photos ────────────────────────────────────────────────────────────────
    if (report.photos.length > 0) {
      doc.addPage();
      doc.fontSize(12).font('Helvetica-Bold').fillColor('#3D2B1A')
        .text(`Fotos (${report.photos.length})`);
      doc.moveDown(0.4);
      doc.fillColor('black');

      const cols   = 2;
      const gap    = 10;
      const imgW   = (pageW - gap) / cols;
      const imgH   = Math.round(imgW * 0.70); // ~4:3 aspect
      const marginL = doc.page.margins.left;

      let col = 0;
      let rowY = doc.y;

      for (const photo of report.photos) {
        // Use thumbnail if available (smaller/faster), fall back to original
        const src = photo.thumbnailUrl || photo.cloudinaryUrl;
        const buf = await resolveBuffer(src);

        // Add a new page when row would overflow
        if (rowY + imgH > doc.page.height - doc.page.margins.bottom - 20) {
          doc.addPage();
          rowY = doc.page.margins.top;
          col  = 0;
        }

        const x = marginL + col * (imgW + gap);
        if (buf) {
          try {
            doc.image(buf, x, rowY, { width: imgW, height: imgH, cover: [imgW, imgH], align: 'center', valign: 'center' });
          } catch {
            // Unsupported format — draw placeholder box
            doc.rect(x, rowY, imgW, imgH).strokeColor('#d6d3d1').lineWidth(1).stroke();
            doc.fontSize(7).fillColor('#a8a29e')
              .text('(imagem indisponível)', x + 5, rowY + imgH / 2 - 5, { width: imgW - 10, align: 'center' })
              .fillColor('black');
          }
        } else {
          doc.rect(x, rowY, imgW, imgH).strokeColor('#d6d3d1').lineWidth(1).stroke();
        }

        col++;
        if (col >= cols) {
          col  = 0;
          rowY += imgH + gap;
        }
      }

      // Advance cursor past last row
      doc.y = rowY + imgH + gap;
    }

    // ── Signature ────────────────────────────────────────────────────────────
    if (report.signatureUrl) {
      doc.moveDown(0.5);
      doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.margins.left + pageW, doc.y)
        .strokeColor('#e7e5e4').stroke();
      doc.moveDown(0.5);
      doc.fontSize(12).font('Helvetica-Bold').fillColor('#3D2B1A').text('Assinatura');
      doc.moveDown(0.3);

      const sigBuf = await resolveBuffer(report.signatureUrl);
      if (sigBuf) {
        try {
          doc.image(sigBuf, doc.page.margins.left, doc.y, { height: 60, fit: [200, 60] });
          doc.y += 70;
        } catch {
          doc.fontSize(8).fillColor('#a8a29e').text('(assinatura indisponível)').fillColor('black');
        }
      } else {
        doc.fontSize(8).fillColor('#a8a29e').text('(assinatura indisponível)').fillColor('black');
      }
    }

    // ── Footer ────────────────────────────────────────────────────────────────
    doc.moveDown(1.5);
    doc.fontSize(7).fillColor('#a8a29e')
      .text(`Gerado em ${new Date().toLocaleString('pt-BR')} · ID ${report.id}`, { align: 'center' });

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

// ── GET /api/staff/chamados ──────────────────────────────────────────────────
// Returns open/in-progress service tickets for the active property.
router.get('/chamados', async (req, res) => {
  try {
    const property = await prisma.property.findFirst({ where: { active: true } });
    if (!property) return res.status(500).json({ error: 'Propriedade não encontrada' });

    const tickets = await prisma.serviceTicket.findMany({
      where: {
        propertyId: property.id,
        status: { in: ['ABERTO', 'EM_ANDAMENTO'] },
      },
      include: {
        openedBy: { select: { id: true, name: true } },
      },
      orderBy: [{ createdAt: 'desc' }],
      take: 50,
    });
    res.json(tickets);
  } catch (err) {
    console.error('[staff-portal] GET /chamados error:', err);
    res.status(500).json({ error: 'Erro ao buscar chamados' });
  }
});

// ── PATCH /api/staff/chamados/:id ─────────────────────────────────────────────
// Updates ticket status. ADMIN and GUARDIA only.
router.patch('/chamados/:id', requireRole('ADMIN', 'GUARDIA'), async (req, res) => {
  const { status } = req.body;
  const valid = ['ABERTO', 'EM_ANDAMENTO', 'RESOLVIDO', 'FECHADO'];
  if (!status || !valid.includes(status)) {
    return res.status(400).json({ error: 'Status inválido' });
  }
  try {
    const ticket = await prisma.serviceTicket.update({
      where: { id: req.params.id },
      data: { status },
    });
    res.json(ticket);
  } catch {
    res.status(500).json({ error: 'Erro ao atualizar chamado' });
  }
});

// ── GET /api/staff/tarefas ───────────────────────────────────────────────────
// Returns tasks assigned to the requesting staff member.
router.get('/tarefas', async (req, res) => {
  try {
    const tasks = await prisma.staffTask.findMany({
      where: { assignedToId: req.staff.id },
      orderBy: [{ status: 'asc' }, { dueDate: 'asc' }, { createdAt: 'desc' }],
    });
    res.json(tasks);
  } catch (err) {
    console.error('[staff-portal] GET /tarefas error:', err);
    res.status(500).json({ error: 'Erro ao buscar tarefas' });
  }
});

// ── Guest Messages ────────────────────────────────────────────────────────────

// GET /api/staff/reservas/:id/mensagens — all messages for a booking (all roles)
router.get('/reservas/:id/mensagens', async (req, res) => {
  try {
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!booking) return res.status(404).json({ error: 'Reserva não encontrada' });

    const messages = await prisma.guestMessage.findMany({
      where: { bookingId: req.params.id },
      include: { staff: { select: { id: true, name: true } } },
      orderBy: { sentAt: 'asc' },
    });
    res.json(messages);
  } catch (err) {
    console.error('[staff-portal] GET /reservas/:id/mensagens error:', err);
    res.status(500).json({ error: 'Erro ao buscar mensagens' });
  }
});

// POST /api/staff/reservas/:id/mensagens — send a message (ADMIN + GUARDIA only)
router.post('/reservas/:id/mensagens', requireRole('ADMIN', 'GUARDIA'), async (req, res) => {
  try {
    const { body, channel = 'MANUAL', direction = 'OUTBOUND' } = req.body;
    if (!body?.trim()) return res.status(400).json({ error: 'Mensagem não pode ser vazia' });

    const booking = await prisma.booking.findUnique({
      where: { id: req.params.id },
      select: { id: true, guestName: true, guestPhone: true },
    });
    if (!booking) return res.status(404).json({ error: 'Reserva não encontrada' });

    const message = await prisma.guestMessage.create({
      data: {
        bookingId: req.params.id,
        staffId: req.staff.id,
        direction,
        channel,
        body: body.trim(),
      },
      include: { staff: { select: { id: true, name: true } } },
    });

    // TODO: wire GHL webhook when phone number and integration are configured
    // if (channel === 'WHATSAPP' && process.env.GHL_WEBHOOK_URL && booking.guestPhone) {
    //   await fetch(process.env.GHL_WEBHOOK_URL, {
    //     method: 'POST',
    //     headers: { 'Content-Type': 'application/json' },
    //     body: JSON.stringify({
    //       bookingId: booking.id,
    //       guestPhone: booking.guestPhone,
    //       message: body.trim(),
    //       staffName: req.staff.name,
    //     }),
    //   }).catch(err => console.error('[GHL webhook] error:', err));
    // }

    res.status(201).json(message);
  } catch (err) {
    console.error('[staff-portal] POST /reservas/:id/mensagens error:', err);
    res.status(500).json({ error: 'Erro ao enviar mensagem' });
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

// ── Inventário (AmenitiesItem) ────────────────────────────────────────────────

// GET /api/staff/propriedade — active property type + cabin list (for form context)
router.get('/propriedade', async (_req, res) => {
  try {
    const property = await prisma.property.findFirst({
      where:  { active: true },
      select: { id: true, name: true, type: true, cabins: { where: { active: true }, select: { id: true, name: true, slug: true }, orderBy: { name: 'asc' } } },
    });
    if (!property) return res.status(404).json({ error: 'Propriedade não encontrada' });
    res.json(property);
  } catch (err) {
    console.error('[staff-portal] GET /propriedade error:', err);
    res.status(500).json({ error: 'Erro ao buscar propriedade' });
  }
});

router.get('/inventario', async (req, res) => {
  try {
    const property = await prisma.property.findFirst({ where: { active: true }, select: { id: true } });
    if (!property) return res.json([]);
    const items = await prisma.amenitiesItem.findMany({
      where:   { propertyId: property.id },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
    });
    res.json(items);
  } catch (err) {
    console.error('[staff] inventario GET error:', err);
    res.status(500).json({ error: 'Erro ao buscar inventário' });
  }
});

router.post('/inventario', requireRole('ADMIN'), async (req, res) => {
  const schema = z.object({
    category:    z.string().min(1).max(60),
    name:        z.string().min(1).max(100),
    quantity:    z.number().int().min(0).default(1),
    minQuantity: z.number().int().min(0).default(1),
    unit:        z.string().min(1).max(20).default('un'),
    notes:       z.string().max(300).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Dados inválidos' });

  try {
    const property = await prisma.property.findFirst({ where: { active: true }, select: { id: true } });
    if (!property) return res.status(404).json({ error: 'Nenhuma propriedade ativa' });
    const item = await prisma.amenitiesItem.create({
      data: { ...parsed.data, propertyId: property.id },
    });
    res.json(item);
  } catch (err) {
    console.error('[staff] inventario POST error:', err);
    res.status(500).json({ error: 'Erro ao criar item' });
  }
});

router.patch('/inventario/:id', requireRole('ADMIN', 'GUARDIA'), async (req, res) => {
  const schema = z.object({
    quantity:     z.number().int().min(0).optional(),
    minQuantity:  z.number().int().min(0).optional(),
    name:         z.string().min(1).max(100).optional(),
    category:     z.string().min(1).max(60).optional(),
    unit:         z.string().min(1).max(20).optional(),
    notes:        z.string().max(300).nullable().optional(),
    lastChecked:  z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Dados inválidos' });

  try {
    const item = await prisma.amenitiesItem.update({
      where: { id: req.params.id },
      data:  {
        ...parsed.data,
        ...(parsed.data.lastChecked ? { lastChecked: new Date(parsed.data.lastChecked) } : {}),
        updatedAt: new Date(),
      },
    });
    res.json(item);
  } catch (err) {
    console.error('[staff] inventario PATCH error:', err);
    res.status(500).json({ error: 'Erro ao atualizar item' });
  }
});

router.delete('/inventario/:id', requireRole('ADMIN'), async (req, res) => {
  try {
    await prisma.amenitiesItem.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) {
    console.error('[staff] inventario DELETE error:', err);
    res.status(500).json({ error: 'Erro ao deletar item' });
  }
});

// ── Fornecedores ──────────────────────────────────────────────────────────────

router.get('/fornecedores', async (_req, res) => {
  try {
    const items = await prisma.fornecedor.findMany({
      where:   { active: true },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
    });
    res.json(items);
  } catch (err) {
    console.error('[staff] fornecedores GET error:', err);
    res.status(500).json({ error: 'Erro ao buscar fornecedores' });
  }
});

router.post('/fornecedores', requireRole('ADMIN'), async (req, res) => {
  const schema = z.object({
    name:     z.string().min(1).max(100),
    category: z.string().min(1).max(60),
    phone:    z.string().max(20).optional(),
    email:    z.string().email().optional().or(z.literal('')),
    notes:    z.string().max(500).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Dados inválidos' });

  try {
    const item = await prisma.fornecedor.create({ data: parsed.data });
    res.json(item);
  } catch (err) {
    console.error('[staff] fornecedores POST error:', err);
    res.status(500).json({ error: 'Erro ao criar fornecedor' });
  }
});

router.patch('/fornecedores/:id', requireRole('ADMIN'), async (req, res) => {
  const schema = z.object({
    name:     z.string().min(1).max(100).optional(),
    category: z.string().min(1).max(60).optional(),
    phone:    z.string().max(20).nullable().optional(),
    email:    z.string().email().nullable().optional().or(z.literal('')),
    notes:    z.string().max(500).nullable().optional(),
    active:   z.boolean().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Dados inválidos' });

  try {
    const item = await prisma.fornecedor.update({
      where: { id: req.params.id },
      data:  { ...parsed.data, updatedAt: new Date() },
    });
    res.json(item);
  } catch (err) {
    console.error('[staff] fornecedores PATCH error:', err);
    res.status(500).json({ error: 'Erro ao atualizar fornecedor' });
  }
});

router.delete('/fornecedores/:id', requireRole('ADMIN'), async (req, res) => {
  try {
    // Soft-delete
    await prisma.fornecedor.update({ where: { id: req.params.id }, data: { active: false } });
    res.json({ ok: true });
  } catch (err) {
    console.error('[staff] fornecedores DELETE error:', err);
    res.status(500).json({ error: 'Erro ao remover fornecedor' });
  }
});

// ── IA Operações ──────────────────────────────────────────────────────────────
const { runAlertRules } = require('../lib/alert-rules');

// GET /api/staff/ia/alertas — live operational alerts
router.get('/ia/alertas', requireRole('ADMIN'), async (req, res) => {
  try {
    const property = await prisma.property.findFirst({
      where: { active: true },
      select: { id: true },
    });
    if (!property) return res.json({ alertas: [], geradoEm: new Date().toISOString() });

    const propertyId = req.query.propertyId || property.id;
    const alertas    = await runAlertRules(prisma, propertyId);
    res.json({ alertas, geradoEm: new Date().toISOString() });
  } catch (err) {
    console.error('[staff-portal] ia/alertas error:', err);
    res.status(500).json({ error: 'Erro ao gerar alertas' });
  }
});

// POST /api/staff/ia/briefing — daily narrative brief via Claude
// 6-hour module-level cache. Pass ?refresh=1 to force regeneration.
const _briefCache = new Map(); // propertyId → { text, cachedAt }
const BRIEF_TTL_MS = 6 * 60 * 60 * 1000;

router.post('/ia/briefing', requireRole('ADMIN'), async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'ANTHROPIC_API_KEY não configurada' });
  }

  try {
    const property = await prisma.property.findFirst({
      where: { active: true },
      select: { id: true, name: true },
    });
    if (!property) return res.status(404).json({ error: 'Nenhuma propriedade ativa' });

    const propertyId  = req.query.propertyId || property.id;
    const forceRefresh = req.query.refresh === '1';
    const cached       = _briefCache.get(propertyId);

    if (cached && !forceRefresh && Date.now() - cached.cachedAt < BRIEF_TTL_MS) {
      return res.json({ text: cached.text, cachedAt: new Date(cached.cachedAt).toISOString(), fromCache: true });
    }

    // Gather operational snapshot
    const now         = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const threeDaysAhead = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);

    const [recentBookings, upcomingBookings, openTickets, overdueSchedules, alertas] = await Promise.all([
      prisma.booking.findMany({
        where:  { propertyId, checkOut: { gte: sevenDaysAgo, lt: now } },
        select: { status: true, guestName: true, nights: true },
      }),
      prisma.booking.findMany({
        where:  { propertyId, status: 'CONFIRMED', checkIn: { gte: now, lte: threeDaysAhead } },
        select: { guestName: true, checkIn: true, guestCount: true },
      }),
      prisma.serviceTicket.findMany({
        where:  { propertyId, status: { in: ['ABERTO', 'EM_ANDAMENTO'] } },
        select: { title: true, priority: true, status: true },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.maintenanceSchedule.findMany({
        where:  { propertyId, nextDueAt: { lt: now } },
        select: { item: true, nextDueAt: true },
      }),
      runAlertRules(prisma, propertyId),
    ]);

    const urgent = alertas.filter(a => a.severity === 'URGENTE');

    const ticketsSection = openTickets.length > 0
      ? `\nChamados abertos (${openTickets.length}):\n${openTickets.slice(0, 5).map(t => `• ${t.title} [${t.priority}]`).join('\n')}`
      : '';
    const overdueSection = overdueSchedules.length > 0
      ? `\nManutenções atrasadas:\n${overdueSchedules.map(s => `• ${s.item} (desde ${s.nextDueAt.toLocaleDateString('pt-BR')})`).join('\n')}`
      : '';
    const upcomingSection = upcomingBookings.length > 0
      ? `\nCheck-ins nos próximos 3 dias:\n${upcomingBookings.map(b => `• ${b.guestName} — ${new Date(b.checkIn).toLocaleDateString('pt-BR')} (${b.guestCount} hóspede${b.guestCount !== 1 ? 's' : ''})`).join('\n')}`
      : '';

    const Anthropic = require('@anthropic-ai/sdk');
    const client    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const response = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages:   [{
        role:    'user',
        content: `Você é o sistema de gestão operacional do ${property.name}, uma pousada em Jaboticatubas, MG.

Snapshot do dia ${now.toLocaleDateString('pt-BR')}:
- Check-outs nos últimos 7 dias: ${recentBookings.length}
- Check-ins nos próximos 3 dias: ${upcomingBookings.length}
- Alertas ativos: ${alertas.length} (${urgent.length} urgentes)
- Chamados abertos: ${openTickets.length}
- Manutenções atrasadas: ${overdueSchedules.length}
${ticketsSection}${overdueSection}${upcomingSection}

Escreva um briefing operacional diário em português. 3 a 4 parágrafos curtos. Destaque prioridades imediatas, o que está bem encaminhado, e qualquer ação recomendada. Tom: direto, profissional, sem dramaturgia.`,
      }],
    });

    const text = response.content[0]?.text || '';
    _briefCache.set(propertyId, { text, cachedAt: Date.now() });

    res.json({ text, cachedAt: new Date().toISOString(), fromCache: false });
  } catch (err) {
    console.error('[staff-portal] ia/briefing error:', err);
    res.status(500).json({ error: 'Erro ao gerar briefing' });
  }
});

module.exports = router;
