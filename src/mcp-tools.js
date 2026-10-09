import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { summarizeTrack } from './mcp-service.js';
import { maximumFileSize } from './audio.js';

const page = z.number().int().min(0).default(0).describe('Zero-based page index: page 0 is the first page and page 1 is the second. Omit this argument on the first call; for later calls, pass exactly the previous response next_page.');
const pageSize = z.number().int().min(1).max(100).default(50);
const playlistId = z.string().min(1).describe('Playlist UUID or https://music.yandex.kz/playlists/<uuid>.');

export function createMcpTools(service) {
  const server = new McpServer({ name: 'ya-music-uploader-mcp', version: '1.0.0' }, {
    instructions: 'Start with get_auth_status. If login is required, call init_auth, show the user verification_url and user_code, then call complete_auth. Repeat complete_auth with the same auth_id while pending. Call list_playlists without page on the first request (page 0); only request a later page when next_page is non-null, passing that exact value. Find the audio file using your filesystem tools and pass its absolute path on the server machine to upload_track. Relative paths resolve from the project root. upload_track returns a background job; check get_upload_status. Repeated submissions reuse a job; never use force after an uncertain transfer without checking its status. This server manages one Yandex account.',
  });
  const register = (name, description, inputSchema, readOnly, handler, destructive = false) => {
    server.registerTool(name, {
      description, inputSchema,
      annotations: { readOnlyHint: readOnly, destructiveHint: destructive, openWorldHint: true },
    }, async (input) => {
      try {
        const value = await (name === 'logout' ? handler(input) : service.runOperation(() => handler(input)));
        const result = JSON.parse(JSON.stringify(value));
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: error.message }] };
      }
    });
  };

  register('get_auth_status', 'Verify the saved OAuth token through the Music API. Never returns tokens.', {}, true,
    () => service.getAuthStatus());
  register('logout', 'Sign out of Yandex Music. Attempt to revoke the device OAuth token, then delete the saved token and all upload history and reset pending login. Waits for current requests and the active upload to finish; skips queued uploads. Keeps the MCP access key, audio files, and Yandex playlists. Check remote_revocation; failed means remote access must be revoked manually.', {}, false,
    () => service.logout(), true);
  register('init_auth', 'Start login and return auth_id, URL, and code immediately. Show the URL and code BEFORE calling complete_auth. Reuses a pending code.', {}, false,
    () => service.auth.init());
  register('complete_auth', 'Wait for user approval, verify the account, and save its token. Repeat with the same auth_id while pending. If expired, call init_auth again. wait_seconds=0 performs at most one eligible poll.', {
    auth_id: z.string().uuid(), wait_seconds: z.number().min(0).max(45).default(20),
  }, false, ({ auth_id, wait_seconds }) => service.auth.complete(auth_id, wait_seconds));
  register('list_playlists', 'List owned playlists with UUIDs, URLs, and track counts. Pagination is zero-based: the first page is page 0; page 1 is the second page. Omit page on the first call. Request another page only when next_page is not null, passing that exact value.', {
    page, page_size: pageSize,
  }, true, ({ page, page_size }) => service.listPlaylists({ page, pageSize: page_size }));
  register('create_playlist', 'Create a playlist, private by default. reuse_existing returns a playlist with the same title and visibility to avoid duplicates; its description is unchanged.', {
    title: z.string().trim().min(1).max(200), description: z.string().max(5000).default(''),
    visibility: z.enum(['private', 'public']).default('private'), reuse_existing: z.boolean().default(true),
  }, false, ({ title, description, visibility, reuse_existing }) => service.createPlaylist({ title, description, visibility, reuseExisting: reuse_existing }));
  register('list_playlist_tracks', 'Read a playlist page with track IDs, titles, durations, states, and next_page. Pagination is zero-based: the first page is page 0; page 1 is the second page. Omit page on the first call. Request another page only when next_page is not null, passing that exact value.', {
    playlist_id: playlistId, page, page_size: pageSize,
  }, true, ({ playlist_id, page, page_size }) => service.listPlaylistTracks({ playlistId: playlist_id, page, pageSize: page_size }));
  register('upload_track', `Queue an audio upload to an owned playlist. Pass file_path as an absolute local path on the server machine (preferred) or a path relative to the project root. Requires a non-empty MP3, FLAC, WAV, OGG, M4A, AAC, OPUS, or WMA file up to ${maximumFileSize / (1024 * 1024)} MiB. Returns job_id; check get_upload_status. Identical submissions reuse retained jobs; successful history expires after 30 days. force=true deliberately creates a new upload.`, {
    file_path: z.string().trim().min(1).describe('Local audio file path on the machine running this MCP server.'),
    playlist_id: playlistId, force: z.boolean().default(false),
  }, false, ({ file_path, playlist_id, force }) => service.startUpload({ filePath: file_path, playlistId: playlist_id, force }));
  register('get_upload_status', 'Check a persistent background upload. complete confirms a playable track in the playlist. unknown means an uncertain transfer; checking may confirm completion without resending. Interrupted jobs are never resent automatically.', {
    job_id: z.string().uuid(), wait_seconds: z.number().min(0).max(30).default(0),
  }, true, ({ job_id, wait_seconds }) => service.uploadStatus(job_id, wait_seconds));
  register('get_track_status', 'Check a track state by its ID.', {
    track_id: z.string().min(1),
  }, true, async ({ track_id }) => {
    const track = await (await service.client()).getTrack(track_id);
    return { track: track ? summarizeTrack(track) : null };
  });
  return server;
}
