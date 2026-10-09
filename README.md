# ya-music-uploader-mcp

A [Model Context Protocol](https://modelcontextprotocol.io/) server for signing in to Yandex Music, managing playlists, and uploading personal audio files. Uses OAuth device login and native HTTP requests. Runs natively on Windows, Linux, and WSL, including on a server without a browser or GUI.

This project uses unofficial Yandex Music endpoints, which may change. Device login uses the public Android application credentials documented by [yandex-music-api](https://github.com/MarshalX/yandex-music-api/blob/main/yandex_music/_client/device_auth.py).

## Quick start

Requires Node.js 22 or later.

```sh
npm ci
npm start
```

By default the server uses the MCP `stdio` transport. To use Streamable HTTP instead, start it explicitly:

```sh
npm start -- --transport http
```

The HTTP server prints a URL:

```text
MCP URL: http://127.0.0.1:3000/mcp/<access-key>
```

Add that URL to your agent as a **Streamable HTTP** MCP server. The access key persists across restarts. Treat the complete URL as a credential: anyone with access can operate the connected account.

The server runs locally and manages one Yandex account. Audio files are read directly from local paths. No dedicated audio directory is required.

### stdio transport

For MCP clients that launch a local server process, the default stdio transport is suitable:

```sh
npm start
```

The explicit form is `npm start -- --transport stdio`; `MCP_TRANSPORT=stdio` can also be used. In stdio mode MCP messages use the process's stdin/stdout, so diagnostic messages are written to stderr and no MCP URL is printed. Configure the client with the command `npm` and argument `start` (on Windows use `npm.cmd` if the client does not resolve `npm` automatically), or use the absolute path to `node` and `src/mcp-server.js`. Streamable HTTP remains available with `--transport http`.

## Sign in

1. Call `get_auth_status` to check the saved account.
2. Call `init_auth` and show the user its `verification_url` and `user_code`.
3. The user opens the URL in their own browser and approves the login.
4. Call `complete_auth` with `auth_id`. Repeat with the same ID while `status` is `pending`; start again if expired.

`complete_auth` waits up to 45 seconds per call. Keeping these two tools separate lets the assistant show the code before waiting. A pending login must start again after a server restart. The OAuth token is saved privately and refreshed when possible; it is never returned by a tool. A passkey can be used in the user's browser when Yandex offers it.

### Sign out and revoke access

Call `logout` to delete the saved OAuth token and all upload history, clear the cached client, and reset pending login. It waits for current requests and the active upload to finish, and skips queued uploads. While logout is running, other tool calls are rejected. Removing history also removes upload deduplication records. The MCP access key, source audio files, and Yandex playlists remain unchanged; use `init_auth` to sign in again with the same MCP URL.

Before deleting the token, `logout` attempts the official Yandex OAuth [device-token revocation](https://yandex.ru/dev/id/doc/ru/tokens/token-invalidate) endpoint, `POST /revoke_token`. Our device login supplies `device_id` and `device_name`. The response field `remote_revocation` is `revoked` when Yandex confirms revocation (including an already invalid token), `not_attempted` when no saved token exists, or `failed` when revocation could not be confirmed. Local cleanup still proceeds if revocation fails.

If remote revocation fails, open [Yandex application access](https://id.yandex.ru/personal/data-access), find the relevant Music authorization, and revoke it. Because device login uses the public Android application credentials, the entry may be named Yandex Music rather than this project. Revoking the OAuth token does not sign out your browser or other Yandex sessions. To end a separate device session, open [Yandex ID security](https://id.yandex.ru/security/devices) and sign out the corresponding session if listed.

For a complete manual reset, stop the server and delete `.ya/` with the default configuration. This also removes the MCP access key, so the next start generates a new MCP URL that you must update in your agent configuration. If you configured `--token`, remove that token and the server state files next to it instead. Manual deletion only clears local data; revoke remote access separately as described above.

## Upload local audio

Find the file using your agent's filesystem tools and pass its absolute path on the server machine directly to `upload_track`:

```json
{
  "file_path": "/home/user/Music/track.mp3",
  "playlist_id": "<playlist-uuid-from-list_playlists>"
}
```

Absolute paths are recommended and can point to any audio file readable by the server process. Relative paths resolve from the directory where you started the server; for example, `test-data/sample-30s.mp3` when started from the project root.

On WSL, use Linux paths such as `/home/user/Music/track.mp3` or `/mnt/c/Users/user/Music/track.mp3`.

`upload_track` reads the original file as a stream and uploads it to Yandex Music. It returns a `job_id` immediately; call `get_upload_status` until complete. Keep the source file available and unchanged until the job finishes. The server does not copy or delete your audio files.

Repeated submissions of the same unchanged file to the same playlist reuse the saved job while its history is retained, unless `force` is set. Absolute paths, relative paths, and symlinks resolving to the same file share the same job.

Supported filename extensions: MP3, FLAC, WAV, OGG, M4A, AAC, OPUS, and WMA. The maximum file size is 400 MiB; format acceptance and account upload quotas are enforced by Yandex.

The path must exist on the machine running this MCP server. If you later deploy the server elsewhere, the audio must be accessible on that server's filesystem.

## Tools

| Tool | Purpose |
| --- | --- |
| `get_auth_status` | Verify the saved account |
| `logout` | Revoke the device token when possible; delete local token and upload history |
| `init_auth` | Return a login URL and code |
| `complete_auth` | Wait for approval and save the verified token |
| `list_playlists` | List owned playlists |
| `create_playlist` | Create a private or public playlist; reuse matching titles by default |
| `list_playlist_tracks` | Read a page of playlist tracks |
| `upload_track` | Queue an upload from a local `file_path` |
| `get_upload_status` | Check a persistent upload job |
| `get_track_status` | Check a track's processing state |

Playlists must be selected explicitly by UUID or a Yandex Music playlist URL. Use pagination fields to read subsequent pages. Uploads are serialized. A completed job confirms both a playable track and playlist membership.

If a transfer is interrupted, its outcome may be unknown. Check the existing job or track before retrying. Jobs survive restarts, and interrupted transfers are never resent automatically. `force: true` intentionally bypasses deduplication and can create a duplicate.

## Upload history

Upload jobs are stored in `.ya/mcp-uploads.json` by default, or next to the token file when `--token` is configured. Expired records are removed at server startup and before each upload submission; no background cleanup timer runs.

| Job status | Retention |
| --- | --- |
| `complete` | 30 days after completion |
| `failed` without a `track_id` (failure before a remote track was reserved) | 7 days after failure |
| `unknown`, `interrupted`, or `failed` with a `track_id` | Until resolved or cleared by `logout` |
| Queued or active jobs | Preserved; after restart they become `unknown` or `interrupted` |

Retention uses `updated_at`, falling back to `created_at` for older records. Records without a valid timestamp are preserved. When an uncertain upload is confirmed complete, its 30-day retention starts at confirmation.

Deleting a history record removes its `job_id` lookup and duplicate protection. Sending the same file again after expiry can create a duplicate in Yandex Music. History cleanup only removes local job records; uploaded tracks and source files remain unchanged. `logout` clears all history regardless of age or status.

## Configuration and deployment

| CLI option | Environment variable | Default |
| --- | --- | --- |
| `--host` | `MCP_HOST` | `127.0.0.1` |
| `--port` | `MCP_PORT` | `3000` |
| `--token` | `YANDEX_TOKEN_FILE` | `.ya/oauth.json` |
| `--public-url` | `MCP_PUBLIC_URL` | Unset |

For remote agents, put the server behind an HTTPS reverse proxy:

```sh
npm start -- --public-url https://music-mcp.example.com
```

Forward `/mcp/` to the local server. Audio uploads run as background jobs, so only MCP JSON requests pass through the proxy. `--public-url` accepts an HTTPS origin, without a path. Bind another interface with `--host` only if your deployment requires it.

Persistent data lives in `.ya/` by default: `oauth.json`, `mcp-key.json`, and `mcp-uploads.json`. With a custom token path, the MCP key and upload history live next to that token file. Token and state files use owner-only permissions. Keep that directory private and persist it across deployments. `.ya/`, local test audio, dependencies, environment files, and IDE metadata are excluded from Git; npm package contents use an explicit allowlist.

## Development

```sh
npm test
npm pack --dry-run
```

Tests exercise the real MCP HTTP transport, authentication polling, local file paths, upload deduplication, restart recovery, and Yandex request contracts using mocks. They do not modify a real Yandex account.

Licensed under ISC.
