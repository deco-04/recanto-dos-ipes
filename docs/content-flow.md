# Content Agent Flow

This doc maps the end-to-end life of a content post in the staff app
(`/admin/conteudo`) + SRI backend. Keep it up to date whenever the stage
machine, publish paths, or GHL scheduling change.

## High-level map

```
┌──────────────────────────────────────────────────────────────────────┐
│  TRIGGERS                                                            │
│                                                                      │
│  A) Weekly cron                                                      │
│     Monday 07:00 America/Denver (DST-aware)                          │
│     lib/cron-content.js::scheduleWeeklyContentCron                   │
│     → createWeeklyPackage(brand, propertyId) for each BrandConfig    │
│     → createRdiBlogPost(propertyId) for RDI only                     │
│                                                                      │
│  B) Manual "Gerar agora" from Kanban                                 │
│     POST /api/staff/conteudo/gerar-agora/:brand                      │
│     body: { contentTypes?: ContentType[], count?: number }           │
│     → createWeeklyPackage(brand, propertyId, { contentTypes, count })│
│                                                                      │
│  C) Manual "Só 1 blog" shortcut (RDI only)                           │
│     POST /api/staff/conteudo/gerar-blog-rdi                          │
│     → createRdiBlogPost(propertyId)                                  │
└──────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│  GENERATION (lib/conteudo-agent.js)                                  │
│                                                                      │
│  1. Load BrandContentConfig (voice, themes, pillarMix, hashtags,     │
│     imageLibraryUrl, aiImageFallback).                               │
│  2. Load last 30 d of approved titles   → lib/content-history.js     │
│  3. Load last 30 d of admin feedback    → lib/content-history.js     │
│  4. Build system + user prompt          → lib/content-prompts.js     │
│     (DECO 7-pillar · RDI truths · seasonal hook · avoid-list ·       │
│      steer-away-from list · channel filter · count)                  │
│  5. Claude Sonnet 4.6 generates the weekly array.                    │
│  6. Persist rows in ContentPost (stage = GERADO).                    │
│  7. If imageLibraryUrl is set AND GOOGLE_DRIVE_API_KEY env is set:   │
│     → lib/drive-images.js lists image/* in that folder               │
│     → lib/content-image-picker.js asks Claude which filename fits    │
│     → download → write to /uploads/content/<brand>/<postId>.<ext>    │
│     → update ContentPost.mediaUrls = [publicUrl]                     │
└──────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│  KANBAN REVIEW (/admin/conteudo, components/admin/content/*)         │
│                                                                      │
│  Stages (left → right): GERADO → EM_REVISAO → APROVADO               │
│                                      → AGENDADO → PUBLICADO          │
│                     side-lanes: AJUSTE_NECESSARIO, REJEITADO          │
│                                                                      │
│  • Drag card to AJUSTE_NECESSARIO or REJEITADO with a feedback note  │
│    → auto-calls createImprovedAlternative(id, feedback)              │
│    → new post in GERADO with parentPostId pointing at the rejected   │
│      one (ContentDetail renders a "↩ alternativa" link).             │
│                                                                      │
│  • Drag card to APROVADO → side effect depends on contentType:       │
│    - BLOG   → publishedAt = now, stage = PUBLICADO                   │
│               visible at GET /api/blog/posts + the public site       │
│    - social → lib/ghl-social.js::schedulePost                        │
│               POST https://services.leadconnectorhq.com/…            │
│                                                                      │
│  • Regenerate (icon on GERADO/EM_REVISAO cards) hits                 │
│    POST /api/staff/conteudo/:id/regenerar                            │
└──────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│  PUBLISH                                                             │
│                                                                      │
│  BLOG      → /api/blog/posts exposes slug, title, body, mediaUrls    │
│              The rds-website + SRI public sites read from this.      │
│                                                                      │
│  SOCIAL    → GHL Social Planner queues the post                      │
│              contentType → platform map:                             │
│                INSTAGRAM_FEED   / REELS / STORIES  → instagram       │
│                FACEBOOK                             → facebook       │
│                GBP_POST                             → google         │
│              scheduleTime = post.scheduledFor ?? tomorrow 10:00 local│
│              GHL returns an id → stored as ContentPost.ghlPostId     │
└──────────────────────────────────────────────────────────────────────┘
```

## Environment variables

| Var | Required for | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | Always | Claude calls (generation, image picker, regeneration) |
| `GHL_API_KEY` | Social posts | `schedulePost` to GHL Social Planner |
| `GHL_LOCATION_ID` | Social posts | Identifies the sub-account in GHL |
| `GOOGLE_DRIVE_API_KEY` | Image picker (optional) | Public Drive API read key |
| `PUBLIC_BASE_URL` | Image picker | Prefix used to build the public image URL |
| `UPLOADS_DIR` | Image picker | Disk location for downloaded images (default `./uploads`) |

## Google Drive setup (one-time, per brand)

1. In Google Cloud Console, pick or create a project.
2. Enable the **Drive API** (APIs & Services → Library).
3. Create an API key (APIs & Services → Credentials → Create → API key). Restrict
   it to *Drive API* only.
4. Paste the key into Railway as `GOOGLE_DRIVE_API_KEY`.
5. For each brand's photo folder in Google Drive, set sharing to **Anyone with the
   link can view**.
6. In `/admin/conteudo` → brand config → paste the folder URL into
   *Biblioteca de fotos (Google Drive)*.

Folders without a shared link or stored under a private Workspace cannot be
accessed by a public API key — upgrade to an OAuth service account if needed.

## Manual trigger commands (Railway SSH)

```bash
# Generate the whole weekly package for RDI immediately
railway ssh --service recanto-dos-ipes \
  "node -e \"require('./lib/conteudo-agent').createWeeklyPackage('RDI', (await require('./lib/db').property.findFirst({where:{slug:'sitio-recanto-ipes'}})).id)\""

# Generate just one long-form RDI blog post
railway ssh --service recanto-dos-ipes \
  "node -e \"require('./lib/conteudo-agent').createRdiBlogPost((await require('./lib/db').property.findFirst({where:{slug:'sitio-recanto-ipes'}})).id)\""
```

## Failure modes + what to check

| Symptom | Likely cause | Where to look |
|---|---|---|
| Posts generated but `mediaUrls` empty | `GOOGLE_DRIVE_API_KEY` missing or folder not shared | Railway env vars, Drive share settings |
| CDS tab generates but posts land under RDI | Stale deploy (pre-Sprint N) | check commit hash, redeploy |
| Gerar button spins forever | Claude rate-limit or Anthropic outage | `railway logs --service recanto-dos-ipes` |
| Approved social post didn't schedule | `GHL_API_KEY` invalid or location mismatch | Inspect `ghlPostId` on the card; retry via regenerate |
| Blog approved but not on public site | Caching / build step | Check `publishedAt` in Prisma Studio, force refresh public site |
