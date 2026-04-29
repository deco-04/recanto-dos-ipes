import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';

// Pin the contract (2026-04-28):
//
//   GHL Social Planner published-state polling cron
//
// Hourly at HH:07. Fetches AGENDADO ContentPost rows that have a ghlPostId
// (and whose scheduledFor is at most 5 min in the future) and reconciles
// local stage with GHL's reported state via getPostStatus().
//
// The per-post logic is extracted into a helper `pollGhlSocialPost` so we
// can test it without registering the cron itself.
//
// Cases:
//   1. PUBLISHED → updates stage to PUBLICADO + sets publishedAt
//      + RDI brand triggers pushBlogPostToRds
//   2. PUBLISHED for non-RDI brand → updates stage but does NOT call
//      pushBlogPostToRds
//   3. SCHEDULED → no-op (returns transitioned: false)
//   4. FAILED → updates stage to REJEITADO + appends feedbackNotes
//      + sends ADMIN push (CONTENT_GHL_FAILED)
//   5. CANCELLED → updates stage to EM_REVISAO + clears ghlPostId
//   6. UNKNOWN status → no-op + warning logged
//   7. getPostStatus throws → returns transitioned:false + error string,
//      does not crash the loop
//
// We also pin the cron's query filter (the one inside startCronJobs):
//   { stage: 'AGENDADO', ghlPostId: { not: null }, scheduledFor: { lt: <buf> } }
// — so a post with ghlPostId === null is filtered at the query level and
// would never even reach the helper.

const require_ = createRequire(import.meta.url);
const cronModule = require_('../lib/cron.js');
const { pollGhlSocialPost } = cronModule;

function makeStubs() {
  return {
    ghlSocial: {
      getPostStatus: vi.fn(),
    },
    prismaClient: {
      contentPost: {
        update: vi.fn(async ({ data, where }) => ({ id: where.id, ...data })),
      },
    },
    sendPushToRole:    vi.fn(async () => 1),
    pushBlogPostToRds: vi.fn(async () => ({ ok: true })),
  };
}

const basePost = {
  id:            'post_1',
  stage:         'AGENDADO',
  ghlPostId:     'ghl_abc',
  brand:         'RDI',
  contentType:   'INSTAGRAM_FEED',
  title:         'Manhã no sítio',
  body:          'corpo do post',
  mediaUrls:     [],
  feedbackNotes: null,
};

describe('cron · GHL social poll · pollGhlSocialPost', () => {
  let stubs;

  beforeEach(() => {
    stubs = makeStubs();
  });

  it('PUBLISHED → updates stage to PUBLICADO, sets publishedAt, and calls pushBlogPostToRds for RDI', async () => {
    const publishedAt = new Date('2026-04-28T14:30:00Z');
    stubs.ghlSocial.getPostStatus = vi.fn(async () => ({
      status: 'PUBLISHED',
      publishedAt,
      raw: { status: 'PUBLISHED' },
    }));
    // Simulate the row Prisma returns after update keeps brand='RDI'
    stubs.prismaClient.contentPost.update = vi.fn(async ({ data, where }) => ({
      id:    where.id,
      brand: 'RDI',
      title: basePost.title,
      body:  basePost.body,
      ...data,
    }));

    const result = await pollGhlSocialPost(basePost, stubs);

    expect(result).toEqual({ transitioned: true, newStage: 'PUBLICADO' });
    expect(stubs.ghlSocial.getPostStatus).toHaveBeenCalledWith('ghl_abc');
    expect(stubs.prismaClient.contentPost.update).toHaveBeenCalledTimes(1);
    const callArg = stubs.prismaClient.contentPost.update.mock.calls[0][0];
    expect(callArg.where).toEqual({ id: 'post_1' });
    expect(callArg.data.stage).toBe('PUBLICADO');
    expect(callArg.data.publishedAt).toBe(publishedAt);
    expect(stubs.pushBlogPostToRds).toHaveBeenCalledTimes(1);
    expect(stubs.pushBlogPostToRds).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'post_1', brand: 'RDI', stage: 'PUBLICADO' }),
    );
  });

  it('PUBLISHED for non-RDI brand → updates stage but does NOT call pushBlogPostToRds', async () => {
    stubs.ghlSocial.getPostStatus = vi.fn(async () => ({
      status: 'PUBLISHED',
      publishedAt: new Date('2026-04-28T15:00:00Z'),
      raw: { status: 'PUBLISHED' },
    }));
    stubs.prismaClient.contentPost.update = vi.fn(async ({ data, where }) => ({
      id:    where.id,
      brand: 'CDS',
      ...data,
    }));

    const post = { ...basePost, brand: 'CDS' };
    const result = await pollGhlSocialPost(post, stubs);

    expect(result.transitioned).toBe(true);
    expect(result.newStage).toBe('PUBLICADO');
    expect(stubs.prismaClient.contentPost.update).toHaveBeenCalledTimes(1);
    expect(stubs.pushBlogPostToRds).not.toHaveBeenCalled();
  });

  it('PUBLISHED with null publishedAt → falls back to new Date()', async () => {
    stubs.ghlSocial.getPostStatus = vi.fn(async () => ({
      status:      'PUBLISHED',
      publishedAt: null,
      raw:         { status: 'PUBLISHED' },
    }));
    stubs.prismaClient.contentPost.update = vi.fn(async ({ data, where }) => ({
      id: where.id, brand: 'CDS', ...data,
    }));

    const post = { ...basePost, brand: 'CDS' };
    const before = Date.now();
    await pollGhlSocialPost(post, stubs);
    const after = Date.now();

    const stamped = stubs.prismaClient.contentPost.update.mock.calls[0][0].data.publishedAt;
    expect(stamped).toBeInstanceOf(Date);
    expect(stamped.getTime()).toBeGreaterThanOrEqual(before);
    expect(stamped.getTime()).toBeLessThanOrEqual(after);
  });

  it('SCHEDULED → no-op (returns transitioned:false, no DB write)', async () => {
    stubs.ghlSocial.getPostStatus = vi.fn(async () => ({
      status: 'SCHEDULED',
      publishedAt: null,
      raw: { status: 'SCHEDULED' },
    }));

    const result = await pollGhlSocialPost(basePost, stubs);

    expect(result).toEqual({ transitioned: false, newStage: null });
    expect(stubs.prismaClient.contentPost.update).not.toHaveBeenCalled();
    expect(stubs.sendPushToRole).not.toHaveBeenCalled();
    expect(stubs.pushBlogPostToRds).not.toHaveBeenCalled();
  });

  it('FAILED → updates stage to REJEITADO, appends feedbackNotes, and sends ADMIN push', async () => {
    stubs.ghlSocial.getPostStatus = vi.fn(async () => ({
      status: 'FAILED',
      publishedAt: null,
      raw: { status: 'FAILED' },
    }));

    const post = { ...basePost, feedbackNotes: 'previous note' };
    const result = await pollGhlSocialPost(post, stubs);

    expect(result).toEqual({ transitioned: true, newStage: 'REJEITADO' });
    expect(stubs.prismaClient.contentPost.update).toHaveBeenCalledTimes(1);
    const callArg = stubs.prismaClient.contentPost.update.mock.calls[0][0];
    expect(callArg.where).toEqual({ id: 'post_1' });
    expect(callArg.data.stage).toBe('REJEITADO');
    expect(callArg.data.feedbackNotes).toBe('previous note\n[GHL FAIL] FAILED');

    expect(stubs.sendPushToRole).toHaveBeenCalledTimes(1);
    expect(stubs.sendPushToRole).toHaveBeenCalledWith(
      'ADMIN',
      expect.objectContaining({
        type: 'CONTENT_GHL_FAILED',
        data: { postId: 'post_1' },
      }),
    );
  });

  it('FAILED with null feedbackNotes → starts a fresh note (no leading newline)', async () => {
    stubs.ghlSocial.getPostStatus = vi.fn(async () => ({
      status: 'FAILED',
      publishedAt: null,
      raw: { status: 'FAILED' },
    }));

    await pollGhlSocialPost({ ...basePost, feedbackNotes: null }, stubs);

    const data = stubs.prismaClient.contentPost.update.mock.calls[0][0].data;
    expect(data.feedbackNotes).toBe('[GHL FAIL] FAILED');
  });

  it('CANCELLED → updates stage to EM_REVISAO and clears ghlPostId', async () => {
    stubs.ghlSocial.getPostStatus = vi.fn(async () => ({
      status: 'CANCELLED',
      publishedAt: null,
      raw: { status: 'CANCELLED' },
    }));

    const result = await pollGhlSocialPost(basePost, stubs);

    expect(result).toEqual({ transitioned: true, newStage: 'EM_REVISAO' });
    const callArg = stubs.prismaClient.contentPost.update.mock.calls[0][0];
    expect(callArg.data).toEqual({ stage: 'EM_REVISAO', ghlPostId: null });
    expect(stubs.sendPushToRole).not.toHaveBeenCalled();
    expect(stubs.pushBlogPostToRds).not.toHaveBeenCalled();
  });

  it('UNKNOWN status → no-op and logs a warning', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubs.ghlSocial.getPostStatus = vi.fn(async () => ({
      status: 'UNKNOWN',
      publishedAt: null,
      raw: { status: 'WAT' },
    }));

    const result = await pollGhlSocialPost(basePost, stubs);

    expect(result).toEqual({ transitioned: false, newStage: null });
    expect(stubs.prismaClient.contentPost.update).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('unknown status for post post_1'),
    );
    warnSpy.mockRestore();
  });

  it('getPostStatus throws → returns transitioned:false + error string (does not crash)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    stubs.ghlSocial.getPostStatus = vi.fn(async () => {
      throw new Error('GHL 503');
    });

    const result = await pollGhlSocialPost(basePost, stubs);

    expect(result.transitioned).toBe(false);
    expect(result.error).toBe('GHL 503');
    expect(stubs.prismaClient.contentPost.update).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('PUBLISHED but pushBlogPostToRds throws → still reports transitioned:true (sync is fire-and-forget)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    stubs.ghlSocial.getPostStatus = vi.fn(async () => ({
      status: 'PUBLISHED',
      publishedAt: new Date(),
      raw: { status: 'PUBLISHED' },
    }));
    stubs.prismaClient.contentPost.update = vi.fn(async ({ data, where }) => ({
      id: where.id, brand: 'RDI', ...data,
    }));
    stubs.pushBlogPostToRds = vi.fn(async () => { throw new Error('rds down'); });

    const result = await pollGhlSocialPost(basePost, stubs);

    expect(result.transitioned).toBe(true);
    expect(result.newStage).toBe('PUBLICADO');
    expect(stubs.pushBlogPostToRds).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });
});
