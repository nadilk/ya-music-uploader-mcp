import { randomUUID } from 'node:crypto';
import { readFile, realpath, rm, stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { AuthFlow } from './mcp-auth.js';
import { createMusicClient, parsePlaylistId } from './music-client.js';
import { writeState } from './state.js';
import { audioExtensions, maximumFileSize } from './audio.js';
import { revokeToken } from './device-auth.js';

const dayMilliseconds = 24 * 60 * 60 * 1000;
const completeRetention = 30 * dayMilliseconds;
const failedRetention = 7 * dayMilliseconds;

export function summarizePlaylist(playlist) {
  return {
    id: playlist.playlistUuid, title: playlist.title, uid: String(playlist.uid), kind: playlist.kind,
    visibility: playlist.visibility, track_count: playlist.pager?.total ?? playlist.trackCount,
    url: playlist.playlistUuid ? `https://music.yandex.kz/playlists/${playlist.playlistUuid}` : undefined,
  };
}

export function summarizeTrack(item) {
  const track = item.track ?? item;
  return {
    id: String(item.id), title: track.title, filename: track.filename, state: track.state,
    duration_seconds: track.durationMs === undefined ? undefined : track.durationMs / 1000,
    artists: track.artists?.map((artist) => artist.name) ?? [],
  };
}

export class MusicService {
  constructor({ tokenPath, jobsPath, workingDirectory = process.cwd(), clientFactory, auth, now = Date.now, sleep = setTimeout, fetchImpl = globalThis.fetch }) {
    this.tokenPath = tokenPath;
    this.workingDirectory = resolve(workingDirectory);
    this.jobsPath = jobsPath;
    this.clientFactory = clientFactory ?? (() => createMusicClient({ tokenPath, fetchImpl }));
    this.auth = auth ?? new AuthFlow({ tokenPath, fetchImpl });
    this.fetch = fetchImpl;
    this.now = now;
    this.sleep = sleep;
    this.jobs = new Map();
    this.uploadQueue = Promise.resolve();
    this.submissions = Promise.resolve();
    this.creations = Promise.resolve();
    this.persistence = Promise.resolve();
    this.operations = new Set();
    this.logoutPromise = null;
  }

  async runOperation(handler) {
    if (this.logoutPromise) throw new Error('Logout is in progress. Try again after it completes.');
    const operation = Promise.resolve().then(handler);
    this.operations.add(operation);
    try { return await operation; } finally { this.operations.delete(operation); }
  }

  logout() {
    if (this.logoutPromise) return this.logoutPromise;
    this.logoutPromise = Promise.resolve().then(async () => {
      // Finish existing requests and the active transfer; queued transfers are skipped.
      await Promise.allSettled([...this.operations, this.submissions, this.creations]);
      await this.uploadQueue;
      await this.persistence;
      let remoteRevocation = 'not_attempted';
      try {
        const token = JSON.parse(await readFile(this.tokenPath, 'utf8'));
        if (!token.access_token) throw new Error('Missing access token.');
        await revokeToken(token, this.fetch);
        remoteRevocation = 'revoked';
      } catch (error) {
        if (error.code !== 'ENOENT') remoteRevocation = 'failed';
      }
      this.auth.reset();
      this.clientPromise = null;
      this.jobs.clear();
      const deletions = await Promise.allSettled([
        rm(this.tokenPath, { force: true }), rm(this.jobsPath, { force: true }),
      ]);
      if (deletions.some((result) => result.status === 'rejected')) {
        throw new Error('Could not remove all local credentials or upload history. Check filesystem permissions and retry logout.');
      }
      return {
        authenticated: false, token_deleted: true, upload_history_deleted: true,
        remote_revocation: remoteRevocation,
        ...(remoteRevocation === 'failed' ? {
          message: 'Local logout completed, but remote revocation was not confirmed. Revoke access manually in Yandex ID.',
          revoke_access_url: 'https://id.yandex.ru/personal/data-access',
        } : {}),
        next_tool: 'init_auth',
      };
    }).finally(() => { this.logoutPromise = null; });
    return this.logoutPromise;
  }

  async initialize() {
    this.workingDirectory = await realpath(this.workingDirectory);
    let saved;
    try { saved = JSON.parse(await readFile(this.jobsPath, 'utf8')); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return;
    }
    let recovered = false;
    for (const job of saved.jobs ?? []) {
      if (!['complete', 'failed', 'unknown', 'interrupted'].includes(job.status)) {
        job.status = job.track_id ? 'unknown' : 'interrupted';
        job.error = 'The server restarted. Transfers are not repeated automatically; check the existing track_id.';
        recovered = true;
      }
      this.jobs.set(job.job_id, job);
    }
    const removed = this.pruneUploadHistory();
    if (recovered || removed) await this.persist();
  }

  pruneUploadHistory() {
    const now = this.now();
    let removed = 0;
    for (const [id, job] of this.jobs) {
      const retention = job.status === 'complete' ? completeRetention
        : job.status === 'failed' && !job.track_id ? failedRetention : null;
      const updatedAt = Date.parse(job.updated_at ?? job.created_at);
      // Preserve uncertain transfers and legacy records without a usable timestamp.
      if (retention !== null && Number.isFinite(updatedAt) && now - updatedAt >= retention) {
        this.jobs.delete(id);
        removed++;
      }
    }
    return removed;
  }

  async client() {
    if (!this.clientPromise) this.clientPromise = this.clientFactory().catch((error) => { this.clientPromise = null; throw error; });
    return this.clientPromise;
  }

  persist() {
    const operation = this.persistence.then(() => writeState({ jobs: [...this.jobs.values()] }, this.jobsPath));
    this.persistence = operation.catch(() => {});
    return operation;
  }

  publicJob(job) {
    const { fingerprint, ...result } = job;
    return { ...result, next_tool: job.status === 'complete' ? 'list_playlist_tracks' : 'get_upload_status' };
  }

  async resolveLocalPath(path = '.') {
    return realpath(resolve(this.workingDirectory, path));
  }

  async getAuthStatus() {
    try {
      const data = await (await this.client()).request('account/status');
      if (!data.account?.uid) throw new Error('The API did not confirm the account.');
      return { authenticated: true, uid: String(data.account.uid), login: data.account.login };
    } catch (error) {
      return { authenticated: false, message: error.message, next_tool: 'init_auth' };
    }
  }

  async listPlaylists({ page = 0, pageSize = 50 } = {}) {
    const playlists = await (await this.client()).listPlaylists({ page, pageSize });
    return { playlists: playlists.map(summarizePlaylist), page, next_page: playlists.length === pageSize ? page + 1 : null };
  }

  async createPlaylist({ title, description = '', visibility = 'private', reuseExisting = true }) {
    const create = async () => {
      const client = await this.client();
      if (reuseExisting) {
        for (let page = 0; ; page++) {
          const playlists = await client.listPlaylists({ page, pageSize: 100 });
          const existing = playlists.find((playlist) => playlist.title === title.trim() && playlist.visibility === visibility);
          if (existing) return { created: false, playlist: summarizePlaylist(existing) };
          if (playlists.length < 100) break;
        }
      }
      const playlist = await client.createPlaylist({ title, description, visibility });
      if (!playlist?.playlistUuid) throw new Error('The API did not return a playlist UUID. Check list_playlists before creating another playlist.');
      return { created: true, playlist: summarizePlaylist(playlist) };
    };
    const operation = this.creations.then(create);
    this.creations = operation.catch(() => {});
    return operation;
  }

  async listPlaylistTracks({ playlistId, page = 0, pageSize = 50 } = {}) {
    const playlist = await (await this.client()).getPlaylist(playlistId, { page, pageSize });
    const total = playlist.pager?.total ?? playlist.trackCount;
    return { playlist: summarizePlaylist(playlist), tracks: (playlist.tracks ?? []).map(summarizeTrack), page, next_page: (page + 1) * (playlist.pager?.perPage ?? pageSize) < total ? page + 1 : null };
  }

  async startUpload({ filePath, playlistId, force = false }) {
    const submit = async () => {
      if (this.pruneUploadHistory()) await this.persist();
      if (typeof filePath !== 'string' || !filePath.trim()) throw new Error('A local file_path is required.');
      const path = await this.resolveLocalPath(filePath);
      if (!audioExtensions.has(extname(path).toLowerCase())) throw new Error('Expected an audio file: mp3, flac, wav, ogg, m4a, aac, opus, or wma.');
      const info = await stat(path);
      if (!info.isFile() || info.size === 0 || info.size > maximumFileSize) throw new Error('Expected a non-empty audio file up to 400 MiB.');
      const id = parsePlaylistId(playlistId);
      const client = await this.client();
      const token = await client.getToken();
      const fingerprint = JSON.stringify([token.uid, path, info.size, info.mtimeMs, id]);
      const existing = [...this.jobs.values()].reverse().find((job) => job.fingerprint === fingerprint);
      if (existing && !force) return { ...this.publicJob(existing), reused: true };
      const job = { job_id: randomUUID(), fingerprint, uid: String(token.uid), status: 'queued', file_path: path, playlist_id: id, created_at: new Date(this.now()).toISOString() };
      this.jobs.set(job.job_id, job);
      await this.persist();
      this.uploadQueue = this.uploadQueue.then(() => this.runUpload(job, path)).catch(() => {});
      return this.publicJob(job);
    };
    const operation = this.submissions.then(submit);
    this.submissions = operation.catch(() => {});
    return operation;
  }

  async runUpload(job, path) {
    if (this.logoutPromise) return;
    try {
      const client = await this.client();
      const token = await client.getToken();
      if (String(token.uid) !== job.uid) throw new Error('The account changed after this upload was queued.');
      job.status = 'preparing';
      await this.persist();
      const result = await client.uploadFile(path, { playlistId: job.playlist_id, onProgress: async (event) => {
        job.track_id = event.trackId;
        job.status = { prepared: 'uploading', submitted: 'processing', processing: 'processing', complete: 'complete' }[event.stage];
        if (event.state) job.track_state = event.state;
        job.updated_at = new Date(this.now()).toISOString();
        await this.persist();
      } });
      job.status = 'complete';
      job.track = summarizeTrack(result.track);
      job.track_count = result.trackCount;
      job.updated_at = new Date(this.now()).toISOString();
      await this.persist();
    } catch (error) {
      job.status = job.track_id ? 'unknown' : 'failed';
      job.error = error.message;
      job.updated_at = new Date(this.now()).toISOString();
      try { await this.persist(); } catch { /* The in-memory job remains queryable. */ }
    }
  }

  async uploadStatus(jobId, waitSeconds = 0) {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error('Unknown job_id. Its history may have expired or been cleared by logout.');
    const deadline = this.now() + Math.min(30, Math.max(0, waitSeconds)) * 1000;
    while (true) {
      if (job.status === 'unknown' && job.track_id) {
        const client = await this.client();
        if (String((await client.getToken()).uid) !== job.uid) throw new Error('This upload belongs to a different account.');
        const track = await client.getTrack(job.track_id);
        job.track_state = track?.state ?? 'PENDING';
        if (String(track?.state).toUpperCase() === 'PLAYABLE') {
          const playlist = await client.listTracks(job.playlist_id);
          if (playlist.tracks.some((item) => String(item.id) === String(job.track_id))) {
            job.status = 'complete'; job.track = summarizeTrack(track); job.track_count = playlist.trackCount; delete job.error;
          }
        } else if (['FAILED', 'ERROR', 'REJECTED'].includes(String(track?.state).toUpperCase())) job.status = 'failed';
        if (['complete', 'failed'].includes(job.status)) job.updated_at = new Date(this.now()).toISOString();
        await this.persist();
      }
      if (['complete', 'failed', 'interrupted'].includes(job.status) || this.now() >= deadline) return this.publicJob(job);
      await this.sleep(Math.min(1000, Math.max(0, deadline - this.now())));
    }
  }
}
