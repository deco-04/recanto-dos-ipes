# Sítio Recanto dos Ipês — Brand Identity

**File prefix:** `sri`  
**Tagline:** none  
**Role:** Sister brand in Recantos group  

## Colors
| Name | Hex | Role |
|------|-----|------|
| Verde Floresta | `#2B7929` | Primary |
| Verde Lima | `#C5D86D` | Secondary |
| Verde Sálvia | `#E4E6C3` | Light green |
| Off-White | `#F7F7F2` | Background |
| Laranja Terra | `#F05D23` | Accent |
| Marrom Escuro | `#261C15` | Dark |

## Logo
Complex illustrated SVG (Adobe Illustrator export). The mark IS the logo — no wordmark/tagline variants.

Original file: `brand/logo-color.svg` (complex AI SVG, viewBox 3779×2645)

## Logo Files
`Sítio Recanto dos Ipês/brand/logo-system/`

| File | Use |
|------|-----|
| sri-mark-color.svg | Default — light backgrounds |
| sri-mark-bw.svg | Print/emboss — light backgrounds |
| sri-mark-white.svg | Dark backgrounds (apply CSS filter or use this file) |
| sri-chip.svg | Small spaces — dark bg (Verde Floresta) |
| sri-chip-light.svg | Small spaces — light bg (Verde Sálvia) |

## Generator
`scripts/gen-sri-logos.js` — copies mark files + generates chip/favicon/social.

## Presentation
`Sítio Recanto dos Ipês/brand/Sitio Recanto dos Ipes - Brand Presentation.html`

## Usage Quick Reference
- Default: `sri-mark-color.svg` (light bg) · `sri-mark-white.svg` (dark bg)
- Small/profile: `sri-chip.svg` (dark bg) · `sri-chip-light.svg` (light bg)
- Favicon: `sri-favicon-32.svg`

## Note on Miniaturization
The original AI SVG cannot be scaled below ~300px without losing legibility. For all small-format use (favicons, social profiles, chips), use the simplified leaf chip icon instead.
