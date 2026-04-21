'use strict';

/**
 * Image picker for the content agent. Given a ContentPost and a list of
 * images in the brand's Google Drive folder, ask Claude which filename best
 * illustrates the post. If nothing fits, return null — the post stays with
 * empty mediaUrls and the admin can attach something manually.
 *
 * Two factories are exported so unit tests can inject fakes for Claude, the
 * Drive client, and the filesystem writer without touching the network.
 */

const path = require('path');
const fs   = require('fs/promises');

const MODEL = 'claude-sonnet-4-6-20251001';

function buildPickerPrompt({ post, libraryImages }) {
  const filenames = libraryImages.map(f => f.name).join('\n- ');
  return [
    `You are helping pick the best photo for a marketing post.`,
    ``,
    `POST TITLE:`,
    post.title || '(untitled)',
    ``,
    `POST BODY (first 400 chars):`,
    (post.body || '').slice(0, 400),
    ``,
    `AVAILABLE IMAGES:`,
    `- ${filenames}`,
    ``,
    `Return the single filename that best illustrates the post, with no`,
    `quotes and no extra words. If NONE of the filenames are a good fit,`,
    `return the single word NONE.`,
  ].join('\n');
}

function parsePick(text) {
  if (!text) return null;
  const cleaned = String(text).trim().replace(/^["'`]+|["'`]+$/g, '').trim();
  return cleaned;
}

/**
 * Factory: given a Claude client, return `pickImageForPost(args)` that resolves
 * to the library entry Claude picked, or null.
 */
function makePickImageForPost({ claudeClient }) {
  return async function pickImageForPost({ post, libraryImages }) {
    if (!Array.isArray(libraryImages) || libraryImages.length === 0) return null;

    let text;
    try {
      const res = await claudeClient.messages.create({
        model:      MODEL,
        max_tokens: 64,
        messages: [
          { role: 'user', content: buildPickerPrompt({ post, libraryImages }) },
        ],
      });
      const block = res?.content?.[0];
      text = block?.text || '';
    } catch (_err) {
      return null;
    }

    const answer = parsePick(text);
    if (!answer || answer.toUpperCase() === 'NONE') return null;

    return libraryImages.find(f => f.name === answer) || null;
  };
}

/**
 * Factory: glue — list folder, pick image, download bytes, save to disk,
 * return the public URL. All error paths resolve to null; never throws
 * into the caller.
 *
 * Optional `aiFallback({ post })` is called when Drive returns nothing
 * usable (no folder, empty folder, Drive error, Claude picked NONE). The
 * fallback itself must return a URL string or null.
 */
function makeAttachImageToPost({
  driveClient,
  claudeClient,
  writeFileFn,
  publicBaseUrl,
  uploadsDir,
  aiFallback = null,
}) {
  const pickImageForPost = makePickImageForPost({ claudeClient });
  const write = writeFileFn || fs.writeFile;

  // Falls through to `aiFallback` only if it was provided AND Drive produced
  // nothing — keeps cost on an explicit opt-in.
  async function tryAiFallback(post) {
    if (!aiFallback) return null;
    try {
      const url = await aiFallback({ post });
      return url || null;
    } catch (err) {
      console.error(`[content-image-picker] aiFallback failed for post ${post?.id}: ${err.message}`);
      return null;
    }
  }

  return async function attachImageToPost({ post, folderId }) {
    if (!folderId) return tryAiFallback(post);

    try {
      const libraryImages = await driveClient.listFolderImages(folderId);
      const chosen = await pickImageForPost({ post, libraryImages });
      if (!chosen) return tryAiFallback(post);

      const bytes = await driveClient.downloadImage(chosen.id);

      // Preserve original extension; fall back to .jpg if the name lacks one.
      // Use posix-style joins throughout so Linux (Railway) and Windows (local
      // dev) both produce forward-slash paths that match the public URL shape.
      const ext = path.extname(chosen.name) || '.jpg';
      const relPath = `content/${post.brand || 'GEN'}/${post.id}${ext}`;
      const absPath = `${uploadsDir.replace(/\/$/, '')}/${relPath}`;

      // Ensure directory exists before writing
      await fs.mkdir(path.posix.dirname(absPath), { recursive: true });
      await write(absPath, bytes);

      return `${publicBaseUrl.replace(/\/$/, '')}/uploads/${relPath}`;
    } catch (err) {
      // Never bubble: content generation must continue even if imagery fails.
      // eslint-disable-next-line no-console
      console.error(`[content-image-picker] attach failed for post ${post?.id}: ${err.message}`);
      return tryAiFallback(post);
    }
  };
}

module.exports = {
  makePickImageForPost,
  makeAttachImageToPost,
  // exported for unit-testing helpers
  _internals: { buildPickerPrompt, parsePick, MODEL },
};
