'use strict';

/**
 * Seed script — inserts 3 SEO-optimised pillar blog articles for RDI.
 *
 * Safe to re-run: skips posts whose title already exists.
 *
 * Usage (Railway one-off):
 *   railway run --service recanto-dos-ipes node scripts/seed-blog-posts.js
 *
 * Usage (local, with DATABASE_URL set):
 *   node scripts/seed-blog-posts.js
 */

const prisma = require('../lib/db');

// ── Helpers ──────────────────────────────────────────────────────────────────
const now = new Date();

function published(daysAgo = 0) {
  const d = new Date(now);
  d.setDate(d.getDate() - daysAgo);
  return d;
}

// ── Articles ─────────────────────────────────────────────────────────────────
const ARTICLES = [

  // ── ARTICLE 1 ─ DESTINO pillar ──────────────────────────────────────────
  {
    title: 'O que fazer em Jaboticatubas, MG: Guia completo de natureza e turismo',
    pillar: 'DESTINO',
    publishedAt: published(14),
    body: `# O que fazer em Jaboticatubas, MG: Guia completo de natureza e turismo

Jaboticatubas é um dos destinos mais subestimados de Minas Gerais. A apenas 70 km de Belo Horizonte, o município combina natureza exuberante, rios cristalinos e uma tranquilidade que raramente se encontra tão perto de uma capital.

Neste guia, reunimos os melhores pontos turísticos, dicas práticas e tudo que você precisa saber para aproveitar cada canto de Jaboticatubas.

## Por que visitar Jaboticatubas?

A cidade é a porta de entrada para o **Parque Nacional da Serra do Cipó**, uma das unidades de conservação mais importantes do Brasil. Com mais de 33 mil hectares de Cerrado e Mata Atlântica, o parque abriga:

- Cachoeiras de até 90 metros de queda livre
- Trilhas para todos os níveis, do iniciante ao avançado
- Uma biodiversidade incomparável: orquídeas, lobos-guará, tamanduás e mais de 400 espécies de aves

Mas Jaboticatubas oferece muito mais do que o parque.

## O que fazer em Jaboticatubas

### 1. Parque Nacional da Serra do Cipó

O destino principal. A **Cachoeira da Farofa** é a mais visitada — 90 minutos de trilha em meio ao Cerrado, terminando numa queda d'água gelada. Para quem prefere menos esforço, o **Véu da Noiva** (15 min de caminhada) é uma opção imperdível.

**Dica:** Leve protetor solar, água e tênis fechado. Nas chuvas, algumas trilhas ficam interditadas — confirme condições no portal do ICMBio antes de sair.

### 2. Balneário do Rio Cipó

O trecho do Rio Cipó dentro do município é de tirar o fôlego. Poços naturais com água transparente, ideais para banho de rio nos dias quentes de verão. A temporada vai de **outubro a março**.

### 3. Fazendas e turismo rural

Jaboticatubas tem uma forte tradição de turismo rural. Inúmeras fazendas oferecem passeios a cavalo, visitas a laticínios artesanais e gastronomia mineira genuína. O famoso **pão de queijo de forno a lenha** é obrigatório.

### 4. Mirante do Bicão

Poucos turistas conhecem esse mirante escondido nos arredores da cidade. De lá, a vista da Serra do Cipó ao entardecer é de deixar sem palavras — especialmente entre maio e agosto, quando o céu limpo cria pores do sol alaranjados.

### 5. Estrada Real

Jaboticatubas está no traçado histórico da Estrada Real, a rota do ouro colonial que ligava as minas às regiões costeiras. Para quem gosta de cicloturismo ou trekking histórico, esse é um contexto rico para explorar.

## Onde ficar em Jaboticatubas

Para grupos que querem comodidade e espaço, a melhor opção é um **sítio de aluguel por temporada** — que reúne todos no mesmo espaço, com cozinha equipada, área de lazer completa e liberdade para chegar a qualquer hora.

O **Sítio Recanto dos Ipês** fica a 15 minutos do centro de Jaboticatubas, em condomínio fechado, e oferece piscina aquecida solar, sauna elétrica a vapor, campo de futebol, salão de jogos e cozinha completa para até 20 hóspedes.

[Reserve sua estadia no Sítio Recanto dos Ipês →](/booking)

## Como chegar a Jaboticatubas

- **De BH de carro:** BR-040 + MG-010 · Aproximadamente 1h20 sem trânsito
- **De BH de ônibus:** Linha Viação Paraíso (Terminal Rodoviário de BH) · Saídas diárias
- **De São Paulo:** Cerca de 7h30 via BR-381

## Melhor época para visitar

| Período | Clima | Atividades |
|---|---|---|
| Outubro–Março | Quente e chuvoso | Rio Cipó, piscinas, festas populares |
| Abril–Setembro | Fresco e seco | Trilhas, cachoeiras, mirantes |

O inverno mineiro (junho–agosto) é o favorito de trilheiros: o tempo seco garante trilhas limpas e o frio ameno é ideal para caminhar.

## Conclusão

Jaboticatubas é a combinação perfeita de natureza, cultura e gastronomia a distância curta de Belo Horizonte. Se você está planejando uma escapada de fim de semana com família ou amigos, esse destino merece estar no topo da sua lista.

Ficou com dúvidas sobre onde ficar? [Entre em contato pelo WhatsApp](https://wa.me/553123916688) — respondemos em minutos.`,
  },

  // ── ARTICLE 2 ─ DESTINO pillar ──────────────────────────────────────────
  {
    title: 'Serra do Cipó para grupos: Como planejar a viagem perfeita para 10+ pessoas',
    pillar: 'DESTINO',
    publishedAt: published(7),
    body: `# Serra do Cipó para grupos: Como planejar a viagem perfeita para 10+ pessoas

Organizar uma viagem em grupo é sempre um desafio — horários que não batem, preferências diferentes, orçamentos variados. Mas quando o destino é a **Serra do Cipó**, a experiência vale cada minuto de planejamento.

Este guia é para quem está organizando uma viagem com 10, 15 ou até 20 pessoas para a Serra do Cipó e Jaboticatubas, MG.

## Por que a Serra do Cipó é ideal para grupos?

A Serra do Cipó oferece atividades para todos os perfis — dos que querem trilha pesada ao que preferem relaxar na piscina. Essa versatilidade é rara em destinos naturais e é o que torna a região perfeita para grupos heterogêneos.

Além disso, os aluguéis por temporada na região permitem que o grupo **divida o custo de um espaço completo**, saindo mais barato por pessoa do que reservar quartos separados em pousadas.

## Passo a passo para organizar a viagem

### 1. Defina o número exato de pessoas

Antes de qualquer reserva, confirme quantas pessoas vão. A diferença entre 12 e 18 pessoas muda tudo: o tipo de acomodação, o custo por pessoa e a logística de transporte.

**Dica:** Abra uma lista de confirmação com prazo. Defina uma data limite para confirmação e não espere por indecisos — inclua apenas quem confirmou.

### 2. Escolha a acomodação certa para grupos

Para grupos de 10 a 20 pessoas, a melhor opção é um **sítio ou casa de temporada completa**. Isso garante:

- **Cozinha equipada** para refeições coletivas (muito mais econômico que restaurante para grupos)
- **Área de lazer própria** — piscina, churrasqueira, espaço de jogos
- **Privacidade** — sem outros hóspedes no mesmo espaço
- **Liberdade de horário** — chegue quando quiser, sem check-in até às 14h

O [Sítio Recanto dos Ipês](/booking) foi pensado exatamente para esse perfil: **até 20 hóspedes**, 4 quartos com 8 camas, 3 banheiros, cozinha industrial com fogão a lenha, churrasqueira, piscina aquecida solar e sauna elétrica a vapor.

### 3. Monte um roteiro com opções para todos os perfis

**Dia 1 — Chegada e lazer no sítio**
- Check-in e instalação do grupo
- Tarde: piscina, sauna, salão de jogos
- Noite: churrasco coletivo com fogão a lenha

**Dia 2 — Trilha e natureza**
- Manhã: trilha da Cachoeira da Farofa (nível médio, 3h ida e volta)
- Ou: passeio de carro até o Véu da Noiva (acessível para todos os perfis)
- Tarde: retorno ao sítio, banho de piscina
- Noite: jantar coletivo, rodada de jogos

**Dia 3 — Manhã livre e check-out**
- Café da manhã tranquilo
- Check-out até 12h (ou combinar horário estendido)

### 4. Divida as tarefas

Em grupos grandes, a organização é chave. Defina com antecedência:

- **Responsável de compras:** lista de mantimentos para o fim de semana
- **Responsável de transporte:** combinar caronas ou fretamento de van
- **Responsável financeiro:** coleta do rateio antes da viagem, não depois
- **Responsável de atividades:** reservas de trilha guiada se necessário

### 5. Calcule o custo por pessoa

A regra geral: quanto maior o grupo, menor o custo por pessoa.

Para um sítio com capacidade de 20 hóspedes em Jaboticatubas, a faixa de preço fica entre:

- **R$720–R$1.300/noite** dependendo da temporada
- Dividido entre 15 pessoas = **R$48–R$87/pessoa/noite**
- Um fim de semana completo (2 noites) = **R$96–R$174/pessoa**

Para comparação: uma diária em pousada na região sai entre R$180 e R$320/pessoa.

## O que levar para a Serra do Cipó em grupo

- **Comida e bebida** (o sítio tem cozinha completa — é mais barato levar do que comer fora)
- **Protetor solar e repelente**
- **Roupas para trilha** (tênis fechado, calça comprida)
- **Roupas quentes** — noites frias mesmo no verão
- **Boia e óculos de natação** para a piscina

## Atividades coletivas na Serra do Cipó

| Atividade | Duração | Nível | Custo estimado |
|---|---|---|---|
| Cachoeira da Farofa | 3h | Médio | Gratuita (taxa parque) |
| Véu da Noiva | 1h | Fácil | Gratuita |
| Banho no Rio Cipó | Livre | Fácil | Gratuita |
| Canionismo no Cipó | 4–6h | Avançado | R$80–R$150/pessoa |
| Passeio a cavalo | 1–2h | Fácil | R$50–R$80/pessoa |

## Dúvidas frequentes sobre viagem em grupo

**Quantas vagas tem o parque por dia?**
A Serra do Cipó tem controle de visitantes em alta temporada. Recomendamos reservar o acesso com antecedência pelo portal do ICMBio.

**Vale contratar um guia?**
Para grupos acima de 10 pessoas em trilhas de mais de 2h, um guia local é altamente recomendado. Além da segurança, o guia conta histórias da região que enriquecem a experiência.

**Como resolver transporte para o grupo?**
Para grupos de 10–20 pessoas, uma van ou micro-ônibus fretado de BH sai em conta. Verifique opções de fretamento no terminal de BH ou peça indicação na hospedagem.

---

Pronto para organizar a viagem? [Verifique disponibilidade e reserve o Sítio Recanto dos Ipês →](/booking)

Tem dúvidas sobre a acomodação para o seu grupo? [Fale pelo WhatsApp](https://wa.me/553123916688) — respondemos em minutos.`,
  },

  // ── ARTICLE 3 ─ EXPERIENCIA pillar ──────────────────────────────────────
  {
    title: 'Fim de semana perfeito saindo de Belo Horizonte: Serra do Cipó e Jaboticatubas em 2 dias',
    pillar: 'EXPERIENCIA',
    publishedAt: published(3),
    body: `# Fim de semana perfeito saindo de Belo Horizonte: Serra do Cipó e Jaboticatubas em 2 dias

Belo Horizonte tem um segredo bem guardado: a menos de 1h30 da capital, existe um destino de natureza intensa, gastronomia mineira de verdade e uma tranquilidade que a cidade não oferece. O nome é **Jaboticatubas**, e a rota passa pela Serra do Cipó.

Se você tem um fim de semana livre e quer sair de BH sem rodar horas, este roteiro é para você.

## Por que escolher Jaboticatubas no fim de semana?

- **Distância:** 70 km de BH — menos de 1h30 sem trânsito
- **Natureza:** trilhas, cachoeiras, rio cristalino, Cerrado e Mata Atlântica
- **Estrutura:** acomodações modernas com toda a conforto
- **Custo:** muito mais acessível que voos ou longas viagens
- **Tempo:** o roteiro de 2 dias aproveita cada hora sem stress

## Roteiro de 2 dias — sexta à noite a domingo à tarde

### Sexta-feira — Chegada e descompressão

**18h–20h:** Saída de BH pela MG-010 sentido Lagoa Santa / Jaboticatubas. O trânsito de sexta à noite pode atrasar — planeje sair depois das 18h ou após as 21h para evitar o pico.

**20h–21h:** Chegada ao sítio. Se você está hospedado no [Sítio Recanto dos Ipês](/booking), o self check-in permite chegar a qualquer hora — sem esperar ninguém.

**21h–23h:** Jantar no fogão a lenha. Uma das experiências mais autênticas da viagem. O fogo a lenha muda completamente o sabor dos alimentos — experimente fritar ovos e assar carne diretamente na brasa.

**23h–00h:** Sauna elétrica a vapor para relaxar após a semana. A diferença de temperatura entre a sauna (80–90°C) e a piscina aquecida (28°C) cria um efeito chamado de "contraste térmico" — excelente para músculo e sono.

### Sábado — Dia na natureza

**7h30:** Café da manhã. A cozinha completa do sítio tem tudo que você precisa — leve pão de queijo, goiabada e café coado para uma manhã mineira de verdade.

**9h:** Saída para o **Parque Nacional da Serra do Cipó**. A entrada principal fica a 30 minutos do sítio.

**9h30–12h30:** Trilha da **Cachoeira da Farofa** — a mais famosa do parque. São cerca de 6 km ida e volta em terreno leve, com duas cachoeiras no caminho. A maior delas tem 90 metros de queda — é uma das mais altas de Minas Gerais.

> "A cachoeira no final da trilha compensa cada passo. A água gelada e a névoa no ar criam uma atmosfera mágica." — Ana Luísa, São Paulo

**12h30–14h:** Almoço no restaurante regional próximo ao parque (ou de volta ao sítio, se você levou comida para churrasco).

**14h–18h:** Tarde livre no sítio. Piscina, campo de futebol, sinuca, totó, descanso.

**19h–22h:** Churrasco coletivo. Com a churrasqueira coberta e o fogão a lenha, o sítio tem estrutura completa para fazer o melhor churrasco da viagem.

### Domingo — Manhã no rio e retorno

**8h:** Café da manhã tranquilo.

**9h30–12h:** **Balneário do Rio Cipó** — o trecho acessível ao público tem poços naturais com fundo de pedra e água transparente. Ideal para banho de rio antes do retorno.

**12h30:** Check-out do sítio e início do retorno para BH.

**14h–15h30:** Chegada a BH — em tempo para aproveitar o domingo à noite.

## Dicas práticas para o roteiro

### O que levar
- Comida e bebida para o fim de semana (muito mais econômico que comer fora)
- Roupa de banho e toalha
- Tênis fechado para trilha
- Protetor solar e repelente
- Casaco para a noite (mesmo no verão, Jaboticatubas tem noites frescas)

### Melhor época
- **Verão (novembro–março):** mais quente, rios cheios, trilhas mais difíceis por causa da lama
- **Inverno (maio–agosto):** trilhas secas e limpas, menos turistas, frio à noite — perfeito para sauna

### Como sair de BH sem stress
- **De carro:** MG-010 ou BR-040 + MG-010 · Navegador recomendado: Waze (MG-010 pode ter obras)
- **De ônibus:** Viação Paraíso, Terminal Rodoviário de BH

## Por que o Sítio Recanto dos Ipês é a escolha certa para este roteiro

O sítio foi desenhado para quem quer conforto sem abrir mão da experiência rural:

- **Self check-in:** chegue quando quiser, sem depender de horário
- **Cozinha completa com fogão a lenha:** a experiência mineira de verdade
- **Piscina aquecida solar:** disponível em qualquer época do ano
- **Sauna elétrica a vapor:** relaxamento garantido após trilha
- **Localização:** 15 min do centro de Jaboticatubas, 30 min da entrada do Parque Nacional
- **Capacidade:** até 20 hóspedes — ideal para grupos de amigos ou família grande

[Verificar disponibilidade e reservar →](/booking)

---

Tem alguma dúvida sobre o roteiro ou sobre a hospedagem? [Fale pelo WhatsApp](https://wa.me/553123916688) — respondemos rápido.`,
  },
];

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('Seeding blog posts for RDI…\n');

  // Find the RDI property
  const property = await prisma.property.findFirst({
    where: { type: 'SITIO' },
    select: { id: true, name: true },
  });

  if (!property) {
    throw new Error('RDI property not found. Run seed-pricing.js or ensure a SITIO property exists.');
  }

  console.log(`Found property: ${property.name} (${property.id})\n`);

  let created = 0;
  let skipped = 0;

  for (const article of ARTICLES) {
    const existing = await prisma.contentPost.findFirst({
      where: { title: article.title, brand: 'RDI' },
    });

    if (existing) {
      console.log(`  ↩  SKIP  "${article.title.slice(0, 60)}…"`);
      skipped++;
      continue;
    }

    await prisma.contentPost.create({
      data: {
        brand:        'RDI',
        propertyId:   property.id,
        title:        article.title,
        body:         article.body,
        contentType:  'BLOG',
        pillar:       article.pillar,
        stage:        'PUBLICADO',
        aiGenerated:  false,
        publishedAt:  article.publishedAt,
      },
    });

    console.log(`  ✔  CREATED  "${article.title.slice(0, 60)}…"`);
    created++;
  }

  console.log(`\nDone — ${created} created, ${skipped} skipped.`);
}

main()
  .catch(err => { console.error('[seed-blog] failed:', err); process.exit(1); })
  .finally(() => prisma.$disconnect());
