import { openAsBlob } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { defaultTokenPath, loadToken, refreshToken, saveToken, verifyMusicToken } from './device-auth.js';

import { maximumFileSize } from './audio.js';

const apiOrigin = 'https://api.music.yandex.net';

export function parsePlaylistId(value) {
  let id = value;
  if (typeof value !== 'string') throw new Error('A playlist UUID or URL is required.');
  if (value.startsWith('https://')) {
    const url = new URL(value);
    if (!/^music\.yandex\.(kz|ru|com)$/.test(url.hostname)) throw new Error('Expected a Yandex Music playlist URL.');
    id = url.pathname.match(/^\/playlists\/([^/]+)\/?$/)?.[1];
  }
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id ?? '')) throw new Error('Expected a playlist UUID or https://music.yandex.kz/playlists/<uuid>.');
  return id.toLowerCase();
}

export class MusicClient {
  constructor({ getToken, fetchImpl = globalThis.fetch, sleep = setTimeout }) {
    this.getToken = getToken;
    this.fetch = fetchImpl;
    this.sleep = sleep;
  }

  async request(path, { method = 'GET', query, body } = {}) {
    const url = new URL(path, `${apiOrigin}/`);
    if (query) for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    const token = await this.getToken();
    const response = await this.fetch(url, {
      method, body, headers: { authorization: `OAuth ${token.access_token}` },
      redirect: 'error', signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`API ${path}: HTTP ${response.status}.`);
    const data = await response.json();
    if (data.error) throw new Error(`API ${path}: ${typeof data.error === 'string' ? data.error : data.error.name ?? 'error'}.`);
    return data.result ?? data;
  }

  async getPlaylist(playlistId, { page = 0, pageSize = 100 } = {}) {
    return this.request(`playlist/${parsePlaylistId(playlistId)}`, {
      query: { resumeStream: false, richTracks: true, page, pageSize },
    });
  }

  async listPlaylists({ page = 0, pageSize = 100 } = {}) {
    const token = await this.getToken();
    const playlists = await this.request(`users/${encodeURIComponent(token.uid)}/playlists/list`, {
      query: { page, pageSize },
    });
    if (!Array.isArray(playlists)) throw new Error('The API returned an invalid playlist list.');
    return playlists;
  }

  async createPlaylist({ title, description = '', visibility = 'private' }) {
    if (!title?.trim()) throw new Error('A playlist title is required.');
    if (!['private', 'public'].includes(visibility)) throw new Error('Visibility must be private or public.');
    const token = await this.getToken();
    return this.request(`users/${encodeURIComponent(token.uid)}/playlists/create`, {
      method: 'POST', query: { title: title.trim(), description, visibility },
    });
  }

  async listTracks(playlistId, { pageSize = 100 } = {}) {
    const playlist = await this.getPlaylist(playlistId, { pageSize });
    const tracks = [...(playlist.tracks ?? [])];
    const total = playlist.pager?.total ?? playlist.trackCount ?? tracks.length;
    let page = 1;
    while (tracks.length < total) {
      const next = await this.getPlaylist(playlistId, { page: page++, pageSize });
      if (!next.tracks?.length) throw new Error('The API returned an empty page before the end of the track list.');
      if (next.pager && next.pager.page !== page - 1) throw new Error('The API returned a different playlist page.');
      if (next.revision !== playlist.revision) throw new Error('The playlist changed during pagination. Repeat the list request.');
      tracks.push(...next.tracks);
    }
    return { ...playlist, tracks, trackCount: total };
  }

  async getTrack(trackId) {
    const body = new FormData();
    body.append('trackIds', String(trackId));
    body.append('removeDuplicates', 'false');
    body.append('withProgress', 'true');
    const tracks = await this.request('tracks', { method: 'POST', body });
    if (!Array.isArray(tracks)) throw new Error('The tracks API returned an invalid response.');
    return tracks.find((track) => String(track.id) === String(trackId)) ?? null;
  }

  async waitForTrack(trackId, { attempts = 25, intervalMs = 3000, onProgress = () => {} } = {}) {
    let track;
    for (let attempt = 0; attempt < attempts; attempt++) {
      track = await this.getTrack(trackId);
      await onProgress({ stage: 'processing', trackId, state: track?.state ?? 'PENDING', attempt: attempt + 1 });
      if (String(track?.state).toUpperCase() === 'PLAYABLE') return track;
      if (['FAILED', 'ERROR', 'REJECTED'].includes(String(track?.state).toUpperCase())) {
        throw new Error(`Yandex could not process track ${trackId}: ${track.state}.`);
      }
      if (attempt < attempts - 1) await this.sleep(intervalMs);
    }
    throw new Error(`Track ${trackId} was submitted but is still processing (${track?.state ?? 'PENDING'}). Check get_track_status; do not upload the file again.`);
  }

  async uploadFile(filePath, { playlistId, wait = true, onProgress = () => {} } = {}) {
    const info = await stat(filePath);
    if (!info.isFile() || info.size === 0) throw new Error('A non-empty audio file is required.');
    if (info.size > maximumFileSize) throw new Error('The file exceeds the 400 MiB upload limit.');
    const playlist = await this.getPlaylist(playlistId, { pageSize: 1 });
    const token = await this.getToken();
    if (String(playlist.uid) !== String(token.uid)) throw new Error('Files can only be uploaded to your own playlist.');
    const filename = basename(filePath);
    const mime = { '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac' }[extname(filename).toLowerCase()] ?? 'application/octet-stream';
    // Open the file before reserving a remote track; Blob reads it as a stream.
    const file = await openAsBlob(filePath, { type: mime });
    const upload = await this.request('loader/upload-url', {
      method: 'POST', query: { uid: token.uid, 'playlist-id': `${playlist.uid}:${playlist.kind}`, path: filename },
    });
    if (upload === 'TOO_MANY_FILES' || upload?.result === 'TOO_MANY_FILES') throw new Error('Yandex returned TOO_MANY_FILES: the personal upload limit was reached.');
    if (!upload || typeof upload !== 'object') throw new Error('The API returned an invalid loader/upload-url response.');
    const target = upload['post-target'];
    const trackId = upload['ugc-track-id'];
    if (!target || !trackId) throw new Error('The API did not return post-target and ugc-track-id.');
    const targetUrl = new URL(target);
    if (targetUrl.protocol !== 'https:' || targetUrl.username || targetUrl.password) throw new Error('The API returned an invalid upload URL.');
    await onProgress({ stage: 'prepared', trackId, filename, playlistId: playlist.playlistUuid, size: info.size });
    const body = new FormData();
    body.append('file', file, filename);
    // The storage receives the signed URL and file, never the account's OAuth token.
    let response;
    try {
      response = await this.fetch(targetUrl, { method: 'POST', body, redirect: 'error', signal: AbortSignal.timeout(5 * 60_000) });
    } catch {
      throw new Error(`Transfer of track ${trackId} was interrupted. The outcome is unknown; check get_upload_status before retrying.`);
    }
    if (!response.ok) throw new Error(`Storage returned HTTP ${response.status} for track ${trackId}.`);
    const content = await response.text();
    if (content.trim()) {
      let result;
      try { result = JSON.parse(content); } catch { throw new Error(`Storage returned an unexpected response for track ${trackId}. Check get_upload_status.`); }
      if (result.error || result.status === 'error') throw new Error(`Storage rejected track ${trackId}.`);
    }
    await onProgress({ stage: 'submitted', trackId, filename });
    if (!wait) return { trackId, stage: 'submitted', playlistId: playlist.playlistUuid };
    const track = await this.waitForTrack(trackId, { onProgress });
    const updated = await this.listTracks(playlistId);
    if (!updated.tracks.some((item) => String(item.id) === String(trackId))) {
      throw new Error(`Track ${trackId} was processed but is not yet in the playlist. Do not upload the file again.`);
    }
    await onProgress({ stage: 'complete', trackId, filename });
    return { trackId, stage: 'complete', track, playlistId: playlist.playlistUuid, trackCount: updated.trackCount };
  }
}

export async function createMusicClient({ tokenPath = defaultTokenPath, fetchImpl = globalThis.fetch } = {}) {
  let refreshing;
  const getToken = async () => {
    let token = await loadToken(tokenPath);
    if (token.expires_at && token.expires_at <= Date.now() + 30_000) {
      if (!refreshing) {
        refreshing = (async () => {
          const refreshed = await refreshToken(token, fetchImpl);
          const account = await verifyMusicToken(refreshed, fetchImpl);
          await saveToken(refreshed, tokenPath, account);
          return { ...refreshed, uid: String(account.uid) };
        })().finally(() => { refreshing = undefined; });
      }
      token = await refreshing;
    }
    return token;
  };
  await getToken();
  return new MusicClient({ getToken, fetchImpl });
}
