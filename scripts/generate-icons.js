// scripts/generate-icons.js
// Generates PWA icons from the purpose-built app-icon.svg using sharp.
// Run automatically during Railway build via railway.toml buildCommand.
// Also runnable manually: node scripts/generate-icons.js
'use strict';

const sharp = require('sharp');
const path  = require('path');
const fs    = require('fs');

const ROOT     = path.join(__dirname, '..');
// Purpose-built app icon: ipê flower + glass disc (NOT the complex brand landscape mark)
const SVG_PATH = path.join(ROOT, 'public', 'icons', 'app-icon.svg');
const ICON_DIR = path.join(ROOT, 'public', 'icons');

// Ensure icons directory exists
if (!fs.existsSync(ICON_DIR)) {
  fs.mkdirSync(ICON_DIR, { recursive: true });
  console.log('[icons] Created /public/icons directory');
}

// Icons to generate
const ICONS = [
  // Standard icons (SVG rendered directly at each size)
  { size: 512, name: 'icon-512.png'         },
  { size: 192, name: 'icon-192.png'         },
  { size: 180, name: 'apple-touch-icon.png' },
  { size: 32,  name: 'favicon-32.png'       },
  { size: 16,  name: 'favicon-16.png'       },
  // Maskable variants (same design; OS applies its own shape mask)
  { size: 512, name: 'icon-maskable-512.png' },
  { size: 192, name: 'icon-maskable-192.png' },
  // Badge: small notification icon — white flower silhouette on forest dark
  { size: 72,  name: 'badge-72.png', badge: true },
];

async function generateIcon({ size, name, badge }) {
  const outPath = path.join(ICON_DIR, name);

  // Skip regeneration if file already exists (speeds up repeated local runs)
  // Always regenerate in Railway CI environment
  if (fs.existsSync(outPath) && !process.env.RAILWAY_ENVIRONMENT) {
    console.log(`[icons] Skipping ${name} (already exists — delete to force regeneration)`);
    return;
  }

  try {
    if (badge) {
      // Badge icon: render flower SVG at size, then composite on a solid forest background.
      // The badge is shown in notification bars (monochrome context) so keeping it simple.
      const flowerBuf = await sharp(SVG_PATH)
        .resize(size, size, { fit: 'cover' })
        .png()
        .toBuffer();

      // Create forest-dark square, composite flower on top
      await sharp({
        create: {
          width:      size,
          height:     size,
          channels:   4,
          background: { r: 26, g: 17, b: 8, alpha: 1 },  // #1A1108 forest
        },
      })
        .composite([{ input: flowerBuf, gravity: 'center' }])
        .png()
        .toFile(outPath);
    } else {
      // Standard icon: render the full SVG (it already has its own background + design)
      await sharp(SVG_PATH)
        .resize(size, size, { fit: 'cover' })
        .png()
        .toFile(outPath);
    }

    console.log(`[icons] ✓ ${name} (${size}×${size})`);
  } catch (err) {
    console.error(`[icons] ✗ Failed to generate ${name}:`, err.message);
    // Non-fatal — app still works; browser will fall back to the letter avatar
  }
}

async function main() {
  console.log('[icons] Generating PWA icons from app-icon.svg…');

  if (!fs.existsSync(SVG_PATH)) {
    console.warn(`[icons] Source SVG not found at ${SVG_PATH} — skipping icon generation`);
    process.exit(0);
  }

  // Sequential to avoid overwhelming sharp on Railway's memory-constrained build instances
  for (const spec of ICONS) {
    await generateIcon(spec);
  }

  console.log('[icons] All done.');
}

main().catch(err => {
  console.error('[icons] Fatal error:', err);
  process.exit(1);
});
