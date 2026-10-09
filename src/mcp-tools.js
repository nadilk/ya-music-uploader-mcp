import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { summarizeTrack } from './mcp-service.js';
import { maximumFileSize } from './audio.js';

const page = z.number().int().min(0).default(0);
const pageSize = z.number().int().min(1).max(100).default(50);
const playlistId = z.string().min(1).describe('Playlist UUID or https://music.yandex.kz/playlists/<uuid>.');

export function createMcpTools(service) {
  const server = new McpServer({ name: 'ya-music-uploader-mcp', version: '1.0.0' }, {
    instructions: 'Start with get_auth_status. If login is required, call init_auth, show the user verification_url and user_code, then call complete_auth. Repeat complete_auth with the same auth_id while pending. Find the audio file using your filesystem tools and pass its absolute path on the server machine to upload_track. Relative paths resolve from the directory where the server was started. upload_track returns a background job; check get_upload_status. Repeated submissions reuse a job; never use force after an uncertain transfer without checking its status. This server manages one Yandex account.',
  });
  const register = (name, description, inputSchema, readOnly, handler) => {
    server.registerTool(name, {
      description, inputSchema,
      annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: true },
    }, async (input) => {
      try {
        const result = JSON.parse(JSON.stringify(await handler(input)));
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: error.message }] };
      }
    });
  };

  register('get_auth_status', 'Verify the saved OAuth token through the Music API. Never returns tokens.', {}, true,
    () => service.getAuthStatus());
  register('init_auth', 'Start login and return auth_id, URL, and code immediately. Show the URL and code BEFORE calling complete_auth. Reuses a pending code.', {}, false,
    () => service.auth.init());
  register('complete_auth', 'Wait for user approval, verify the account, and save its token. Repeat with the same auth_id while pending. If expired, call init_auth again. wait_seconds=0 performs at most one eligible poll.', {
    auth_id: z.string().uuid(), wait_seconds: z.number().min(0).max(45).default(20),
  }, false, ({ auth_id, wait_seconds }) => service.auth.complete(auth_id, wait_seconds));
  register('list_playlists', 'List owned playlists with UUIDs, URLs, and track counts. Use next_page for pagination.', {
    page, page_size: pageSize,
  }, true, ({ page, page_size }) => service.listPlaylists({ page, pageSize: page_size }));
  register('create_playlist', 'Create a playlist, private by default. reuse_existing returns a playlist with the same title and visibility to avoid duplicates; its description is unchanged.', {
    title: z.string().trim().min(1).max(200), description: z.string().max(5000).default(''),
    visibility: z.enum(['private', 'public']).default('private'), reuse_existing: z.boolean().default(true),
  }, false, ({ title, description, visibility, reuse_existing }) => service.createPlaylist({ title, description, visibility, reuseExisting: reuse_existing }));
  register('list_playlist_tracks', 'Read a playlist page with track IDs, titles, durations, states, and next_page.', {
    playlist_id: playlistId, page, page_size: pageSize,
  }, true, ({ playlist_id, page, page_size }) => service.listPlaylistTracks({ playlistId: playlist_id, page, pageSize: page_size }));
  register('upload_track', `Queue an audio upload to an owned playlist. Pass file_path as an absolute local path on the server machine (preferred) or a path relative to the directory where the server was started. Requires a non-empty MP3, FLAC, WAV, OGG, M4A, AAC, OPUS, or WMA file up to ${maximumFileSize / (1024 * 1024)} MiB. Returns job_id; check get_upload_status. Identical submissions reuse the stored job. force=true deliberately creates a new upload.`, {
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
