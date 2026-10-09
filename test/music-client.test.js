import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { MusicClient, parsePlaylistId } from '../src/music-client.js';

const playlistId = '00000000-0000-4000-8000-000000000001';

const token = { access_token: 'test-secret', uid: '123' };
const json = (result) => new Response(JSON.stringify({ result }));

test('uploads multipart bytes without leaking OAuth to storage, then waits and verifies playlist membership', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'music-upload-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, 'sample.mp3');
  await writeFile(filePath, 'test-audio-bytes');
  const stages = [];
  let storageRequests = 0;
  let preparationRequests = 0;
  let processingRequests = 0;
  const playlist = { uid: 123, kind: 1003, playlistUuid: playlistId, revision: 5, trackCount: 1, tracks: [{ id: 'ugc-new' }] };
  const client = new MusicClient({
    getToken: async () => token, sleep: async () => {},
    fetchImpl: async (url, options) => {
      assert.equal(options.redirect, 'error');
      if (url.hostname === 'storage.example.com') {
        storageRequests++;
        assert.equal(options.headers, undefined);
        assert.equal(options.method, 'POST');
        assert.equal(options.body.get('file').name, 'sample.mp3');
        assert.equal(await options.body.get('file').text(), 'test-audio-bytes');
        return new Response('{}');
      }
      assert.equal(options.headers.authorization, 'OAuth test-secret');
      if (url.pathname.startsWith('/playlist/')) return json(playlist);
      if (url.pathname === '/loader/upload-url') {
        preparationRequests++;
        assert.equal(url.searchParams.get('uid'), '123');
        assert.equal(url.searchParams.get('playlist-id'), '123:1003');
        assert.equal(url.searchParams.get('path'), 'sample.mp3');
        return json({ 'post-target': 'https://storage.example.com/upload?signed=example', 'ugc-track-id': 'ugc-new' });
      }
      assert.equal(url.pathname, '/tracks');
      assert.equal(options.body.get('trackIds'), 'ugc-new');
      assert.equal(options.body.get('withProgress'), 'true');
      return json([{ id: 'ugc-new', state: ++processingRequests === 1 ? 'PROCESSING' : 'PLAYABLE' }]);
    },
  });
  const result = await client.uploadFile(filePath, { playlistId, onProgress: (event) => stages.push(event.stage) });
  assert.equal(result.stage, 'complete');
  assert.equal(result.trackCount, 1);
  assert.deepEqual(stages, ['prepared', 'submitted', 'processing', 'processing', 'complete']);
  assert.equal(storageRequests, 1);
  assert.equal(preparationRequests, 1);
});

test('uses pager.total rather than page trackCount when reading all tracks', async () => {
  const pages = [];
  const client = new MusicClient({ getToken: async () => token, fetchImpl: async (url) => {
    const page = Number(url.searchParams.get('page'));
    pages.push(page);
    return json({ revision: 1, trackCount: 1, pager: { total: 3, perPage: 1, page }, tracks: [{ id: String(page) }] });
  } });
  const playlist = await client.listTracks(playlistId, { pageSize: 1 });
  assert.deepEqual(pages, [0, 1, 2]);
  assert.equal(playlist.trackCount, 3);
  assert.equal(playlist.tracks.length, 3);
});

test('processing timeout preserves track ID and never retries upload', async () => {
  let requests = 0;
  const client = new MusicClient({ getToken: async () => token, sleep: async () => {}, fetchImpl: async (url) => {
    assert.equal(url.pathname, '/tracks');
    requests++;
    return json([{ id: 'ugc-waiting', state: 'PROCESSING' }]);
  } });
  await assert.rejects(client.waitForTrack('ugc-waiting', { attempts: 2 }), /ugc-waiting.*do not upload the file again/);
  assert.equal(requests, 2);
});

test('rejects empty files and other owners before requesting an upload URL', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'music-upload-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, 'sample.mp3');
  await writeFile(filePath, '');
  let calls = 0;
  const client = new MusicClient({ getToken: async () => token, fetchImpl: async (url) => {
    calls++;
    assert.ok(url.pathname.startsWith('/playlist/'));
    return json({ uid: 456, kind: 1 });
  } });
  await assert.rejects(client.uploadFile(filePath, { playlistId }), /non-empty/);
  assert.equal(calls, 0);
  await writeFile(filePath, 'audio');
  await assert.rejects(client.uploadFile(filePath, { playlistId }), /your own/);
  assert.equal(calls, 1);
});

test('parses playlist UUIDs and URLs, and rejects unrelated hosts', () => {
  assert.equal(parsePlaylistId(`https://music.yandex.kz/playlists/${playlistId}`), playlistId);
  assert.throws(() => parsePlaylistId(`https://example.com/playlists/${playlistId}`));
  assert.throws(() => parsePlaylistId('not-a-uuid'));
});

test('lists and creates playlists through the current user endpoints', async () => {
  const client = new MusicClient({ getToken: async () => token, fetchImpl: async (url, options) => {
    assert.equal(options.headers.authorization, 'OAuth test-secret');
    if (options.method === 'GET') {
      assert.equal(url.pathname, '/users/123/playlists/list');
      assert.equal(url.searchParams.get('page'), '2');
      assert.equal(url.searchParams.get('pageSize'), '5');
      return json([{ playlistUuid: playlistId }]);
    }
    assert.equal(url.pathname, '/users/123/playlists/create');
    assert.equal(url.searchParams.get('title'), 'New playlist');
    assert.equal(url.searchParams.get('visibility'), 'private');
    assert.equal(url.searchParams.get('description'), 'My files');
    return json({ playlistUuid: playlistId, title: 'New playlist' });
  } });
  assert.equal((await client.listPlaylists({ page: 2, pageSize: 5 })).length, 1);
  assert.equal((await client.createPlaylist({ title: ' New playlist ', description: 'My files' })).title, 'New playlist');
});
