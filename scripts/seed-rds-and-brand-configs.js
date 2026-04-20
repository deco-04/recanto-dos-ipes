'use strict';

/**
 * Idempotent seed that:
 *   1. Creates the missing "Recantos da Serra" (RDS) Property row so the
 *      brand-to-slug lookup in routes/content.js can find it.
 *   2. Upserts a BrandContentConfig for each of the three brands
 *      (RDI, RDS, CDS) with sensible voice notes, upcoming themes,
 *      pillar mix, default hashtags, and posts-per-week so the weekly
 *      content agent has something real to work from out of the box.
 *
 * Safe to re-run — Property is keyed on slug @unique and
 * BrandContentConfig is keyed on @@unique([brand, propertyId]).
 *
 * Usage (Railway one-off):
 *   railway ssh --service recanto-dos-ipes "node scripts/seed-rds-and-brand-configs.js"
 */

const prisma = require('../lib/db');

// ── Property seed ───────────────────────────────────────────────────────────
const RDS_SEED = {
  slug:     'recantos-da-serra',
  name:     'Recantos da Serra',
  type:     'CABANA_COMPLEX',
  city:     'Lima Duarte',
  state:    'MG',
  hasPool:  false,
  websiteUrl: 'https://recantosdaserra.com',
  active:   true,
};

// ── Brand voice defaults ────────────────────────────────────────────────────
// Written in pt-BR since every output post will be in pt-BR. Feel free to
// edit later from the staff app → /admin/conteudo → brand gear → voice.
const BRAND_DEFAULTS = {
  RDI: {
    voiceNotes:
      'Calmo, acolhedor, enraizado na natureza. Fala do sítio como uma casa de família ampliada — detalhes sensoriais (cheiro da mata, café da manhã mineiro na varanda, som de cachoeira) sempre antes de adjetivos. Português mineiro, sem regionalismo forçado. Evita clichê tipo "fuja da rotina". Usa "você" (informal), nunca "vocês" plural cerimonioso.',
    upcomingThemes:
      'Alta temporada família (verão), Semana Santa, férias de julho, feriados prolongados, Réveillon no sítio, pacotes de fim de semana saindo de BH.',
    pillarMix:       { EXPERIENCIA: 35, DESTINO: 20, PROVA_SOCIAL: 15, DISPONIBILIDADE: 10, BASTIDORES: 10, BLOG_SEO: 10 },
    postsPerWeek:    5,
    defaultHashtags: '#JaboticatubasMG #SerraDoCipo #TurismoRural #MinasGerais #RecantoDosIpes',
  },
  RDS: {
    voiceNotes:
      'Inspirador, calmo, um tom acima do íntimo. Posiciona o grupo "Recantos da Serra" como o guarda-chuva das três propriedades — fala de experiências complementares entre Sítio e Cabanas. Conteúdo de autoridade regional (Serra do Cipó, trilhas, cachoeiras) com elegância. Menos promocional, mais narrativa.',
    upcomingThemes:
      'Calendário regional (Festival Vale do Cipó, Agosto de Sensações), roteiros combinados entre propriedades, bastidores da operação, destaques sazonais da serra.',
    pillarMix:       { EXPERIENCIA: 25, DESTINO: 30, PROVA_SOCIAL: 15, DISPONIBILIDADE: 10, BASTIDORES: 10, BLOG_SEO: 10 },
    postsPerWeek:    4,
    defaultHashtags: '#RecantosDaSerra #SerraDoCipo #JaboticatubasMG #MinasGerais #TurismoRural',
  },
  CDS: {
    voiceNotes:
      'Quieto, privativo, contemporâneo. Fala das cabanas como refúgio para casal ou dupla — foco em silêncio, lareira, vista. Tom mais adulto que o RDI. Evita cenas barulhentas (churrasco grande, crianças correndo). Destaca design da cabana, produtos de banho, amenidades premium.',
    upcomingThemes:
      'Inauguração e obra em andamento, preview das cabanas, bastidores da construção, reserva antecipada para 2026, aniversário de casal / lua de mel.',
    pillarMix:       { EXPERIENCIA: 30, DESTINO: 20, PROVA_SOCIAL: 10, DISPONIBILIDADE: 15, BASTIDORES: 15, BLOG_SEO: 10 },
    postsPerWeek:    3,
    defaultHashtags: '#CabanasDaSerra #SerraDoCipo #RefugioNaSerra #CabanaRomantica #MinasGerais',
  },
};

const BRAND_TO_SLUG = {
  RDI: 'recanto-dos-ipes',
  RDS: 'recantos-da-serra',
  CDS: 'cabanas-da-serra',
};

async function upsertRdsProperty() {
  const existing = await prisma.property.findUnique({
    where:  { slug: RDS_SEED.slug },
    select: { id: true, active: true },
  });
  if (existing) {
    if (!existing.active) {
      await prisma.property.update({ where: { id: existing.id }, data: { active: true } });
      console.log(`[seed-rds] re-activated RDS property ${existing.id}`);
    } else {
      console.log(`[seed-rds] RDS property already active (${existing.id}) — no-op`);
    }
    return existing.id;
  }
  const created = await prisma.property.create({ data: RDS_SEED });
  console.log(`[seed-rds] created RDS property ${created.id}`);
  return created.id;
}

async function upsertBrandConfigs() {
  let created = 0, updated = 0;
  for (const [brand, defaults] of Object.entries(BRAND_DEFAULTS)) {
    const property = await prisma.property.findUnique({
      where:  { slug: BRAND_TO_SLUG[brand] },
      select: { id: true },
    });
    if (!property) { console.warn(`[seed-brand] no property for ${brand} (slug=${BRAND_TO_SLUG[brand]}), skipping`); continue; }

    const existing = await prisma.brandContentConfig.findUnique({
      where: { brand_propertyId: { brand, propertyId: property.id } },
    });

    if (existing) {
      // Only fill in blanks — don't overwrite fields the admin may have edited.
      const patch = {};
      if (!existing.voiceNotes)      patch.voiceNotes      = defaults.voiceNotes;
      if (!existing.upcomingThemes)  patch.upcomingThemes  = defaults.upcomingThemes;
      if (!existing.defaultHashtags) patch.defaultHashtags = defaults.defaultHashtags;
      if (!existing.pillarMix || Object.keys(existing.pillarMix).length === 0) patch.pillarMix = defaults.pillarMix;
      if (Object.keys(patch).length === 0) { console.log(`[seed-brand] ${brand}: nothing to backfill`); continue; }
      await prisma.brandContentConfig.update({ where: { id: existing.id }, data: patch });
      console.log(`[seed-brand] ${brand}: backfilled ${Object.keys(patch).join(', ')}`);
      updated += 1;
    } else {
      await prisma.brandContentConfig.create({
        data: {
          brand,
          propertyId: property.id,
          voiceNotes:      defaults.voiceNotes,
          upcomingThemes:  defaults.upcomingThemes,
          pillarMix:       defaults.pillarMix,
          postsPerWeek:    defaults.postsPerWeek,
          defaultHashtags: defaults.defaultHashtags,
        },
      });
      console.log(`[seed-brand] ${brand}: created default config`);
      created += 1;
    }
  }
  console.log(`[seed-brand] done · created=${created} · patched=${updated}`);
}

async function main() {
  await upsertRdsProperty();
  await upsertBrandConfigs();
}

main()
  .catch(err => { console.error('[seed-rds-and-brand-configs] failed:', err); process.exit(1); })
  .finally(() => prisma.$disconnect());
