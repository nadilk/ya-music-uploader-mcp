import { randomUUID } from 'node:crypto';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { AuthFlow } from './mcp-auth.js';
import { createMusicClient, parsePlaylistId } from './music-client.js';
import { writeState } from './state.js';
import { audioExtensions, maximumFileSize } from './audio.js';

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
  constructor({ tokenPath, jobsPath, workingDirectory = process.cwd(), clientFactory, auth, now = Date.now, sleep = setTimeout }) {
    this.tokenPath = tokenPath;
    this.workingDirectory = resolve(workingDirectory);
    this.jobsPath = jobsPath;
    this.clientFactory = clientFactory ?? (() => createMusicClient({ tokenPath }));
    this.auth = auth ?? new AuthFlow({ tokenPath });
    this.now = now;
    this.sleep = sleep;
    this.jobs = new Map();
    this.uploadQueue = Promise.resolve();
    this.submissions = Promise.resolve();
    this.creations = Promise.resolve();
    this.persistence = Promise.resolve();
  }

  async initialize() {
    this.workingDirectory = await realpath(this.workingDirectory);
    let saved;
    try { saved = JSON.parse(await readFile(this.jobsPath, 'utf8')); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return;
    }
    for (const job of saved.jobs ?? []) {
      if (!['complete', 'failed', 'unknown', 'interrupted'].includes(job.status)) {
        job.status = job.track_id ? 'unknown' : 'interrupted';
        job.error = 'The server restarted. Transfers are not repeated automatically; check the existing track_id.';
      }
      this.jobs.set(job.job_id, job);
    }
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

  async listLocalFiles({ directory = '.', offset = 0, limit = 100 } = {}) {
    const folder = await this.resolveLocalPath(directory);
    const entries = (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    const available = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      let path;
      try { path = await this.resolveLocalPath(resolve(folder, entry.name)); } catch { continue; }
      const info = await stat(path);
      if (info.isDirectory() || (info.isFile() && audioExtensions.has(extname(path).toLowerCase()))) {
        available.push({ name: entry.name, path, type: info.isDirectory() ? 'directory' : 'audio', size_bytes: info.isFile() ? info.size : undefined });
      }
    }
    return { directory: folder, files: available.slice(offset, offset + limit), total: available.length, next_offset: offset + limit < available.length ? offset + limit : null };
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
      try { await this.persist(); } catch { /* The in-memory job remains queryable. */ }
    }
  }

  async uploadStatus(jobId, waitSeconds = 0) {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error('Unknown job_id.');
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
        await this.persist();
      }
      if (['complete', 'failed', 'interrupted'].includes(job.status) || this.now() >= deadline) return this.publicJob(job);
      await this.sleep(Math.min(1000, Math.max(0, deadline - this.now())));
    }
  }
}
