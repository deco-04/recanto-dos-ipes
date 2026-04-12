// scripts/generate-icons.js
// Generates PWA icons from the SRI mark SVG using sharp.
// Run automatically during Railway build via railway.toml buildCommand.
// Also runnable manually: node scripts/generate-icons.js
'use strict';

const sharp = require('sharp');
const path  = require('path');
const fs    = require('fs');

const ROOT     = path.join(__dirname, '..');
const SVG_PATH = path.join(ROOT, 'public', 'brand', 'sri-mark-color.svg');
const ICON_DIR = path.join(ROOT, 'public', 'icons');

// Ensure icons directory exists
if (!fs.existsSync(ICON_DIR)) {
  fs.mkdirSync(ICON_DIR, { recursive: true });
  console.log('[icons] Created /public/icons directory');
}

// Icons to generate
const ICONS = [
  // Standard icons (any purpose)
  { size: 512, name: 'icon-512.png',          padding: 0    },
  { size: 192, name: 'icon-192.png',          padding: 0    },
  { size: 180, name: 'apple-touch-icon.png',  padding: 0    },
  { size: 32,  name: 'favicon-32.png',        padding: 0    },
  { size: 16,  name: 'favicon-16.png',        padding: 0    },
  // Badge icon for push notifications (72x72, white mark on forest background)
  { size: 72,  name: 'badge-72.png',          padding: 0,   badge: true },
  // Maskable icons (safe zone = 80% of total, 10% padding on each side)
  { size: 512, name: 'icon-maskable-512.png', padding: 0.15 },
  { size: 192, name: 'icon-maskable-192.png', padding: 0.15 },
];

async function generateIcon({ size, name, padding, badge }) {
  const outPath = path.join(ICON_DIR, name);

  // Skip regeneration if file already exists (speeds up repeated builds)
  if (fs.existsSync(outPath)) {
    // Always regenerate in CI (Railway sets RAILWAY_ENVIRONMENT)
    if (!process.env.RAILWAY_ENVIRONMENT) {
      console.log(`[icons] Skipping ${name} (already exists)`);
      return;
    }
  }

  const innerSize = Math.round(size * (1 - padding * 2));
  const bgColor   = badge ? '#261C15' : '#F7F7F2';  // forest dark for badge, beige for standard
  const markSvg   = badge
    ? path.join(ROOT, 'public', 'brand', 'sri-mark-white.svg')
    : SVG_PATH;

  try {
    const resizedMark = await sharp(markSvg)
      .resize(innerSize, innerSize, { fit: 'contain', background: { r:0, g:0, b:0, alpha:0 } })
      .png()
      .toBuffer();

    // Create background canvas and composite the mark centered
    await sharp({
      create: {
        width:      size,
        height:     size,
        channels:   4,
        background: badge ? { r: 38, g: 28, b: 21, alpha: 1 } : { r: 247, g: 247, b: 242, alpha: 1 },
      },
    })
      .composite([{
        input:   resizedMark,
        gravity: 'center',
      }])
      .png()
      .toFile(outPath);

    console.log(`[icons] Generated ${name} (${size}×${size})`);
  } catch (err) {
    console.error(`[icons] Failed to generate ${name}:`, err.message);
    // Non-fatal: app still works without perfect icons
  }
}

async function main() {
  console.log('[icons] Generating PWA icons from sri-mark-color.svg…');

  if (!fs.existsSync(SVG_PATH)) {
    console.warn(`[icons] SVG source not found at ${SVG_PATH} — skipping icon generation`);
    return;
  }

  // Run in sequence to avoid overwhelming sharp on low-memory Railway instances
  for (const spec of ICONS) {
    await generateIcon(spec);
  }

  console.log('[icons] Done.');
}

main().catch(err => {
  console.error('[icons] Fatal error:', err);
  process.exit(1);
});
