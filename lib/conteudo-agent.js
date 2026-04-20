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
  GBP_POST:          'Google Business Profile',
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
- contentType: one of INSTAGRAM_FEED, INSTAGRAM_REELS, INSTAGRAM_STORIES, FACEBOOK, BLOG, GBP_POST
- pillar: one of EXPERIENCIA, DESTINO, PROVA_SOCIAL, DISPONIBILIDADE, BASTIDORES, BLOG_SEO
- imagePrompt: One sentence describing the ideal photo for this post (e.g. "Aerial view of the pool surrounded by native Atlantic Forest at golden hour")

Include 1 GBP_POST per week (short, 150-300 chars, local SEO optimized with location keywords like "Jaboticatubas", "Serra do Cipó").

Return ONLY a valid JSON array, no markdown, no extra text. Example:
[{"title":"...","body":"...","contentType":"INSTAGRAM_FEED","pillar":"EXPERIENCIA","imagePrompt":"..."}]`;

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
        title:       p.title       || 'Sem título',
        body:        p.body        || null,
        contentType: p.contentType || 'INSTAGRAM_FEED',
        pillar:      p.pillar      || null,
        imagePrompt: p.imagePrompt || null,
        stage:       'GERADO',
        aiGenerated: true,
      },
    })
  ));

  return created;
}

/**
 * Regenerates a single post IN-PLACE with optional admin feedback.
 * Use createImprovedAlternative() instead when you want to preserve the original.
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

Return ONLY a JSON object: {"title":"...","body":"...","imagePrompt":"one sentence describing the ideal photo for this post"}`;

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
      title:       data.title       || post.title,
      body:        data.body        || post.body,
      imagePrompt: data.imagePrompt || post.imagePrompt || null,
      stage:       'GERADO',
      aiGenerated: true,
      updatedAt:   new Date(),
    },
  });
}

/**
 * Creates a NEW improved alternative post based on admin feedback.
 * The original post keeps its AJUSTE_NECESSARIO/REJEITADO stage so there's a
 * full audit trail. The new post references parentPostId for easy linking.
 *
 * @param {string} postId       - ID of the post that was flagged
 * @param {string} feedback     - Admin's typed feedback / reason for rejection
 * @returns {ContentPost}       - The newly created alternative post
 */
async function createImprovedAlternative(postId, feedback) {
  const post = await prisma.contentPost.findUnique({ where: { id: postId } });
  if (!post) throw new Error('Post not found');

  const client   = new Anthropic({ timeout: 30_000 });
  const brandName = BRAND_NAMES[post.brand] || post.brand;
  const season   = currentSeason();

  const userPrompt = `You are a hospitality content strategist for ${brandName}, a rural tourism property in Jaboticatubas, MG, Brazil (Serra do Cipó area). Generate content in Brazilian Portuguese.

The admin reviewed the following ${TYPE_MAP[post.contentType] || post.contentType} post and was not satisfied:

--- ORIGINAL POST ---
Title: ${post.title}
Body: ${post.body || '(empty)'}
Pillar: ${post.pillar || '(none)'}
Image prompt: ${post.imagePrompt || '(none)'}
---

Admin feedback: "${feedback}"

Current season: ${season}

Create a completely NEW and IMPROVED alternative post that addresses this feedback. Do not reuse the same title, angle, or structure as the original.

Return ONLY a JSON object:
{"title":"...","body":"...","imagePrompt":"one sentence describing the ideal photo for this post"}`;

  const message = await client.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const raw  = message.content[0]?.text || '{}';
  const data = safeParseJSON(raw, {});

  return prisma.contentPost.create({
    data: {
      brand:        post.brand,
      propertyId:   post.propertyId,
      title:        data.title       || `Alternativa: ${post.title}`,
      body:         data.body        || null,
      contentType:  post.contentType,
      pillar:       post.pillar      || null,
      imagePrompt:  data.imagePrompt || null,
      stage:        'GERADO',
      aiGenerated:  true,
      parentPostId: post.id,
      feedbackNotes: feedback || null,
    },
  });
}

/**
 * Generates a single long-form SEO blog post for RDI.
 * Called by the Monday cron in addition to the regular weekly package.
 * Produces a BLOG content type with pillar BLOG_SEO, optimised for
 * "fazenda para alugar Serra do Cipó / Jaboticatubas" search intent.
 *
 * @param {string} propertyId
 * @returns {ContentPost}
 */
async function createRdiBlogPost(propertyId) {
  const client   = new Anthropic({ timeout: 45_000 });
  const season   = currentSeason();

  // Rotate among evergreen topics each week so we don't repeat
  const topics = [
    'O que fazer em Jaboticatubas: guia completo para quem busca natureza e descanso',
    'Serra do Cipó com crianças: dicas e o que esperar numa viagem em família',
    'Sítio para alugar em Minas Gerais: como escolher o espaço perfeito para seu grupo',
    'Trilhas perto de Jaboticatubas: as melhores rotas para iniciantes e experientes',
    'Feriados em MG: onde descansar longe da cidade sem abrir mão do conforto',
    'Cachoeiras da Serra do Cipó: o guia definitivo para quem ama natureza',
    'Recanto dos Ipês: conheça o sítio mais aconchegante de Jaboticatubas',
    'Temporada de inverno na Serra do Cipó: por que o frio é o melhor momento para visitar',
  ];

  // Pick topic based on week-of-year for deterministic rotation
  const week  = Math.ceil(new Date().getDate() / 7);
  const topic = topics[(new Date().getMonth() * 4 + week - 1) % topics.length];

  const systemPrompt = `You are an SEO content writer specialising in rural tourism in Brazil. You write in natural, warm Brazilian Portuguese optimised for Google search. The property is Sítio Recanto dos Ipês, located in Jaboticatubas, MG, in the Serra do Cipó region. The property features a heated pool, private trails, full BBQ area, sleeping up to 20 guests, pet-friendly.`;

  const userPrompt = `Write a complete SEO blog post on the topic: "${topic}"

Current season: ${season}

Requirements:
- Language: Brazilian Portuguese, warm and inviting tone
- Length: 600–900 words of actual body content
- Structure: H2/H3 subheadings in the body field (use markdown)
- Include naturally: "Jaboticatubas", "Serra do Cipó", "sítio para alugar", "Recanto dos Ipês"
- End with a soft CTA paragraph mentioning the property and a booking invitation
- imagePrompt: describe the ideal hero photo for this article

Return ONLY a JSON object:
{
  "title": "SEO title (50-60 chars, includes main keyword)",
  "body": "Full markdown article body with H2/H3 headings",
  "imagePrompt": "One detailed sentence describing the hero image"
}`;

  const message = await client.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 2048,
    messages: [{ role: 'user', content: userPrompt }],
    system: systemPrompt,
  });

  const raw  = message.content[0]?.text || '{}';
  const data = safeParseJSON(raw, {});

  return prisma.contentPost.create({
    data: {
      brand:       'RDI',
      propertyId,
      title:       data.title       || topic.substring(0, 60),
      body:        data.body        || null,
      contentType: 'BLOG',
      pillar:      'BLOG_SEO',
      imagePrompt: data.imagePrompt || null,
      stage:       'GERADO',
      aiGenerated: true,
    },
  });
}

module.exports = {
  generateWeeklyPackage,
  createWeeklyPackage,
  regeneratePost,
  createImprovedAlternative,
  createRdiBlogPost,
};
