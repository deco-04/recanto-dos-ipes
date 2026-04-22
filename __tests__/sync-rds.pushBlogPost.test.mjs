import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Pin env before require so the module picks it up (it reads env at top-level).
// Using dynamic import inside tests so per-case env changes take effect.
async function loadSync(env = {}) {
  vi.resetModules();
  const prev = { ...process.env };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const mod = await import('../lib/sync-rds.js');
  return { mod, restore() { process.env = prev; } };
}

describe('pushBlogPostToRds guard branches', () => {
  let fetchSpy;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ slug: 'guia-cipo' }), { status: 200 })
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('skips with { ok: false, error: "not configured" } when RDS_SYNC_SECRET is missing', async () => {
    const { mod, restore } = await loadSync({ RDS_SYNC_SECRET: undefined });
    try {
      const r = await mod.pushBlogPostToRds({ id: 'p1', title: 't', body: 'b' });
      expect(r).toEqual({ ok: false, error: 'not configured' });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally { restore(); }
  });

  it('rejects posts missing required fields without calling fetch', async () => {
    const { mod, restore } = await loadSync({ RDS_SYNC_SECRET: 'shh' });
    try {
      const r = await mod.pushBlogPostToRds({ id: 'p1', title: 't' /* body missing */ });
      expect(r.ok).toBe(false);
      expect(r.error).toBe('invalid post');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally { restore(); }
  });

  it('posts a signed payload to /api/internal/blog/sync and returns { ok, slug }', async () => {
    const { mod, restore } = await loadSync({
      RDS_SYNC_SECRET: 'shh',
      RDS_PUBLIC_URL:  'https://rds.test',
    });
    try {
      const r = await mod.pushBlogPostToRds({
        id:        'post123',
        title:     'Guia da Serra do Cipó',
        body:      'Markdown body.',
        mediaUrls: ['https://cdn/p.jpg'],
        pillar:    'BLOG_SEO',
      });
      expect(r.ok).toBe(true);
      expect(r.slug).toBe('guia-cipo');

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://rds.test/api/internal/blog/sync');
      expect(init.method).toBe('POST');
      expect(init.headers['X-Sync-Signature']).toMatch(/^[a-f0-9]{64}$/);
      const body = JSON.parse(init.body);
      expect(body.externalId).toBe('post123');
      expect(body.propertySlug).toBe('sitio');
      expect(body.coverImage).toBe('https://cdn/p.jpg');
      expect(body.createdBy).toBe('vera');
    } finally { restore(); }
  });
});

describe('BRAND_TO_SLUG mapping (gap #8)', () => {
  it('maps each brand code to the rds-website property slug', async () => {
    const { mod, restore } = await loadSync({});
    try {
      expect(mod.BRAND_TO_SLUG).toEqual({
        RDI: 'sitio',
        RDS: 'recantos-da-serra',
        CDS: 'cabanas-da-serra',
      });
    } finally { restore(); }
  });

  it('derives propertySlug from post.brand when brandSlug arg omitted', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ slug: 'art' }), { status: 200 })
    );
    const { mod, restore } = await loadSync({
      RDS_SYNC_SECRET: 'shh',
      RDS_PUBLIC_URL:  'https://rds.test',
    });
    try {
      await mod.pushBlogPostToRds({
        id: 'p2', title: 't', body: 'b', brand: 'RDS',
      });
      const [, init] = fetchSpy.mock.calls[0];
      expect(JSON.parse(init.body).propertySlug).toBe('recantos-da-serra');
    } finally {
      fetchSpy.mockRestore();
      restore();
    }
  });

  it('falls back to "sitio" for unknown brand', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ slug: 'x' }), { status: 200 })
    );
    const { mod, restore } = await loadSync({
      RDS_SYNC_SECRET: 'shh',
      RDS_PUBLIC_URL:  'https://rds.test',
    });
    try {
      await mod.pushBlogPostToRds({
        id: 'p3', title: 't', body: 'b', brand: 'NEW_BRAND',
      });
      const [, init] = fetchSpy.mock.calls[0];
      expect(JSON.parse(init.body).propertySlug).toBe('sitio');
    } finally {
      fetchSpy.mockRestore();
      restore();
    }
  });
});
