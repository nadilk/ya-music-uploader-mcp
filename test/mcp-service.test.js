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
  const confirmedAt = Date.parse('2026-10-09T12:00:00Z');
  service.now = () => confirmedAt;
  await writeFile(join(root, 'jobs.json'), JSON.stringify({ jobs: [{ job_id: 'job-example', uid: '123', status: 'uploading', track_id: 'ugc-recovered', playlist_id: playlistId, created_at: '2020-01-01T00:00:00Z' }] }));
  await service.initialize();
  const result = await service.uploadStatus('job-example');
  assert.equal(result.status, 'complete');
  assert.equal(result.updated_at, new Date(confirmedAt).toISOString());
  assert.equal(JSON.parse(await readFile(join(root, 'jobs.json'), 'utf8')).jobs[0].status, 'complete');
});

test('startup prunes expired successful and pre-transfer failures while preserving uncertain records', async (t) => {
  const { service } = await fixture(t, {});
  const now = Date.parse('2026-10-09T12:00:00Z');
  const day = 24 * 60 * 60 * 1000;
  const ago = (age) => new Date(now - age).toISOString();
  service.now = () => now;
  const jobs = [
    { job_id: 'complete-expired', status: 'complete', updated_at: ago(30 * day) },
    { job_id: 'complete-recent', status: 'complete', updated_at: ago(30 * day - 1) },
    { job_id: 'failed-expired', status: 'failed', updated_at: ago(7 * day) },
    { job_id: 'failed-recent', status: 'failed', updated_at: ago(7 * day - 1) },
    { job_id: 'legacy-expired', status: 'complete', created_at: ago(31 * day) },
    { job_id: 'recent-completion', status: 'complete', created_at: ago(100 * day), updated_at: ago(day) },
    { job_id: 'unknown', status: 'unknown', track_id: 'remote', updated_at: ago(100 * day) },
    { job_id: 'interrupted', status: 'interrupted', created_at: ago(100 * day) },
    { job_id: 'remote-failure', status: 'failed', track_id: 'remote', updated_at: ago(100 * day) },
    { job_id: 'recovered-upload', status: 'uploading', track_id: 'remote', created_at: ago(100 * day) },
    { job_id: 'recovered-queue', status: 'queued', created_at: ago(100 * day) },
    { job_id: 'missing-date', status: 'complete' },
    { job_id: 'invalid-date', status: 'failed', updated_at: 'invalid' },
  ];
  await writeFile(service.jobsPath, JSON.stringify({ jobs }));
  await service.initialize();
  const expectedIds = jobs.map((job) => job.job_id).filter((id) => !['complete-expired', 'failed-expired', 'legacy-expired'].includes(id));
  assert.deepEqual([...service.jobs.keys()], expectedIds);
  const saved = JSON.parse(await readFile(service.jobsPath, 'utf8'));
  assert.deepEqual(saved.jobs.map((job) => job.job_id), expectedIds);
  assert.equal(service.jobs.get('recovered-upload').status, 'unknown');
  assert.equal(service.jobs.get('recovered-queue').status, 'interrupted');
});

test('new submissions prune expired history before deduplication and concurrent requests still share one upload', async (t) => {
  let uploads = 0;
  let time = Date.parse('2026-10-09T12:00:00Z');
  const day = 24 * 60 * 60 * 1000;
  const client = {
    getToken: async () => ({ uid: '123' }),
    uploadFile: async () => {
      uploads++;
      return { track: { id: `track-${uploads}`, state: 'playable' }, trackCount: uploads };
    },
  };
  const { service } = await fixture(t, client);
  service.now = () => time;
  const first = await service.startUpload({ filePath: 'sample.mp3', playlistId });
  await service.uploadQueue;
  time += 30 * day - 1;
  assert.equal((await service.startUpload({ filePath: 'sample.mp3', playlistId })).job_id, first.job_id);
  time++;
  const [a, b] = await Promise.all([
    service.startUpload({ filePath: 'sample.mp3', playlistId }),
    service.startUpload({ filePath: 'sample.mp3', playlistId }),
  ]);
  assert.notEqual(a.job_id, first.job_id);
  assert.equal(a.job_id, b.job_id);
  await service.uploadQueue;
  assert.equal(uploads, 2);
  await assert.rejects(service.uploadStatus(first.job_id), /history may have expired/);
  const saved = JSON.parse(await readFile(service.jobsPath, 'utf8'));
  assert.deepEqual(saved.jobs.map((job) => job.job_id), [a.job_id]);
});

test('failure retention starts when the pre-transfer error occurs', async (t) => {
  let time = Date.parse('2026-10-09T12:00:00Z');
  const day = 24 * 60 * 60 * 1000;
  const client = {
    getToken: async () => ({ uid: '123' }),
    uploadFile: async () => {
      time += 10 * day;
      throw new Error('Upload preparation failed');
    },
  };
  const { service } = await fixture(t, client);
  service.now = () => time;
  const job = await service.startUpload({ filePath: 'sample.mp3', playlistId });
  await service.uploadQueue;
  const failed = await service.uploadStatus(job.job_id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.updated_at, new Date(time).toISOString());
  time += 7 * day - 1;
  assert.equal((await service.startUpload({ filePath: 'sample.mp3', playlistId })).job_id, job.job_id);
  time++;
  const retry = await service.startUpload({ filePath: 'sample.mp3', playlistId });
  assert.notEqual(retry.job_id, job.job_id);
  await service.uploadQueue;
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

test('logout revokes the saved device token and clears persistent and in-memory account state', async (t) => {
  const { root, service } = await fixture(t, {});
  await service.client();
  service.auth.current = { id: 'old-login', status: 'authenticated' };
  service.jobs.set('old-job', { job_id: 'old-job', status: 'complete' });
  await service.persist();
  await writeFile(service.tokenPath, JSON.stringify({ access_token: 'private-token', refresh_token: 'private-refresh' }));
  const keyPath = join(root, 'mcp-key.json');
  await writeFile(keyPath, 'mcp-key');
  let revocations = 0;
  service.fetch = async (url, options) => {
    revocations++;
    assert.equal(url, 'https://oauth.yandex.ru/revoke_token');
    assert.equal(options.body.get('access_token'), 'private-token');
    return new Response(JSON.stringify({ status: 'ok' }));
  };
  const result = await service.logout();
  assert.equal(result.remote_revocation, 'revoked');
  assert.equal(result.authenticated, false);
  assert.equal(JSON.stringify(result).includes('private-'), false);
  assert.equal(service.clientPromise, null);
  assert.equal(service.auth.current, null);
  assert.equal(service.jobs.size, 0);
  await assert.rejects(readFile(service.tokenPath), { code: 'ENOENT' });
  await assert.rejects(readFile(service.jobsPath), { code: 'ENOENT' });
  await assert.rejects(service.uploadStatus('old-job'), /Unknown job_id/);
  await assert.rejects(service.auth.complete('old-login'), /Unknown auth_id/);
  assert.equal(await readFile(keyPath, 'utf8'), 'mcp-key');
  assert.equal(await readFile(join(service.workingDirectory, 'sample.mp3'), 'utf8'), 'audio-bytes');
  assert.equal((await service.logout()).remote_revocation, 'not_attempted');
  assert.equal(revocations, 1);
  assert.equal(await service.runOperation(() => 'ready for login'), 'ready for login');
});

test('logout still cleans local state if remote revocation fails or the token is corrupt', async (t) => {
  for (const token of [JSON.stringify({ access_token: 'private-token' }), 'invalid-json']) {
    const { service } = await fixture(t, {});
    await writeFile(service.tokenPath, token);
    service.jobs.set('old-job', { job_id: 'old-job' });
    await service.persist();
    service.fetch = async () => { throw new Error('Network failure with private-token'); };
    const result = await service.logout();
    assert.equal(result.remote_revocation, 'failed');
    assert.equal(result.upload_history_deleted, true);
    assert.ok(result.revoke_access_url);
    assert.equal(JSON.stringify(result).includes('private-token'), false);
    await assert.rejects(readFile(service.tokenPath), { code: 'ENOENT' });
    await assert.rejects(readFile(service.jobsPath), { code: 'ENOENT' });
  }
});

test('logout drains requests and the active transfer, skips queued uploads, and prevents state from reappearing', async (t) => {
  let finishUpload, uploadStarted;
  const started = new Promise((resolve) => { uploadStarted = resolve; });
  const uploadFinished = new Promise((resolve) => { finishUpload = resolve; });
  let uploads = 0;
  const client = {
    getToken: async () => ({ uid: '123' }),
    uploadFile: async () => {
      uploads++;
      uploadStarted();
      await uploadFinished;
      return { track: { id: 'track', state: 'playable' }, trackCount: 1 };
    },
  };
  const { service } = await fixture(t, client);
  await service.runOperation(() => service.startUpload({ filePath: 'sample.mp3', playlistId }));
  await started;
  await service.runOperation(() => service.startUpload({ filePath: 'sample.mp3', playlistId, force: true }));
  let finishRequest;
  const pendingRequest = new Promise((resolve) => { finishRequest = resolve; });
  const request = service.runOperation(async () => {
    await pendingRequest;
    await writeFile(service.tokenPath, JSON.stringify({ access_token: 'new-token' }));
  });
  service.fetch = async () => new Response(JSON.stringify({ status: 'ok' }));
  let loggedOut = false;
  const logout = service.logout().then((result) => { loggedOut = true; return result; });
  await assert.rejects(service.runOperation(() => service.auth.init()), /Logout is in progress/);
  assert.equal(loggedOut, false);
  finishRequest();
  await request;
  assert.equal(loggedOut, false);
  finishUpload();
  assert.equal((await logout).remote_revocation, 'revoked');
  assert.equal(uploads, 1);
  assert.equal(service.jobs.size, 0);
  await assert.rejects(readFile(service.tokenPath), { code: 'ENOENT' });
  await assert.rejects(readFile(service.jobsPath), { code: 'ENOENT' });
});
