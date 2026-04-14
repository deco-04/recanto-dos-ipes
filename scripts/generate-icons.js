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
// Symbol mark — used for small favicons (16, 32, 72)
const MARK_PATH = path.join(ROOT, 'public', 'brand', 'sri-mark-color.svg');
// Full logo (mark + name) — used for app icons (180, 192, 512, maskable)
const LOGO_PATH = path.join(ROOT, 'brand', 'logo-color.svg');
const ICON_DIR  = path.join(ROOT, 'public', 'icons');

// Logo aspect ratio: 3779 ÷ 2645 = 1.4286 (landscape)
const LOGO_RATIO = 3779 / 2645;
// Mark is square-ish (1:1)
const MARK_RATIO = 1;

// Ensure output directory exists
if (!fs.existsSync(ICON_DIR)) {
  fs.mkdirSync(ICON_DIR, { recursive: true });
  console.log('[icons] Created /public/icons/');
}

// ── Icons to generate ─────────────────────────────────────────────────────────
const ICONS = [
  { size: 512, name: 'icon-512.png',          logo: true  },
  { size: 192, name: 'icon-192.png',          logo: true  },
  { size: 180, name: 'apple-touch-icon.png',  logo: true  },
  { size: 32,  name: 'favicon-32.png',        logo: false },
  { size: 16,  name: 'favicon-16.png',        logo: false },
  { size: 512, name: 'icon-maskable-512.png', logo: true  },
  { size: 192, name: 'icon-maskable-192.png', logo: true  },
  { size: 72,  name: 'badge-72.png',          logo: false },
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
async function generateIcon({ size, name, logo }) {
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

    // Step 2 — Render asset:
    //   app icons  → full logo at 80% fill (landscape ratio)
    //   favicons   → symbol mark at 70% fill (square)
    const srcPath = logo ? LOGO_PATH : MARK_PATH;
    const ratio   = logo ? LOGO_RATIO : MARK_RATIO;
    const fill    = logo ? 0.80 : 0.70;
    const assetW  = Math.round(size * fill);
    const assetH  = logo ? Math.round(assetW / ratio) : assetW;

    const assetBuf = await sharp(srcPath)
      .resize(assetW, assetH, {
        fit:        'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toBuffer();

    // Step 3 — Composite centred on background
    await sharp(bgBuf)
      .composite([{ input: assetBuf, gravity: 'center' }])
      .png()
      .toFile(outPath);

    console.log(`[icons] ✓ ${name} (${size}×${size}) [${logo ? 'logo' : 'mark'}]`);
  } catch (err) {
    console.error(`[icons] ✗ Failed to generate ${name}:`, err.message);
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────
async function main() {
  console.log('[icons] Generating PWA icons (logo @ 80% for app, mark for favicon)…');

  if (!fs.existsSync(MARK_PATH)) {
    console.warn(`[icons] Mark not found at ${MARK_PATH} — skipping`);
    process.exit(0);
  }
  if (!fs.existsSync(LOGO_PATH)) {
    console.warn(`[icons] Logo not found at ${LOGO_PATH} — skipping`);
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
