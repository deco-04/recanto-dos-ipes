'use strict';

/**
 * Upload service — Central da Equipe PWA photo and video storage.
 *
 * POST /api/uploads
 *   multipart/form-data: file (image), bookingId, tipo
 *   Returns: { id: relPath, url }
 *
 * POST /api/uploads/video
 *   multipart/form-data: file (video), bookingId, tipo
 *   Max 100MB. Duration enforced client-side (≤15s).
 *   Returns: { id: relPath, url }
 *
 * Storage: local filesystem or Cloudflare R2, via lib/storage.js
 * Set STORAGE_PROVIDER=r2 to switch. Default: local.
 */

const express = require('express');
const multer  = require('multer');
const sharp   = require('sharp');
const path    = require('path');
const { randomUUID: uuidv4 } = require('crypto');
const { saveFile, UPLOAD_DIR } = require('../lib/storage');

const router = express.Router();

// ── Auth ─────────────────────────────────────────────────────────────────────
const prisma = require('../lib/db');
const { requireStaff } = require('../lib/staff-auth-middleware');

// ── Multer: images ────────────────────────────────────────────────────────────
const uploadImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Apenas imagens são permitidas'));
    }
    cb(null, true);
  },
});

// ── Multer: videos ────────────────────────────────────────────────────────────
const uploadVideo = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB raw max
  fileFilter(req, file, cb) {
    if (!file.mimetype.startsWith('video/')) {
      return cb(new Error('Apenas vídeos são permitidos'));
    }
    cb(null, true);
  },
});

// ── Build organized folder path from booking data ────────────────────────────
async function buildFolderPath(bookingId, tipo) {
  if (!bookingId) {
    const now = new Date();
    return `geral/${now.getFullYear()}/${pad(now.getMonth() + 1)}`;
  }
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        guestName: true,
        checkIn: true,
        property: { select: { slug: true } },
        user: { select: { name: true } },
      },
    });
    if (!booking) {
      const now = new Date();
      return `reservas/${now.getFullYear()}/${pad(now.getMonth() + 1)}/${bookingId}`;
    }
    const propertySlug = booking.property?.slug || 'recanto-dos-ipes';
    const guestName    = booking.user?.name || booking.guestName || 'hospede';
    const date         = booking.checkIn ? new Date(booking.checkIn) : new Date();
    const year         = date.getFullYear();
    const month        = pad(date.getMonth() + 1);
    const guestSlug    = slugify(guestName);
    const tipoDir      = tipo === 'CHECKOUT' ? 'checkout' : 'checkin';
    return `${propertySlug}/${year}/${month}/${guestSlug}/${tipoDir}`;
  } catch {
    const now = new Date();
    return `reservas/${now.getFullYear()}/${pad(now.getMonth() + 1)}/${bookingId || 'avulso'}`;
  }
}

// ── POST /api/uploads — photo upload ─────────────────────────────────────────
router.post('/', requireStaff, uploadImage.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });

  try {
    const bookingId = sanitizeId(req.body.bookingId || '');
    const tipo      = ['PRE_CHECKIN', 'CHECKOUT'].includes(req.body.tipo) ? req.body.tipo : 'PRE_CHECKIN';
    const folder    = await buildFolderPath(bookingId, tipo);
    const relPath   = `${folder}/${uuidv4()}.jpg`;

    // Resize + JPEG conversion via Sharp
    const processed = await sharp(req.file.buffer)
      .resize({ width: 1200, withoutEnlargement: true })
      .jpeg({ quality: 82, progressive: true })
      .toBuffer();

    const { url } = await saveFile(processed, relPath);
    res.json({ id: relPath, url });
  } catch (err) {
    console.error('[uploads] photo error:', err);
    res.status(500).json({ error: 'Erro ao processar imagem' });
  }
});

// ── POST /api/uploads/video — video upload ────────────────────────────────────
router.post('/video', requireStaff, uploadVideo.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });

  try {
    const bookingId = sanitizeId(req.body.bookingId || '');
    const tipo      = ['PRE_CHECKIN', 'CHECKOUT'].includes(req.body.tipo) ? req.body.tipo : 'PRE_CHECKIN';
    const folder    = await buildFolderPath(bookingId, tipo);

    // Determine file extension from mimetype
    const ext = req.file.mimetype === 'video/webm' ? 'webm'
      : req.file.mimetype === 'video/quicktime' ? 'mov'
      : 'mp4';

    const relPath = `videos/${folder}/${uuidv4()}.${ext}`;

    const { url } = await saveFile(req.file.buffer, relPath);
    res.json({ id: relPath, url });
  } catch (err) {
    console.error('[uploads] video error:', err);
    res.status(500).json({ error: 'Erro ao salvar vídeo' });
  }
});

// ── DELETE /api/uploads — admins only ────────────────────────────────────────
router.delete('/*', requireStaff, async (req, res) => {
  if (req.staff.role !== 'ADMIN') return res.status(403).json({ error: 'Apenas admins podem deletar arquivos' });

  const rawPath = req.params[0] || '';
  const safePath = sanitizePath(rawPath);
  if (!safePath) return res.status(400).json({ error: 'Caminho inválido' });

  const filePath = path.join(UPLOAD_DIR, safePath);
  if (!filePath.startsWith(path.resolve(UPLOAD_DIR))) {
    return res.status(400).json({ error: 'Caminho inválido' });
  }

  try {
    const fs = require('fs');
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    res.json({ ok: true });
  } catch (err) {
    console.error('[uploads] delete error:', err);
    res.status(500).json({ error: 'Erro ao deletar arquivo' });
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function pad(n) {
  return String(n).padStart(2, '0');
}

function slugify(str) {
  return str
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'hospede';
}

function sanitizeId(id) {
  return /^[a-zA-Z0-9_-]{1,40}$/.test(id) ? id : '';
}

function sanitizePath(p) {
  const clean = p.replace(/[^a-zA-Z0-9/_.-]/g, '').replace(/\.\.+/g, '').replace(/\/+/g, '/');
  return clean.startsWith('/') ? clean.slice(1) : clean;
}

module.exports = { router, UPLOAD_DIR };
