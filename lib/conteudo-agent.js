'use strict';

/**
 * AI Content Agent — Agente Vera-RDS
 *
 * Generates weekly content packages for each brand (RDI/RDS/CDS)
 * using Claude claude-sonnet-4-6. Adapts DECO's Vera content engine for hospitality.
 *
 * Content pillars (6-type rotation):
 *   EXPERIENCIA   — specific property highlight (pool, breakfast, cabin, trail)
 *   DESTINO       — local area content (Serra do Cipó, trilhas, Jaboticatubas)
 *   PROVA_SOCIAL  — guest reviews, testimonials, UGC
 *   DISPONIBILIDADE — booking push, feriados, seasonal
 *   BASTIDORES    — behind-the-scenes, property care, team
 *   BLOG_SEO      — long-form local guide outline
 */

const Anthropic = require('@anthropic-ai/sdk');
const prisma    = require('./db');

const BRAND_NAMES = {
  RDI: 'Sítio Recanto dos Ipês',
  RDS: 'Recantos da Serra',
  CDS: 'Cabanas da Serra',
};

const PILLAR_ROTATION = ['EXPERIENCIA', 'DESTINO', 'PROVA_SOCIAL', 'DISPONIBILIDADE', 'BASTIDORES', 'BLOG_SEO'];

const TYPE_MAP = {
  INSTAGRAM_FEED:    'Instagram Feed',
  INSTAGRAM_REELS:   'Instagram Reels',
  INSTAGRAM_STORIES: 'Instagram Stories',
  FACEBOOK:          'Facebook',
  BLOG:              'Blog (SEO)',
};

/**
 * Safely parses JSON from Claude's response, stripping markdown code fences if present.
 */
function safeParseJSON(raw, fallback) {
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    return JSON.parse(cleaned);
  } catch {
    return fallback;
  }
}

function currentSeason() {
  const month = new Date().getMonth() + 1; // 1-12
  if (month >= 3 && month <= 5)  return 'outono';
  if (month >= 6 && month <= 8)  return 'inverno';
  if (month >= 9 && month <= 11) return 'primavera';
  return 'verão';
}

/**
 * Generates a weekly content package for a brand.
 * @param {string} brand    - 'RDI' | 'RDS' | 'CDS'
 * @param {object} config   - BrandContentConfig record
 * @param {object} context  - { upcomingBookings, recentPostTitles }
 * @returns {Array}         - Array of { title, body, contentType, pillar } objects
 */
async function generateWeeklyPackage(brand, config, context) {
  const client = new Anthropic({ timeout: 30_000 });
  const brandName = BRAND_NAMES[brand] || brand;
  const season = currentSeason();

  const pillarMix   = config.pillarMix   ? JSON.stringify(config.pillarMix)   : 'equal distribution';
  const postsPerWeek = config.postsPerWeek || 5;
  const voiceNotes   = config.voiceNotes || 'Warm, genuine, nature-focused. Portuguese (Brazilian).';
  const themes       = config.upcomingThemes || 'No specific upcoming themes provided.';
  const hashtags     = config.defaultHashtags || '';
  const recentTitles = context.recentPostTitles?.length
    ? context.recentPostTitles.join(', ')
    : 'None yet.';

  const systemPrompt = `You are a hospitality content strategist generating a weekly social media content package for ${brandName}, a rural tourism property in Jaboticatubas, MG, Brazil (Serra do Cipó area). Generate content in Brazilian Portuguese.`;

  const userPrompt = `Generate a weekly content package of ${postsPerWeek} posts for ${brandName}.

Current season: ${season}
Brand voice: ${voiceNotes}
Upcoming themes: ${themes}
Pillar distribution: ${pillarMix}
Hashtags to include: ${hashtags}
Recent posts (avoid repetition): ${recentTitles}

For each post return a JSON object with:
- title: Short descriptive title (max 60 chars)
- body: Full caption/content (ready to publish, including hashtags if applicable)
- contentType: one of INSTAGRAM_FEED, INSTAGRAM_REELS, INSTAGRAM_STORIES, FACEBOOK, BLOG
- pillar: one of EXPERIENCIA, DESTINO, PROVA_SOCIAL, DISPONIBILIDADE, BASTIDORES, BLOG_SEO

Return ONLY a valid JSON array, no markdown, no extra text. Example:
[{"title":"...","body":"...","contentType":"INSTAGRAM_FEED","pillar":"EXPERIENCIA"}]`;

  const message = await client.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [{ role: 'user', content: userPrompt }],
    system: systemPrompt,
  });

  const raw = message.content[0]?.text || '[]';
  const posts = safeParseJSON(raw, []);

  if (!Array.isArray(posts)) throw new Error('AI returned non-array response');
  return posts;
}

/**
 * Creates a ContentPost DB record and triggers weekly package for a brand.
 */
async function createWeeklyPackage(brand, propertyId) {
  // Load config
  const config = await prisma.brandContentConfig.findFirst({
    where: { brand, propertyId },
  }) || {};

  // Get recent post titles (avoid repetition)
  const recentPosts = await prisma.contentPost.findMany({
    where:   { brand, propertyId },
    orderBy: { createdAt: 'desc' },
    take:    4,
    select:  { title: true },
  });

  const context = {
    recentPostTitles: recentPosts.map(p => p.title),
  };

  const posts = await generateWeeklyPackage(brand, config, context);

  // Store in DB
  const created = await Promise.all(posts.map(p =>
    prisma.contentPost.create({
      data: {
        brand,
        propertyId,
        title:       p.title || 'Sem título',
        body:        p.body  || null,
        contentType: p.contentType || 'INSTAGRAM_FEED',
        pillar:      p.pillar      || null,
        stage:       'GERADO',
        aiGenerated: true,
      },
    })
  ));

  return created;
}

/**
 * Regenerates a single post with optional admin feedback.
 */
async function regeneratePost(postId, adminFeedback) {
  const post = await prisma.contentPost.findUnique({ where: { id: postId } });
  if (!post) throw new Error('Post not found');

  const client = new Anthropic({ timeout: 30_000 });
  const brandName = BRAND_NAMES[post.brand] || post.brand;

  const userPrompt = `Regenerate this ${TYPE_MAP[post.contentType] || post.contentType} post for ${brandName}.

Current content:
Title: ${post.title}
Body: ${post.body || '(empty)'}
Pillar: ${post.pillar || '(none)'}
${adminFeedback ? `\nAdmin feedback: ${adminFeedback}` : ''}

Return ONLY a JSON object: {"title":"...","body":"..."}`;

  const message = await client.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const raw  = message.content[0]?.text || '{}';
  const data = safeParseJSON(raw, {});

  return prisma.contentPost.update({
    where: { id: postId },
    data: {
      title:       data.title || post.title,
      body:        data.body  || post.body,
      stage:       'GERADO',
      aiGenerated: true,
      updatedAt:   new Date(),
    },
  });
}

module.exports = { generateWeeklyPackage, createWeeklyPackage, regeneratePost };
