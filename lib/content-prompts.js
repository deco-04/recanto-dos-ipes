'use strict';

/**
 * Prompt scaffolding for the weekly content agent.
 *
 * Separated from conteudo-agent.js so unit tests can pin every block that
 * needs to land in the final prompt (voice, RDI truths, seasonal hook,
 * learning loop, channel filter) without mocking Anthropic.
 */

// ── System prompt (stable across calls) ─────────────────────────────────────
function buildWeeklySystemPrompt() {
  return `Você é um estrategista de conteúdo para hospedagem rural de alto padrão, escrevendo em português (pt-BR).

PILARES (framework DECO de 7 pilares):
  - EXPERIENCIA   — o que o hóspede sente/vive no local.
  - DESTINO       — Serra do Cipó, Jaboticatubas, arredores.
  - PROVA_SOCIAL  — depoimentos, resenhas, fotos de família.
  - DISPONIBILIDADE — convites para datas específicas / pacotes.
  - BASTIDORES    — equipe, manutenção, cuidado com a propriedade.
  - BLOG_SEO      — posts longos de autoridade local e busca orgânica.

ESTRUTURA OBRIGATÓRIA PARA BLOG_SEO (contentType = BLOG):
  1. H1 título com palavra-chave de cauda longa (geográfica + intenção).
  2. 3–5 seções H2 (subtópicos concretos, não abstrações).
  3. Corpo entre 600 e 900 palavras, parágrafos curtos (máx. 3 linhas).
  4. Um bloco FAQ com 2–3 perguntas reais de hóspede no final.
  5. Placeholder para link interno (ex.: "[link para reservas]").
  6. Meta-description implícita no primeiro parágrafo (≤ 160 caracteres úteis).

REGRAS DE VOZ:
  - Concreto antes de abstrato. Detalhes sensoriais antes de adjetivos.
  - Nunca prometa o que não está na lista de amenities.
  - Nunca invente preços/horários. Usar apenas os fornecidos em "VERDADES DA PROPRIEDADE".
  - Finalizar com um convite claro (CTA), não com um cliché tipo "venha nos visitar".

FORMATO DA RESPOSTA:
  JSON array. Cada item:
    { title, body, contentType, pillar, imagePrompt, suggestedHashtags }
  contentType ∈ INSTAGRAM_FEED | INSTAGRAM_REELS | INSTAGRAM_STORIES | FACEBOOK | BLOG | GBP_POST
  pillar      ∈ EXPERIENCIA | DESTINO | PROVA_SOCIAL | DISPONIBILIDADE | BASTIDORES | BLOG_SEO`;
}

// ── Seasonal hook ──────────────────────────────────────────────────────────
// Month is 0-indexed (same as Date.getMonth()).
function seasonalHookForMonth(month) {
  const hooks = [
    // Jan (0) — pico de verão + preparação pro Carnaval
    'verão em pleno vapor, pico de ocupação, preparar pauta Carnaval com antecedência',
    // Feb (1) — Carnaval + chuvas de verão
    'Carnaval e chuvas de verão; cachoeiras com volume d\'água alto',
    // Mar (2) — outono começa, Semana Santa pode cair aqui
    'início do outono, temperaturas mais amenas, possivelmente Semana Santa',
    // Apr (3) — outono, Semana Santa
    'outono: temperatura amena, Semana Santa costuma esgotar datas',
    // May (4) — outono seco, clima perfeito
    'outono seco com céu azul: clima ideal para trilhas e piscina natural',
    // Jun (5) — friozinho começa, festas juninas
    'junho friozinho na serra, festas juninas regionais, foco em lareira e chocolate quente',
    // Jul (6) — inverno + férias escolares
    'inverno com férias escolares: pico de famílias, destacar lareira, pé-de-moleque, jogos',
    // Aug (7) — inverno seco, trilhas ótimas
    'inverno seco: trilhas e cachoeiras visíveis a longa distância',
    // Sep (8) — primavera, ipês floridos
    'primavera: ipês floridos no caminho, natureza colorida, desanuviada',
    // Oct (9) — primavera, temperaturas sobem
    'primavera com temperaturas subindo; piscina volta a ser protagonista',
    // Nov (10) — proximidade de verão + feriado 20/11
    'calor chegando, feriado de 20/11 prolongado, início da temporada alta',
    // Dec (11) — Natal + Réveillon
    'dezembro: Natal em família, Réveillon sold-out histórico, anunciar com 60 dias',
  ];
  return hooks[month] || hooks[0];
}

// ── User prompt (changes every week) ───────────────────────────────────────
function buildWeeklyUserPrompt({
  brand,
  config,
  recentTitles   = [],
  recentFeedback = [],
  topPillars     = [],        // [{ pillar, approvalRate, total }] — from content-history
  seasonalHook,
  propertyTruths = {},
  contentTypes,        // optional filter ['BLOG'] | ['INSTAGRAM_FEED', 'FACEBOOK'] etc.
  count,               // optional integer, overrides config.postsPerWeek
}) {
  const finalCount = Number.isInteger(count) ? count : (config?.postsPerWeek || 5);

  const pillarLines = Object.entries(config?.pillarMix || {})
    .map(([pillar, pct]) => `  - ${pillar}: ${pct}%`)
    .join('\n') || '  - (usar distribuição padrão)';

  const truthsBlock = [
    propertyTruths.location      && `LOCALIZAÇÃO: ${propertyTruths.location}`,
    propertyTruths.distanceFromBH && `DISTÂNCIA DE BH: ${propertyTruths.distanceFromBH}`,
    Array.isArray(propertyTruths.amenities) && propertyTruths.amenities.length
      ? `AMENITIES: ${propertyTruths.amenities.join(', ')}`
      : null,
    propertyTruths.pricingTiers
      ? `TIERS DE PREÇO (R$/noite): ${Object.entries(propertyTruths.pricingTiers).map(([t, v]) => `${t}=${v}`).join(' · ')}`
      : null,
  ].filter(Boolean).join('\n');

  const recentTitlesBlock = recentTitles.length
    ? `\nTÍTULOS RECENTES — não repetir nem parafrasear:\n${recentTitles.map(t => `  - ${t}`).join('\n')}`
    : '';

  const feedbackBlock = recentFeedback.length
    ? `\nFEEDBACK RECENTE DA ADMIN (evitar padrões que ela rejeitou):\n${recentFeedback.map(f => `  - "${f.title}": ${f.feedbackNotes}`).join('\n')}`
    : '';

  // Performance signal: pillars the admin has approved most (last 60d).
  // Tell the model to LEAN INTO these, not *only* produce them — pillar mix
  // configured by the admin still holds, this just biases within the mix.
  const topPillarsBlock = Array.isArray(topPillars) && topPillars.length
    ? `\nPERFORMANCE RECENTE (últimos 60 dias, ordenado por taxa de aprovação):\n${topPillars.slice(0, 4).map(p => `  - ${p.pillar}: ${p.approvalRate}% aprovados (${p.approved}/${p.total})`).join('\n')}\nAo compor o pacote, puxe mais ideias dos pilares com taxa mais alta — sem violar o mix configurado acima.`
    : '';

  const channelFilter = Array.isArray(contentTypes) && contentTypes.length
    ? `\nFILTRO DE CANAL: gerar apenas posts do(s) contentType(s): ${contentTypes.join(', ')}.`
    : '';

  return [
    `MARCA: ${brand}`,
    ``,
    `VERDADES DA PROPRIEDADE (não-negociáveis, nunca inventar outras):`,
    truthsBlock || '  (nenhuma — pedir ao admin para preencher BrandContentConfig)',
    ``,
    `VOZ DE MARCA: ${config?.voiceNotes || '(não configurada)'}`,
    `TEMAS DA SEMANA: ${config?.upcomingThemes || '(livres)'}`,
    `HASHTAGS PADRÃO: ${config?.defaultHashtags || ''}`,
    ``,
    `GANCHO SAZONAL (mês atual):`,
    `  ${seasonalHook}`,
    ``,
    `DISTRIBUIÇÃO DE PILARES DESEJADA:`,
    pillarLines,
    `${recentTitlesBlock}`,
    `${feedbackBlock}`,
    `${topPillarsBlock}`,
    `${channelFilter}`,
    ``,
    `Gere ${finalCount} posts.`,
    `Retorne apenas o JSON array, sem comentários fora dele.`,
  ].join('\n');
}

module.exports = {
  buildWeeklySystemPrompt,
  buildWeeklyUserPrompt,
  seasonalHookForMonth,
};
