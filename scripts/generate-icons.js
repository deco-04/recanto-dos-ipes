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
// Color brand mark — best contrast on light beige background
const MARK_PATH = path.join(ROOT, 'public', 'brand', 'sri-mark-color.svg');
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
 * Returns an inline SVG string for the light beige background at a given size.
 */
function makeBgSvg(size) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
  <rect width="${size}" height="${size}" fill="#F7F7F2"/>
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
  console.log('[icons] Generating PWA icons from sri-mark-color.svg…');

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
