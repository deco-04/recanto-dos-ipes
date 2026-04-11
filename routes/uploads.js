'use strict';

/**
 * Upload service — replaces Cloudinary for the Central da Equipe PWA.
 *
 * POST /api/uploads
 *   multipart/form-data: file (image), folder (optional string)
 *   Returns: { id: "folder/uuid.jpg", url: "https://host/uploads/folder/uuid.jpg" }
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
const { v4: uuidv4 } = require('uuid');

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

// ── POST /api/uploads ────────────────────────────────────────────────────────
router.post('/', requireStaff, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });

  try {
    const folder = sanitizeFolder(req.body.folder || 'geral');
    const id     = uuidv4();
    const filename = `${id}.jpg`;
    const relPath  = `${folder}/${filename}`;
    const fullDir  = path.join(UPLOAD_DIR, folder);

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

// ── DELETE /api/uploads/:folder/:filename ────────────────────────────────────
// Soft cleanup — only admins can delete
router.delete('/:folder/:filename', requireStaff, async (req, res) => {
  const staff = await prisma.staffMember.findUnique({
    where: { id: req.staff.id },
    select: { role: true },
  });
  if (staff?.role !== 'ADMIN') return res.status(403).json({ error: 'Apenas admins podem deletar imagens' });

  const { folder, filename } = req.params;
  const safe = sanitizeFolder(folder);
  if (!filename.match(/^[a-f0-9-]+\.jpg$/)) {
    return res.status(400).json({ error: 'Nome de arquivo inválido' });
  }

  const filePath = path.join(UPLOAD_DIR, safe, filename);
  if (!filePath.startsWith(UPLOAD_DIR)) {
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
function sanitizeFolder(folder) {
  // Allow only alphanumeric, hyphens, underscores, single forward slashes
  return folder.replace(/[^a-zA-Z0-9/_-]/g, '').replace(/\/+/g, '/').slice(0, 80);
}

module.exports = { router, UPLOAD_DIR };
