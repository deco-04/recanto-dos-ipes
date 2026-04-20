import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  extractFolderId,
  makeDriveImagesClient,
} from '../lib/drive-images.js';

describe('extractFolderId', () => {
  it('parses the common /folders/<id> URL', () => {
    expect(extractFolderId('https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQ_rStUvWxYz')).toBe('1AbCdEfGhIjKlMnOpQ_rStUvWxYz');
  });

  it('parses the /folders/<id>?usp=sharing URL (common share link)', () => {
    expect(
      extractFolderId('https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQ_rStUvWxYz?usp=sharing'),
    ).toBe('1AbCdEfGhIjKlMnOpQ_rStUvWxYz');
  });

  it('parses the legacy ?id=<id> query-string URL', () => {
    expect(extractFolderId('https://drive.google.com/open?id=1AbCdEfGhIjKlMnOpQ_rStUvWxYz')).toBe('1AbCdEfGhIjKlMnOpQ_rStUvWxYz');
  });

  it('returns null for a non-Drive URL', () => {
    expect(extractFolderId('https://example.com/foo')).toBeNull();
    expect(extractFolderId('')).toBeNull();
    expect(extractFolderId(null)).toBeNull();
    expect(extractFolderId(undefined)).toBeNull();
  });

  it('returns null for a Drive file (not folder) URL', () => {
    // /file/d/ → not a folder; the picker only works with folders
    expect(extractFolderId('https://drive.google.com/file/d/1AbCdEf/view')).toBeNull();
  });

  it('accepts a raw folder id passed through as-is (user pasted just the id)', () => {
    expect(extractFolderId('1AbCdEfGhIjKlMnOpQ_rStUvWxYz')).toBe('1AbCdEfGhIjKlMnOpQ_rStUvWxYz');
  });
});

describe('makeDriveImagesClient', () => {
  let fetchFn;
  let client;

  beforeEach(() => {
    fetchFn = vi.fn();
    client = makeDriveImagesClient({ apiKey: 'FAKE_KEY', fetchFn });
  });

  describe('listFolderImages', () => {
    it('calls Drive v3 list with correct params and filters image mime types only', async () => {
      fetchFn.mockResolvedValue({
        ok: true,
        json: async () => ({
          files: [
            { id: 'a', name: 'pool-sunset.jpg', mimeType: 'image/jpeg' },
            { id: 'b', name: 'spec.pdf',        mimeType: 'application/pdf' },
            { id: 'c', name: 'cabana.png',      mimeType: 'image/png' },
          ],
        }),
      });

      const imgs = await client.listFolderImages('FOLDER_123');

      expect(fetchFn).toHaveBeenCalledTimes(1);
      const url = fetchFn.mock.calls[0][0];
      expect(url).toContain('https://www.googleapis.com/drive/v3/files');
      // The query must constrain both parent-folder and MIME
      expect(decodeURIComponent(url)).toContain("'FOLDER_123' in parents");
      expect(decodeURIComponent(url)).toContain("mimeType contains 'image/'");
      expect(url).toContain('key=FAKE_KEY');

      // Non-image files filtered out
      expect(imgs.map(f => f.id)).toEqual(['a', 'c']);
    });

    it('returns [] when the folder is empty or response omits files', async () => {
      fetchFn.mockResolvedValue({ ok: true, json: async () => ({}) });
      const imgs = await client.listFolderImages('EMPTY_FOLDER');
      expect(imgs).toEqual([]);
    });

    it('throws a descriptive error when Drive returns non-ok', async () => {
      fetchFn.mockResolvedValue({
        ok:     false,
        status: 404,
        json:   async () => ({ error: { message: 'File not found' } }),
      });
      await expect(client.listFolderImages('BAD')).rejects.toThrow(/404/);
    });
  });

  describe('downloadImage', () => {
    it('fetches the file via alt=media + apiKey and returns a Buffer', async () => {
      const fakeBytes = new Uint8Array([1, 2, 3, 4]).buffer;
      fetchFn.mockResolvedValue({
        ok:          true,
        arrayBuffer: async () => fakeBytes,
      });

      const buf = await client.downloadImage('FILE_ID');

      expect(fetchFn).toHaveBeenCalledTimes(1);
      const url = fetchFn.mock.calls[0][0];
      expect(url).toBe('https://www.googleapis.com/drive/v3/files/FILE_ID?alt=media&key=FAKE_KEY');
      expect(Buffer.isBuffer(buf)).toBe(true);
      expect(buf.length).toBe(4);
    });

    it('throws when the download response is not ok', async () => {
      fetchFn.mockResolvedValue({ ok: false, status: 403 });
      await expect(client.downloadImage('X')).rejects.toThrow(/403/);
    });
  });
});
