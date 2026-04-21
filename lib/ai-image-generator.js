'use strict';

/**
 * AI image generator — hero-image fallback for the content agent.
 *
 * Called only when (a) the brand opted in via `BrandContentConfig.aiImageFallback`
 * AND (b) the Google-Drive library picker returned null (no acceptable photo).
 *
 * Kept as a factory so tests can inject a fake OpenAI client + fake fs writer;
 * mirror of `content-image-picker.js` shape.
 *
 * Env vars required at call site:
 *   OPENAI_API_KEY — OpenAI API key with image-generation access
 *   PUBLIC_BASE_URL, UPLOADS_DIR — passed explicitly, same as Drive path
 *
 * Cost guardrails:
 *   - Only BLOG + IG_FEED + IG_STORIES use this fallback (skip cheap channels).
 *   - Default size '1024x1024' keeps ~1.5¢ per image (Jan 2026 pricing).
 *   - Per-post timeout so a hang can't wedge the weekly cron.
 */

const path = require('path');
const fs   = require('fs/promises');

const MODEL        = 'gpt-image-1';
const DEFAULT_SIZE = '1024x1024';
const TIMEOUT_MS   = 45_000;          // per-post hard cap; 1 image usually ~10 s

/**
 * Build the prompt fed to the image model. Keeps it short + concrete — image
 * models wander when the prompt is long, so we strip the body and lean on
 * the imagePrompt the text model already produced as part of weekly gen.
 */
function buildImagePrompt({ post, brandName }) {
  const base = post.imagePrompt
    ? post.imagePrompt.trim()
    : `Editorial travel photo illustrating: ${post.title}`;
  // Always append the brand-setting hint so the model produces on-brand imagery.
  return [
    base,
    `Setting: rural tourism property in Serra do Cipó, Minas Gerais, Brazil.`,
    brandName ? `Brand: ${brandName}.` : '',
    `Style: natural light, warm tones, no text overlays, no watermarks, no people facing the camera directly.`,
  ].filter(Boolean).join(' ');
}

/** Narrow list of channels worth generating a hero for (cost guardrail). */
const ELIGIBLE_TYPES = new Set([
  'BLOG',
  'INSTAGRAM_FEED',
  'INSTAGRAM_STORIES',
]);

/**
 * Factory: returns an async `generateHeroImage({ post, brandName }) → url|null`.
 * Every failure path returns null (never throws); the caller treats null as
 * "couldn't place an image — post ships without one".
 */
function makeGenerateHeroImage({
  openaiClient,
  writeFileFn,
  publicBaseUrl,
  uploadsDir,
  size = DEFAULT_SIZE,
  timeoutMs = TIMEOUT_MS,
}) {
  const write = writeFileFn || fs.writeFile;

  return async function generateHeroImage({ post, brandName }) {
    if (!post || !post.id) return null;
    if (post.contentType && !ELIGIBLE_TYPES.has(post.contentType)) return null;

    const prompt = buildImagePrompt({ post, brandName });

    let bytes;
    try {
      // Race with a timeout so a hung OpenAI request can't block the cron.
      const result = await Promise.race([
        openaiClient.images.generate({
          model:    MODEL,
          prompt,
          size,
          n:        1,
          // response_format omitted — gpt-image-1 returns b64_json by default.
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`ai-image timeout after ${timeoutMs}ms`)), timeoutMs)),
      ]);

      const b64 = result?.data?.[0]?.b64_json;
      if (!b64) {
        console.warn(`[ai-image-generator] empty response for post ${post.id}`);
        return null;
      }
      bytes = Buffer.from(b64, 'base64');
    } catch (err) {
      console.error(`[ai-image-generator] failed for post ${post.id}: ${err.message}`);
      return null;
    }

    try {
      // Save with an `-ai` suffix so the filename shows it's generated — useful
      // if someone later swaps in a real photo (no naming collision).
      const relPath = `content/${post.brand || 'GEN'}/${post.id}-ai.png`;
      const absPath = `${uploadsDir.replace(/\/$/, '')}/${relPath}`;
      await fs.mkdir(path.posix.dirname(absPath), { recursive: true });
      await write(absPath, bytes);
      return `${publicBaseUrl.replace(/\/$/, '')}/uploads/${relPath}`;
    } catch (err) {
      console.error(`[ai-image-generator] write failed for post ${post.id}: ${err.message}`);
      return null;
    }
  };
}

module.exports = {
  makeGenerateHeroImage,
  _internals: { buildImagePrompt, ELIGIBLE_TYPES, MODEL, DEFAULT_SIZE },
};
