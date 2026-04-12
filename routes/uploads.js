'use strict';

/**
 * Upload service — Central da Equipe PWA photo storage.
 *
 * POST /api/uploads
 *   multipart/form-data: file (image), bookingId (string), tipo ('PRE_CHECKIN' | 'CHECKOUT')
 *   Returns: { id: "recanto-dos-ipes/2026/04/joao-silva/checkin/uuid.jpg", url: "https://..." }
 *
 * Storage structure (matches business requirement):
 *   {property-slug}/{YYYY}/{MM}/{guest-name-slug}/{tipo}/
 *
 * Files are stored in UPLOAD_DIR (Railway Volume at /data/uploads in prod,
 * or ./uploads in local dev). Served as static files at /uploads.
 *
 * Images are resized to max 1200px wide, quality 82 JPEG — ~50-150KB per photo.
 */

const express = require('express');
const multer  = require('multer');
const sharp   = require('sharp');
const path    = require('path');
const fs      = require('fs');
const { randomUUID: uuidv4 } = require('crypto');

const router = express.Router();

// ── Config ──────────────────────────────────────────────────────────────────
const UPLOAD_DIR = process.env.UPLOAD_DIR
  || (process.env.NODE_ENV === 'production' ? '/data/uploads' : path.join(process.cwd(), 'uploads'));

const PUBLIC_URL = process.env.UPLOAD_PUBLIC_URL
  || (process.env.NODE_ENV === 'production'
      ? process.env.RAILWAY_PUBLIC_DOMAIN
        ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
        : process.env.NEXT_PUBLIC_API_URL || ''
      : 'http://localhost:3000');

// Ensure base directory exists
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ── Multer (memory storage — Sharp processes before writing to disk) ─────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB raw max
  fileFilter(req, file, cb) {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Apenas imagens são permitidas'));
    }
    cb(null, true);
  },
});

// ── Auth: same x-staff-id header used by staff-portal ───────────────────────
const prisma = require('../lib/db');

async function requireStaff(req, res, next) {
  const staffId = req.headers['x-staff-id'];
  if (!staffId) return res.status(401).json({ error: 'Não autenticado' });
  const staff = await prisma.staffMember.findUnique({
    where: { id: staffId },
    select: { id: true, active: true },
  });
  if (!staff || !staff.active) return res.status(401).json({ error: 'Acesso negado' });
  req.staff = staff;
  next();
}

// ── Build organized folder path from booking data ────────────────────────────
async function buildFolderPath(bookingId, tipo) {
  if (!bookingId) {
    // Fallback for photos without a booking
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
      // Booking not found — use bookingId as fallback
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

    // Structure: recanto-dos-ipes/2026/04/joao-silva/checkin
    return `${propertySlug}/${year}/${month}/${guestSlug}/${tipoDir}`;
  } catch {
    const now = new Date();
    return `reservas/${now.getFullYear()}/${pad(now.getMonth() + 1)}/${bookingId || 'avulso'}`;
  }
}

// ── POST /api/uploads ────────────────────────────────────────────────────────
router.post('/', requireStaff, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });

  try {
    const bookingId = sanitizeId(req.body.bookingId || '');
    const tipo      = ['PRE_CHECKIN', 'CHECKOUT'].includes(req.body.tipo) ? req.body.tipo : 'PRE_CHECKIN';

    const folder    = await buildFolderPath(bookingId, tipo);
    const id        = uuidv4();
    const filename  = `${id}.jpg`;
    const relPath   = `${folder}/${filename}`;
    const fullDir   = path.join(UPLOAD_DIR, folder);

    fs.mkdirSync(fullDir, { recursive: true });

    // Resize + convert to JPEG
    await sharp(req.file.buffer)
      .resize({ width: 1200, withoutEnlargement: true })
      .jpeg({ quality: 82, progressive: true })
      .toFile(path.join(fullDir, filename));

    const url = `${PUBLIC_URL}/uploads/${relPath}`;

    res.json({ id: relPath, url });
  } catch (err) {
    console.error('[uploads] processing error:', err);
    res.status(500).json({ error: 'Erro ao processar imagem' });
  }
});

// ── DELETE /api/uploads — soft cleanup, admins only ─────────────────────────
// Accepts path encoded as base64 or slash-separated segments
router.delete('/*', requireStaff, async (req, res) => {
  const staff = await prisma.staffMember.findUnique({
    where: { id: req.staff.id },
    select: { role: true },
  });
  if (staff?.role !== 'ADMIN') return res.status(403).json({ error: 'Apenas admins podem deletar imagens' });

  // req.params[0] is everything after /api/uploads/
  const rawPath = req.params[0] || '';
  const safePath = sanitizePath(rawPath);
  if (!safePath) return res.status(400).json({ error: 'Caminho inválido' });

  const filePath = path.join(UPLOAD_DIR, safePath);
  if (!filePath.startsWith(path.resolve(UPLOAD_DIR))) {
    return res.status(400).json({ error: 'Caminho inválido' });
  }

  try {
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

/** Convert guest name to a safe folder slug */
function slugify(str) {
  return str
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'hospede';
}

/** Allow only cuid/uuid-style booking IDs */
function sanitizeId(id) {
  return /^[a-zA-Z0-9_-]{1,40}$/.test(id) ? id : '';
}

/** Allow path segments: letters, numbers, hyphens, underscores, slashes, dots */
function sanitizePath(p) {
  const clean = p.replace(/[^a-zA-Z0-9/_.-]/g, '').replace(/\.\.+/g, '').replace(/\/+/g, '/');
  return clean.startsWith('/') ? clean.slice(1) : clean;
}

module.exports = { router, UPLOAD_DIR };
