import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  makePickImageForPost,
  makeAttachImageToPost,
} from '../lib/content-image-picker.js';

// ── pickImageForPost ─────────────────────────────────────────────────────────
// Picks the best image filename for a post via a Claude one-shot call. The
// helper must tolerate malformed responses and return null rather than throw.
describe('makePickImageForPost', () => {
  function makeClaude(responseText) {
    return {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: responseText }],
        }),
      },
    };
  }

  const post = {
    id:          'p1',
    title:       'Serra do Cipó: roteiro de fim de semana saindo de BH',
    body:        'Uma experiência rural completa a 90 minutos de Belo Horizonte...',
    contentType: 'BLOG',
  };

  const library = [
    { id: 'f1', name: 'piscina-por-do-sol.jpg', mimeType: 'image/jpeg' },
    { id: 'f2', name: 'cabana-interior.png',    mimeType: 'image/png'  },
    { id: 'f3', name: 'serra-paisagem.jpg',     mimeType: 'image/jpeg' },
  ];

  it('returns the library entry whose name Claude picks', async () => {
    const claude = makeClaude('serra-paisagem.jpg');
    const pick   = makePickImageForPost({ claudeClient: claude });

    const result = await pick({ post, libraryImages: library });

    expect(result).toEqual(library[2]);
    expect(claude.messages.create).toHaveBeenCalledTimes(1);
    const callArgs = claude.messages.create.mock.calls[0][0];
    // The prompt must include the post title + every filename so the model
    // has enough context to pick deterministically.
    const promptText = JSON.stringify(callArgs);
    expect(promptText).toContain('Serra do Cipó');
    expect(promptText).toContain('piscina-por-do-sol.jpg');
    expect(promptText).toContain('serra-paisagem.jpg');
  });

  it('returns null when Claude responds with NONE (no good match)', async () => {
    const claude = makeClaude('NONE');
    const pick   = makePickImageForPost({ claudeClient: claude });
    expect(await pick({ post, libraryImages: library })).toBeNull();
  });

  it('returns null when Claude responds with a filename not in the library', async () => {
    const claude = makeClaude('random-unrelated.jpg');
    const pick   = makePickImageForPost({ claudeClient: claude });
    expect(await pick({ post, libraryImages: library })).toBeNull();
  });

  it('returns null when the library is empty (no call to Claude)', async () => {
    const claude = makeClaude('ignored');
    const pick   = makePickImageForPost({ claudeClient: claude });
    expect(await pick({ post, libraryImages: [] })).toBeNull();
    expect(claude.messages.create).not.toHaveBeenCalled();
  });

  it('returns null when Claude throws (malformed API error)', async () => {
    const claude = {
      messages: { create: vi.fn().mockRejectedValue(new Error('quota exceeded')) },
    };
    const pick = makePickImageForPost({ claudeClient: claude });
    expect(await pick({ post, libraryImages: library })).toBeNull();
  });

  it('trims whitespace + surrounding quotes from Claude responses', async () => {
    const claude = makeClaude('  "cabana-interior.png"  ');
    const pick   = makePickImageForPost({ claudeClient: claude });
    const result = await pick({ post, libraryImages: library });
    expect(result).toEqual(library[1]);
  });
});

// ── attachImageToPost (integration of list + pick + download + persist) ──────
describe('makeAttachImageToPost', () => {
  let driveClient, claudeClient, writeFileFn;

  beforeEach(() => {
    driveClient = {
      listFolderImages: vi.fn(),
      downloadImage:    vi.fn(),
    };
    claudeClient = {
      messages: { create: vi.fn() },
    };
    writeFileFn = vi.fn().mockResolvedValue(undefined);
  });

  function build(opts = {}) {
    return makeAttachImageToPost({
      driveClient,
      claudeClient,
      writeFileFn,
      publicBaseUrl: 'https://sri.example.com',
      uploadsDir:    '/tmp/uploads',
      ...opts,
    });
  }

  const post = { id: 'p1', brand: 'RDI', title: 'Post', body: 'x', contentType: 'BLOG' };

  it('returns null when folderId is missing (no folder configured)', async () => {
    const attach = build();
    const url = await attach({ post, folderId: null });
    expect(url).toBeNull();
    expect(driveClient.listFolderImages).not.toHaveBeenCalled();
  });

  it('returns null when folder is empty', async () => {
    driveClient.listFolderImages.mockResolvedValue([]);
    const attach = build();
    const url = await attach({ post, folderId: 'FOLDER' });
    expect(url).toBeNull();
    expect(driveClient.downloadImage).not.toHaveBeenCalled();
    expect(writeFileFn).not.toHaveBeenCalled();
  });

  it('picks an image, downloads it, writes to disk, returns public URL', async () => {
    driveClient.listFolderImages.mockResolvedValue([
      { id: 'f1', name: 'pool.jpg', mimeType: 'image/jpeg' },
    ]);
    claudeClient.messages.create.mockResolvedValue({
      content: [{ type: 'text', text: 'pool.jpg' }],
    });
    driveClient.downloadImage.mockResolvedValue(Buffer.from([1, 2, 3]));

    const attach = build();
    const url = await attach({ post, folderId: 'FOLDER' });

    expect(driveClient.downloadImage).toHaveBeenCalledWith('f1');
    expect(writeFileFn).toHaveBeenCalledTimes(1);
    const [path, buf] = writeFileFn.mock.calls[0];
    expect(path).toMatch(/\/tmp\/uploads\/content\/RDI\/p1\.jpg$/);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(url).toBe('https://sri.example.com/uploads/content/RDI/p1.jpg');
  });

  it('returns null when Claude picks NONE — no download, no write', async () => {
    driveClient.listFolderImages.mockResolvedValue([
      { id: 'f1', name: 'pool.jpg', mimeType: 'image/jpeg' },
    ]);
    claudeClient.messages.create.mockResolvedValue({
      content: [{ type: 'text', text: 'NONE' }],
    });

    const attach = build();
    expect(await attach({ post, folderId: 'FOLDER' })).toBeNull();
    expect(driveClient.downloadImage).not.toHaveBeenCalled();
    expect(writeFileFn).not.toHaveBeenCalled();
  });

  it('swallows Drive API errors and returns null (never throws into caller)', async () => {
    driveClient.listFolderImages.mockRejectedValue(new Error('Drive 403'));
    const attach = build();
    expect(await attach({ post, folderId: 'FOLDER' })).toBeNull();
  });

  it('swallows write errors and returns null (disk full, etc.)', async () => {
    driveClient.listFolderImages.mockResolvedValue([
      { id: 'f1', name: 'pool.jpg', mimeType: 'image/jpeg' },
    ]);
    claudeClient.messages.create.mockResolvedValue({
      content: [{ type: 'text', text: 'pool.jpg' }],
    });
    driveClient.downloadImage.mockResolvedValue(Buffer.from([1]));
    writeFileFn.mockRejectedValue(new Error('ENOSPC'));

    const attach = build();
    expect(await attach({ post, folderId: 'FOLDER' })).toBeNull();
  });
});
