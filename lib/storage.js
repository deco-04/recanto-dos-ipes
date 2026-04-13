'use strict';

/**
 * Storage abstraction — local filesystem or Cloudflare R2 (S3-compatible).
 *
 * Set STORAGE_PROVIDER=r2 and configure:
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME
 *
 * Default: local filesystem using UPLOAD_DIR.
 */

const path = require('path');
const fs   = require('fs');

const UPLOAD_DIR = process.env.UPLOAD_DIR
  || (process.env.NODE_ENV === 'production' ? '/data/uploads' : path.join(process.cwd(), 'uploads'));

const PUBLIC_URL = process.env.UPLOAD_PUBLIC_URL
  || (process.env.NODE_ENV === 'production'
      ? process.env.RAILWAY_PUBLIC_DOMAIN
        ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
        : process.env.NEXT_PUBLIC_API_URL || ''
      : 'http://localhost:3000');

// Ensure base upload directory exists on startup
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/**
 * Save a file buffer to storage.
 * @param {Buffer} buffer - File contents
 * @param {string} relPath - Relative path within storage (e.g. "recanto/2026/04/joao/checkin/uuid.jpg")
 * @returns {Promise<{ url: string }>}
 */
async function saveFile(buffer, relPath) {
  if (process.env.STORAGE_PROVIDER === 'r2') {
    return saveToR2(buffer, relPath);
  }
  return saveToLocal(buffer, relPath);
}

/**
 * Read a file from storage as a Buffer.
 * @param {string} relPath
 * @returns {Promise<Buffer>}
 */
async function readFile(relPath) {
  if (process.env.STORAGE_PROVIDER === 'r2') {
    return readFromR2(relPath);
  }
  return readFromLocal(relPath);
}

/**
 * Delete a file from storage. Silently ignores missing files.
 * @param {string} relPath
 * @returns {Promise<void>}
 */
async function deleteFile(relPath) {
  if (process.env.STORAGE_PROVIDER === 'r2') {
    return deleteFromR2(relPath);
  }
  return deleteFromLocal(relPath);
}

// ── Local filesystem ─────────────────────────────────────────────────────────

async function saveToLocal(buffer, relPath) {
  const fullPath = path.join(UPLOAD_DIR, relPath);
  await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.promises.writeFile(fullPath, buffer);
  return { url: `${PUBLIC_URL}/uploads/${relPath}` };
}

async function readFromLocal(relPath) {
  const fullPath = path.join(UPLOAD_DIR, relPath);
  return fs.promises.readFile(fullPath);
}

async function deleteFromLocal(relPath) {
  const fullPath = path.join(UPLOAD_DIR, relPath);
  try { await fs.promises.unlink(fullPath); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}

// ── Cloudflare R2 (S3-compatible) ────────────────────────────────────────────
// Only loaded if STORAGE_PROVIDER=r2, to avoid import errors when not configured.

async function saveToR2(buffer, relPath) {
  const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
  const client = getR2Client();
  const bucket = process.env.R2_BUCKET_NAME;

  const ext = path.extname(relPath).toLowerCase();
  const contentType = ext === '.mp4' ? 'video/mp4'
    : ext === '.webm' ? 'video/webm'
    : ext === '.png' ? 'image/png'
    : 'image/jpeg';

  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: relPath,
    Body: buffer,
    ContentType: contentType,
  }));

  const r2PublicUrl = process.env.R2_PUBLIC_URL || `https://${bucket}.r2.dev`;
  return { url: `${r2PublicUrl}/${relPath}` };
}

async function readFromR2(relPath) {
  const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
  const client = getR2Client();

  const response = await client.send(new GetObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: relPath,
  }));

  const chunks = [];
  for await (const chunk of response.Body) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function deleteFromR2(relPath) {
  const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
  const client = getR2Client();
  await client.send(new DeleteObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: relPath,
  }));
}

let _r2Client = null;
function getR2Client() {
  if (_r2Client) return _r2Client;
  const { S3Client } = require('@aws-sdk/client-s3');
  _r2Client = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
  return _r2Client;
}

module.exports = { saveFile, readFile, deleteFile, UPLOAD_DIR, PUBLIC_URL };
