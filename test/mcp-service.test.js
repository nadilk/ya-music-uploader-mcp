import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { MusicService } from '../src/mcp-service.js';

const playlistId = '00000000-0000-4000-8000-000000000001';

async function fixture(t, client) {
  const root = await mkdtemp(join(tmpdir(), 'mcp-service-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new MusicService({ tokenPath: join(root, 'oauth.json'), workingDirectory: join(root, 'audio'), jobsPath: join(root, 'jobs.json'), clientFactory: async () => client });
  await mkdir(service.workingDirectory);
  await service.initialize();
  await writeFile(join(service.workingDirectory, 'sample.mp3'), 'audio-bytes');
  return { root, service };
}

test('concurrent upload requests reuse a persistent job and completion includes track metadata', async (t) => {
  let uploads = 0;
  const client = {
    getToken: async () => ({ uid: '123' }),
    uploadFile: async (path, { onProgress }) => {
      uploads++;
      await onProgress({ stage: 'prepared', trackId: 'ugc-example' });
      await onProgress({ stage: 'submitted', trackId: 'ugc-example' });
      return { track: { id: 'ugc-example', title: 'Sample', state: 'playable', durationMs: 30000 }, trackCount: 17 };
    },
  };
  const { root, service } = await fixture(t, client);
  const [a, b] = await Promise.all([service.startUpload({ filePath: 'sample.mp3', playlistId }), service.startUpload({ filePath: 'sample.mp3', playlistId })]);
  assert.equal(a.job_id, b.job_id);
  await service.uploadQueue;
  const result = await service.uploadStatus(a.job_id);
  assert.equal(result.status, 'complete');
  assert.equal(result.track.duration_seconds, 30);
  assert.equal(uploads, 1);
  assert.equal((await service.startUpload({ filePath: join(service.workingDirectory, 'sample.mp3'), playlistId })).reused, true);
  const restarted = new MusicService({ tokenPath: join(root, 'oauth.json'), workingDirectory: service.workingDirectory, jobsPath: join(root, 'jobs.json'), clientFactory: async () => client });
  await restarted.initialize();
  assert.equal((await restarted.startUpload({ filePath: 'sample.mp3', playlistId })).job_id, a.job_id);
  assert.equal(uploads, 1);
});

test('local paths accept absolute paths, relative paths, and symlinks without a shared upload directory', async (t) => {
  const { root, service } = await fixture(t, {});
  const outside = join(root, 'outside.mp3');
  await writeFile(outside, 'audio-bytes');
  await symlink(outside, join(service.workingDirectory, 'link.mp3'));
  await writeFile(join(service.workingDirectory, 'credentials.json'), '{}');
  assert.equal(await service.resolveLocalPath(outside), outside);
  assert.equal(await service.resolveLocalPath('../outside.mp3'), outside);
  assert.equal(await service.resolveLocalPath('link.mp3'), outside);
  await assert.rejects(service.startUpload({ filePath: 'credentials.json', playlistId }), /audio file/);
  await assert.rejects(service.startUpload({ playlistId }), /file_path is required/);
  await assert.rejects(service.startUpload({ filePath: 'missing.mp3', playlistId }), { code: 'ENOENT' });
});

test('restarts preserve uncertain track IDs and status checks can confirm completion without upload', async (t) => {
  const client = {
    getToken: async () => ({ uid: '123' }),
    getTrack: async () => ({ id: 'ugc-recovered', state: 'playable', durationMs: 30000 }),
    listTracks: async () => ({ trackCount: 17, tracks: [{ id: 'ugc-recovered' }] }),
  };
  const { root, service } = await fixture(t, client);
  await writeFile(join(root, 'jobs.json'), JSON.stringify({ jobs: [{ job_id: 'job-example', uid: '123', status: 'uploading', track_id: 'ugc-recovered', playlist_id: playlistId }] }));
  await service.initialize();
  const result = await service.uploadStatus('job-example');
  assert.equal(result.status, 'complete');
  assert.equal(JSON.parse(await readFile(join(root, 'jobs.json'), 'utf8')).jobs[0].status, 'complete');
});

test('playlist creation serializes retries and reuses a matching name and visibility', async (t) => {
  const playlists = [];
  let creates = 0;
  const client = {
    listPlaylists: async () => playlists,
    createPlaylist: async ({ title, visibility }) => {
      creates++;
      const playlist = { title, visibility, playlistUuid: playlistId, uid: '123', kind: 1, trackCount: 0 };
      playlists.push(playlist);
      return playlist;
    },
  };
  const { service } = await fixture(t, client);
  const [a, b] = await Promise.all([service.createPlaylist({ title: 'Example' }), service.createPlaylist({ title: 'Example' })]);
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(creates, 1);
});
