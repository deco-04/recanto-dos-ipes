# Content Automation — Audit & Gap Register
*Audit pass: 2026-04-21. Scope: AI content approval pipeline across SRI backend + staff app.*

This document catalogues gaps found in the content-approval automation.
"Small" gaps were fixed in the same commit that ships this file;
"Medium" / "Large" gaps are left for a future dedicated session.

## Inventory (evidence for the audit)

### SRI `routes/content.js` endpoints
| Method | Path | Behavior |
|---|---|---|
| GET | `/analytics` | Dashboard metrics (approval %, turnaround, top pillar) |
| GET | `/pending-count` | Badge count — GERADO + EM_REVISAO + AJUSTE + REJEITADO |
| GET | `/` | Posts grouped by stage, with parentTitle resolved server-side |
| PATCH | `/:id` | Update body/stage; auto-publish BLOG, auto-schedule social via GHL, auto-gen alternative on rejection |
| POST | `/:id/regenerar` | In-place regeneration with optional feedback |
| POST | `/:id/alternativa` | NEW child post with feedback (feedback is required) |
| POST | `/:id/comentar` | Add staff comment, push to ADMIN |
| DELETE | `/:id` | Cancel GHL post + delete row (admin only) |
| GET | `/config/:brand` | Read BrandContentConfig |
| PUT | `/config/:brand` | Upsert BrandContentConfig (admin only) |
| POST | `/gerar-agora/:brand` | Manual weekly package trigger (admin only) |
| POST | `/gerar-blog-rdi` | Manual single blog trigger (admin only) |
| GET | `/posts` · `/posts/:id` | Public blog feed (no auth) |

### Staff-app components
`components/admin/content/` : `ContentBoard.tsx`, `ContentCard.tsx`, `ContentDetail.tsx`, `BrandConfigSheet.tsx`, `GerarPicker.tsx`, `ContentAnalyticsCard.tsx`. Mounted at `app/admin/conteudo/page.tsx`.

### Prisma models
`BrandContentConfig` (voiceNotes, upcomingThemes, pillarMix, postsPerWeek, postingSchedule, defaultHashtags, imageLibraryUrl, aiImageFallback) · `ContentPost` (stage machine GERADO→EM_REVISAO→APROVADO→AGENDADO→PUBLICADO with AJUSTE_NECESSARIO/REJEITADO side-lanes; feedbackNotes, parentPostId, ghlPostId, scheduledFor, publishedAt, mediaUrls, imagePrompt) · `ContentComment`.

### External touch points
GHL Social Planner (`lib/ghl-social.js` — Instagram/Facebook/GBP) · Google Drive API v3 (`lib/drive-images.js`) · Claude Sonnet 4.6 (`lib/conteudo-agent.js`) · OpenAI gpt-image-1 AI fallback (`lib/ai-image-generator.js`) · RDS public site blog sync (`lib/sync-rds.js`).

## Gap Register

| # | Gap | Location | Fix type | Scope | Status |
|---|---|---|---|---|---|
| 1 | `pushBlogPostToRds` imported but never called; approved BLOG posts never reach the RDS public-site Articles table | `routes/content.js` BLOG→PUBLICADO branch | Fire-and-forget call after update | Small | FIXED in this commit |
| 2 | `scheduledFor` column exists on `ContentPost` but no UI lets admin set it; GHL always receives `tomorrow 10:00` fallback | `ContentDetail.tsx`, `ghl-social.js:schedulePost` | Add date/time picker + wire through PATCH | Medium | Deferred |
| 3 | `BrandContentConfig.postingSchedule` JSON field exists but `schedulePost` ignores it — picks tomorrow-10:00 regardless | `lib/ghl-social.js` | Consume postingSchedule to spread posts across the week | Medium | Deferred |
| 4 | AGENDADO cards never auto-transition to PUBLICADO — GHL is canonical but we have no webhook/poller that reflects the state back | `routes/ghl-social-webhook.js` (new) | GHL Social Planner webhook — Option A (preferred) | Large | FIXED — see commit body |
| 5 | Rejected/flagged posts' `createImprovedAlternative` is triggered on drag-to-rejection but NOT on the manual "Solicitar ajuste" modal path when feedback is absent (silent no-op) | `routes/content.js:200-224` — `if (feedback)` guard | Either require feedback or surface a UI warning | Medium | Deferred |
| 6 | `parentPostId` is a bare string on `ContentPost` (no Prisma relation) — N+1 on parent titles for older posts; mitigated today by `buildParentTitleMap` but migration to a real FK would be cleaner | `prisma/schema.prisma:964` | Prisma relation migration + refactor | Medium | Deferred |
| 7 | No retention policy for `ContentPost` rows — stages like PUBLICADO/REJEITADO accumulate indefinitely | — | Add `retention.js` sweep for posts >180d | Medium | Deferred |
| 8 | `pushBlogPostToRds` is hardcoded to `brandSlug='sitio'`; RDS/CDS BLOG posts would silently land under RDI's slug if they ever used this path | `lib/sync-rds.js:88` | Map brand→slug once more brands onboard blogs | Small-but-premature | Deferred (not yet a live bug — only RDI publishes blogs today) |
| 9 | `ghlPostId` on PATCH rollback from AGENDADO only cancels on GHL if set; no reconciliation if GHL reports the post was already published | `routes/content.js:288-293` | Read GHL status before canceling | Medium | FIXED — see commit body |

## Small fixes applied in this commit

1. **Blog → RDS public site sync (Gap #1)** — When admin approves a BLOG post and the backend flips it to PUBLICADO, `pushBlogPostToRds(updated)` now fires in the background for RDI-brand posts. The function itself no-ops cleanly when `RDS_SYNC_SECRET` is unset, so staging deploys without the secret still succeed. Guarded with `.then/.catch` so a failing RDS-website does not block the admin's approve action.

2. **Regression coverage** — New `__tests__/sync-rds.pushBlogPost.test.mjs` exercises the three guard branches of `pushBlogPostToRds` (missing secret, invalid post, signed-POST happy path). 218 tests pass (baseline 215 + 3 new).

## How to work through the deferred gaps

Suggested sequence for a future session:
1. Gap #2 + #3 together — give admin real scheduling control, consume `postingSchedule` JSON.
2. Gap #4 — close the GHL round-trip so AGENDADO→PUBLICADO reflects reality.
3. Gap #5 — tighten the rejection path so alternatives are never silently skipped.
4. Gap #7 — retention hygiene.
5. Gaps #6, #8, #9 — polish.
