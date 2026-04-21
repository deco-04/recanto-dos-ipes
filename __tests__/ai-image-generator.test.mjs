import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require_ = createRequire(import.meta.url);
const { makeGenerateHeroImage, _internals } = require_('../lib/ai-image-generator.js');

function makeOpenAI(b64OrError, { throws = false } = {}) {
  return {
    images: {
      generate: throws
        ? vi.fn().mockRejectedValue(new Error(b64OrError))
        : vi.fn().mockResolvedValue({ data: [{ b64_json: b64OrError }] }),
    },
  };
}

describe('ai-image-generator · _internals.buildImagePrompt', () => {
  it('uses imagePrompt verbatim when present', () => {
    const p = _internals.buildImagePrompt({
      post: { imagePrompt: 'Wooden cabin at sunset, soft golden light' },
      brandName: 'Sítio RDI',
    });
    expect(p).toContain('Wooden cabin at sunset, soft golden light');
    expect(p).toContain('Sítio RDI');
    expect(p).toContain('Serra do Cipó');
  });

  it('falls back to title when imagePrompt is missing', () => {
    const p = _internals.buildImagePrompt({
      post: { title: 'Guia de inverno na Serra' },
      brandName: null,
    });
    expect(p).toContain('Guia de inverno na Serra');
  });
});

describe('makeGenerateHeroImage', () => {
  let openai, writeFileFn;

  beforeEach(() => {
    openai = makeOpenAI(Buffer.from([1, 2, 3]).toString('base64'));
    writeFileFn = vi.fn().mockResolvedValue(undefined);
  });

  function build(overrides = {}) {
    return makeGenerateHeroImage({
      openaiClient:  openai,
      writeFileFn,
      publicBaseUrl: 'https://sri.example.com',
      uploadsDir:    '/tmp/uploads',
      ...overrides,
    });
  }

  const postBlog = { id: 'p1', brand: 'RDI', title: 'Roteiro de inverno', contentType: 'BLOG', imagePrompt: 'Cabana ao amanhecer' };

  it('generates an image, writes it with -ai suffix, returns public URL', async () => {
    const gen = build();
    const url = await gen({ post: postBlog, brandName: 'Sítio Recanto dos Ipês' });

    expect(openai.images.generate).toHaveBeenCalledTimes(1);
    const args = openai.images.generate.mock.calls[0][0];
    expect(args.model).toBe('gpt-image-1');
    expect(args.size).toBe('1024x1024');
    expect(args.prompt).toContain('Cabana ao amanhecer');

    expect(writeFileFn).toHaveBeenCalledTimes(1);
    const [writtenPath, buf] = writeFileFn.mock.calls[0];
    expect(writtenPath).toMatch(/\/tmp\/uploads\/content\/RDI\/p1-ai\.png$/);
    expect(Buffer.isBuffer(buf)).toBe(true);

    expect(url).toBe('https://sri.example.com/uploads/content/RDI/p1-ai.png');
  });

  it('skips ineligible content types (no network call, no write)', async () => {
    const gen = build();
    const result = await gen({ post: { ...postBlog, contentType: 'GBP_POST' }, brandName: 'RDI' });
    expect(result).toBeNull();
    expect(openai.images.generate).not.toHaveBeenCalled();
    expect(writeFileFn).not.toHaveBeenCalled();
  });

  it('allows BLOG, INSTAGRAM_FEED, INSTAGRAM_STORIES', async () => {
    const gen = build();
    for (const t of ['BLOG', 'INSTAGRAM_FEED', 'INSTAGRAM_STORIES']) {
      openai.images.generate.mockClear();
      const result = await gen({ post: { ...postBlog, id: `p-${t}`, contentType: t }, brandName: 'X' });
      expect(result).not.toBeNull();
      expect(openai.images.generate).toHaveBeenCalled();
    }
  });

  it('returns null when OpenAI throws (never bubbles into caller)', async () => {
    openai = makeOpenAI('quota exceeded', { throws: true });
    const gen = build({ openaiClient: openai });
    expect(await gen({ post: postBlog, brandName: 'X' })).toBeNull();
    expect(writeFileFn).not.toHaveBeenCalled();
  });

  it('returns null when OpenAI returns no b64 data', async () => {
    openai.images.generate.mockResolvedValue({ data: [{}] });
    const gen = build();
    expect(await gen({ post: postBlog, brandName: 'X' })).toBeNull();
    expect(writeFileFn).not.toHaveBeenCalled();
  });

  it('returns null when disk write fails (ENOSPC etc.)', async () => {
    writeFileFn.mockRejectedValue(new Error('ENOSPC'));
    const gen = build();
    expect(await gen({ post: postBlog, brandName: 'X' })).toBeNull();
  });

  it('returns null when post is missing an id', async () => {
    const gen = build();
    expect(await gen({ post: { title: 'no id' }, brandName: 'X' })).toBeNull();
    expect(openai.images.generate).not.toHaveBeenCalled();
  });

  it('times out when OpenAI hangs longer than timeoutMs', async () => {
    openai = {
      images: {
        generate: vi.fn(() => new Promise(() => {})),  // never resolves
      },
    };
    const gen = build({ openaiClient: openai, timeoutMs: 50 });
    expect(await gen({ post: postBlog, brandName: 'X' })).toBeNull();
  });
});
