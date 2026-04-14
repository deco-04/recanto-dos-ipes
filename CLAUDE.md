# CLAUDE.md — Sítio Recanto dos Ipês
*Website público e sistema de gestão da propriedade rural*

---

## STACK

- **Runtime:** Node.js + Express
- **ORM:** Prisma
- **Frontend:** HTML/CSS + templates server-side
- **Deploy:** Railway (`railway.toml` na raiz — `main` → produção automática)
- **Comandos:** `npm start` · `node server.js` · `npx prisma studio` · `npx prisma migrate dev`

---

## IDENTIDADE VISUAL

| Token | Cor | Uso |
|---|---|---|
| Verde Floresta | `#2B7929` | Cor primária, CTAs |
| Verde Lima | `#C5D86D` | Cor secundária, destaques |

- **Logos:** em `brand/logo-system/` — prefixo `sri-`
- Variantes disponíveis: horizontal com/sem tagline, mark, chip (ver `BRAND_INDEX.md`)

---

## ESTRUTURA DE PASTAS

```
server.js       ← Entry point principal (Express)
routes/         ← Rotas da API e páginas
lib/            ← Utilitários e helpers
prisma/         ← Schema e migrations do banco
uploads/        ← Uploads de imagens (não versionar arquivos aqui)
brand/          ← Assets de marca (SVGs, cores)
docs/           ← Documentação do projeto
.env            ← Variáveis de ambiente (NUNCA commitar)
.env.example    ← Template de variáveis (sempre manter atualizado)
railway.toml    ← Configuração de deploy Railway
```

---

## DEPLOY & AMBIENTE

- Variáveis de ambiente via Railway Variables (nunca no código)
- `.env` local para desenvolvimento — nunca commitar
- `.env.example` é a referência — manter sincronizado com todas as chaves necessárias
- Logs de produção: `railway logs --tail`

---

## SEGURANÇA

- Validar todos os inputs de formulário antes de queries Prisma
- Uploads: validar tipo e tamanho antes de salvar em `uploads/`
- Webhooks externos: validar HMAC signature
