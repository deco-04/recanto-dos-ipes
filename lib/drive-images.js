'use strict';

/**
 * Google Drive image-library helper for the content agent.
 *
 * Design:
 *  - Stateless pure functions where possible (extractFolderId).
 *  - Factory `makeDriveImagesClient` for I/O — lets tests inject a fake fetch
 *    without having to mock global `fetch` or `require` cache.
 *  - Uses Drive API v3 with a public read-only API key. Folder MUST be
 *    shared "anyone with the link can view". For private folders, swap the
 *    apiKey for an OAuth access token and add `Authorization: Bearer ...`.
 *
 * Drive API v3 reference:
 *   GET https://www.googleapis.com/drive/v3/files
 *     ?q=<folder filter>&fields=files(id,name,mimeType,webContentLink,thumbnailLink)&key=<apiKey>
 *   GET https://www.googleapis.com/drive/v3/files/<id>?alt=media&key=<apiKey>
 */

const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3/files';

/**
 * Extract a folder ID from a Google Drive URL (or passthrough a raw ID).
 * Returns `null` for anything that doesn't look like a folder reference.
 *
 * Supported inputs:
 *   - https://drive.google.com/drive/folders/<ID>
 *   - https://drive.google.com/drive/folders/<ID>?usp=sharing
 *   - https://drive.google.com/open?id=<ID>
 *   - <ID>  (25+ chars, alphanumeric + dash/underscore — user pasted just the id)
 *
 * NOT supported:
 *   - /file/d/<ID>  (that's a file, not a folder)
 */
function extractFolderId(input) {
  if (!input || typeof input !== 'string') return null;

  // /drive/folders/<ID>?…
  const folderPath = input.match(/\/drive\/folders\/([A-Za-z0-9_-]+)/);
  if (folderPath) return folderPath[1];

  // ?id=<ID>  — only trust when the path is not a file path
  if (!input.includes('/file/d/')) {
    const idQuery = input.match(/[?&]id=([A-Za-z0-9_-]+)/);
    if (idQuery) return idQuery[1];
  }

  // Raw id passed through (25+ chars of the allowed alphabet, no slashes)
  if (/^[A-Za-z0-9_-]{25,}$/.test(input)) return input;

  return null;
}

/**
 * Factory for Drive operations. `fetchFn` defaults to global fetch; tests
 * inject a vi.fn() so no network is touched.
 */
function makeDriveImagesClient({ apiKey, fetchFn } = {}) {
  if (!apiKey) throw new Error('makeDriveImagesClient: apiKey is required');
  const _fetch = fetchFn || globalThis.fetch;
  if (typeof _fetch !== 'function') {
    throw new Error('makeDriveImagesClient: fetchFn is required (or run on Node 18+ with global fetch)');
  }

  async function listFolderImages(folderId) {
    const q      = `'${folderId}' in parents and mimeType contains 'image/' and trashed = false`;
    const fields = 'files(id,name,mimeType,webContentLink,thumbnailLink)';
    const url    = `${DRIVE_API_BASE}?q=${encodeURIComponent(q)}&fields=${encodeURIComponent(fields)}&pageSize=100&key=${apiKey}`;

    const res = await _fetch(url);
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      const msg = detail?.error?.message || 'unknown';
      throw new Error(`[drive-images] listFolderImages failed (HTTP ${res.status}): ${msg}`);
    }
    const body = await res.json();
    const files = Array.isArray(body?.files) ? body.files : [];
    // Defensive: server occasionally returns non-image items when `q` is
    // bypassed by internal quirks; enforce the filter client-side too.
    return files.filter(f => typeof f.mimeType === 'string' && f.mimeType.startsWith('image/'));
  }

  async function downloadImage(fileId) {
    const url = `${DRIVE_API_BASE}/${encodeURIComponent(fileId)}?alt=media&key=${apiKey}`;
    const res = await _fetch(url);
    if (!res.ok) {
      throw new Error(`[drive-images] downloadImage failed (HTTP ${res.status})`);
    }
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  }

  return { listFolderImages, downloadImage };
}

module.exports = { extractFolderId, makeDriveImagesClient };
