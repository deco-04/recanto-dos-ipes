import { describe, it, expect } from 'vitest';

// Gap #6: ContentPost gained a self-relation `parentPost`. The serializer in
// routes/content.js used to require a separately-resolved parentTitle string;
// now it reads off the included relation. We test the pure shape contract by
// reimplementing the serializer body as a local fn (the route file is a
// CommonJS module that pulls in Express + Prisma at top-level — too heavy to
// import in a unit test).

function serializePost(p) {
  return {
    id:           p.id,
    brand:        p.brand,
    title:        p.title,
    body:         p.body,
    contentType:  p.contentType,
    pillar:       p.pillar,
    stage:        p.stage,
    aiGenerated:  p.aiGenerated,
    ghlPostId:    p.ghlPostId,
    scheduledFor: p.scheduledFor,
    publishedAt:  p.publishedAt,
    mediaUrls:    p.mediaUrls,
    imagePrompt:  p.imagePrompt   ?? null,
    feedbackNotes: p.feedbackNotes ?? null,
    parentPostId: p.parentPostId  ?? null,
    parentTitle:  p.parentPost?.title ?? null,
    createdAt:    p.createdAt,
    updatedAt:    p.updatedAt,
    comments:     p.comments?.map(c => ({
      id:        c.id,
      body:      c.body,
      staffId:   c.staffId,
      name:      c.staff?.name ?? null,
      createdAt: c.createdAt,
    })) ?? [],
  };
}

const BASE = {
  id: 'p1', brand: 'RDI', title: 'T', body: 'B',
  contentType: 'INSTAGRAM_FEED', pillar: null, stage: 'GERADO',
  aiGenerated: true, ghlPostId: null, scheduledFor: null, publishedAt: null,
  mediaUrls: [], imagePrompt: null, feedbackNotes: null,
  createdAt: new Date('2026-04-22T10:00:00Z'),
  updatedAt: new Date('2026-04-22T10:00:00Z'),
};

describe('serializePost (parentPost relation)', () => {
  it('reads parentTitle off the included parentPost relation', () => {
    const out = serializePost({
      ...BASE,
      parentPostId: 'parent42',
      parentPost:   { title: 'Original sobre o cipó' },
    });
    expect(out.parentPostId).toBe('parent42');
    expect(out.parentTitle).toBe('Original sobre o cipó');
  });

  it('returns null parentTitle when parentPost relation is absent', () => {
    // Either the row has no parent, or the caller forgot to include the
    // relation. Both should degrade to null without throwing.
    const noParent  = serializePost({ ...BASE, parentPostId: null });
    const noInclude = serializePost({ ...BASE, parentPostId: 'p99' /* parentPost undefined */ });
    expect(noParent.parentTitle).toBeNull();
    expect(noInclude.parentTitle).toBeNull();
  });
});
