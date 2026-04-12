// scripts/generate-icons.js
// Generates PWA PNG icons by compositing the SRI brand mark onto a
// purpose-built forest-dark background using sharp.
// Runs automatically during Railway build (railway.toml buildCommand).
// Also runnable manually: node scripts/generate-icons.js
'use strict';

const sharp = require('sharp');
const path  = require('path');
const fs    = require('fs');

const ROOT      = path.join(__dirname, '..');
// Gold brand mark — best contrast on dark background
const MARK_PATH = path.join(ROOT, 'public', 'brand', 'sri-mark-gold.svg');
const ICON_DIR  = path.join(ROOT, 'public', 'icons');

// Mark aspect ratio: 3779 ÷ 2645 = 1.4286 (landscape)
const MARK_RATIO = 3779 / 2645;

// Ensure output directory exists
if (!fs.existsSync(ICON_DIR)) {
  fs.mkdirSync(ICON_DIR, { recursive: true });
  console.log('[icons] Created /public/icons/');
}

// ── Icons to generate ─────────────────────────────────────────────────────────
const ICONS = [
  { size: 512, name: 'icon-512.png'          },
  { size: 192, name: 'icon-192.png'          },
  { size: 180, name: 'apple-touch-icon.png'  },
  { size: 32,  name: 'favicon-32.png'        },
  { size: 16,  name: 'favicon-16.png'        },
  { size: 512, name: 'icon-maskable-512.png' },
  { size: 192, name: 'icon-maskable-192.png' },
  { size: 72,  name: 'badge-72.png'          },
];

// ── Background SVG (self-contained — no external refs, sharp-safe) ────────────
/**
 * Returns an inline SVG string for the forest-dark background at a given size.
 * Includes forest gradient, nature-green ambient, gold-warmth ambient, and vignette.
 */
function makeBgSvg(size) {
  const cx    = size / 2;
  const cy    = size / 2;
  const gGlow = Math.round(size * 0.55);  // green ambient radius
  const aGlow = Math.round(size * 0.49);  // gold ambient radius
  const vRad  = Math.round(size * 0.56);  // vignette radius

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="${size}" y2="${size}" gradientUnits="userSpaceOnUse">
      <stop offset="0%"   stop-color="#1F1409"/>
      <stop offset="55%"  stop-color="#1C1208"/>
      <stop offset="100%" stop-color="#110B03"/>
    </linearGradient>
    <radialGradient id="gg" cx="${cx * 0.27}" cy="${cy * 0.25}" r="${gGlow}" gradientUnits="userSpaceOnUse">
      <stop offset="0%"   stop-color="#2B7929" stop-opacity="0.30"/>
      <stop offset="100%" stop-color="#2B7929" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="ga" cx="${cx}" cy="${size * 0.94}" r="${aGlow}" gradientUnits="userSpaceOnUse">
      <stop offset="0%"   stop-color="#C5D86D" stop-opacity="0.18"/>
      <stop offset="100%" stop-color="#C5D86D" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="vg" cx="${cx}" cy="${cy}" r="${vRad}" gradientUnits="userSpaceOnUse">
      <stop offset="55%"  stop-color="rgba(0,0,0,0)"/>
      <stop offset="100%" stop-color="rgba(0,0,0,0.52)"/>
    </radialGradient>
  </defs>
  <rect width="${size}" height="${size}" fill="url(#bg)"/>
  <rect width="${size}" height="${size}" fill="url(#gg)"/>
  <rect width="${size}" height="${size}" fill="url(#ga)"/>
  <rect width="${size}" height="${size}" fill="url(#vg)"/>
</svg>`;
}

// ── Generate a single icon ────────────────────────────────────────────────────
async function generateIcon({ size, name }) {
  const outPath = path.join(ICON_DIR, name);

  // Skip if file exists locally (not in Railway CI) to speed up dev re-runs
  if (fs.existsSync(outPath) && !process.env.RAILWAY_ENVIRONMENT) {
    console.log(`[icons] Skipping ${name} (exists — delete to regenerate)`);
    return;
  }

  try {
    // Step 1 — Render background
    const bgBuf = await sharp(Buffer.from(makeBgSvg(size)))
      .resize(size, size)
      .png()
      .toBuffer();

    // Step 2 — Render brand mark at 86% of icon width (maintains landscape ratio)
    // At all sizes this keeps the mark proportionally prominent while avoiding crop.
    const markW = Math.round(size * 0.86);
    const markH = Math.round(markW / MARK_RATIO);

    const markBuf = await sharp(MARK_PATH)
      .resize(markW, markH, {
        fit:        'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },  // transparent padding
      })
      .png()
      .toBuffer();

    // Step 3 — Composite mark centred on background
    await sharp(bgBuf)
      .composite([{ input: markBuf, gravity: 'center' }])
      .png()
      .toFile(outPath);

    console.log(`[icons] ✓ ${name} (${size}×${size})`);
  } catch (err) {
    console.error(`[icons] ✗ Failed to generate ${name}:`, err.message);
    // Non-fatal — browser falls back to letter avatar
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────
async function main() {
  console.log('[icons] Generating PWA icons from sri-mark-gold.svg…');

  if (!fs.existsSync(MARK_PATH)) {
    console.warn(`[icons] Brand mark not found at ${MARK_PATH} — skipping`);
    process.exit(0);
  }

  for (const spec of ICONS) {
    await generateIcon(spec);
  }

  console.log('[icons] All done.');
}

main().catch(err => {
  console.error('[icons] Fatal error:', err);
  process.exit(1);
});
