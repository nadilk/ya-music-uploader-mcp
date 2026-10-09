# ya-music-uploader-mcp

A [Model Context Protocol](https://modelcontextprotocol.io/) server for signing in to Yandex Music, managing playlists, and uploading personal audio files. Uses OAuth device login and native HTTP requests. Runs on WSL or a server without a browser or GUI.

This project uses unofficial Yandex Music endpoints, which may change. Device login uses the public Android application credentials documented by [yandex-music-api](https://github.com/MarshalX/yandex-music-api/blob/main/yandex_music/_client/device_auth.py).

## Quick start

Requires Node.js 22 or later.

```sh
npm ci
npm start
```

The server prints a URL:

```text
MCP URL: http://127.0.0.1:3000/mcp/<access-key>
```

Add that URL to your agent as a **Streamable HTTP** MCP server. The access key persists across restarts. Treat the complete URL as a credential: anyone with access can operate the connected account.

The server runs locally and manages one Yandex account. Audio files are read directly from local paths. No dedicated audio directory is required.

## Sign in

1. Call `get_auth_status` to check the saved account.
2. Call `init_auth` and show the user its `verification_url` and `user_code`.
3. The user opens the URL in their own browser and approves the login.
4. Call `complete_auth` with `auth_id`. Repeat with the same ID while `status` is `pending`; start again if expired.

`complete_auth` waits up to 45 seconds per call. Keeping these two tools separate lets the assistant show the code before waiting. A pending login must start again after a server restart. The OAuth token is saved privately and refreshed when possible; it is never returned by a tool. A passkey can be used in the user's browser when Yandex offers it.

### Sign out and revoke access

Stop the server before removing credentials. With the default configuration, deleting `.auth/` removes the saved OAuth token, MCP access key, and upload history. Audio files and playlists remain unchanged. If you configured `--token`, remove that token and the server state files next to it instead.

Local deletion does not revoke access in your Yandex account. Open [Yandex application access](https://passport.yandex.ru/profile/access), find the relevant Music authorization, and revoke it. Because device login uses the public Android application credentials, the entry may be named Yandex Music rather than this project. To end a device session, open [Yandex ID security](https://id.yandex.ru/security), find the corresponding device or active session, and sign it out if listed.

On the next start, the server generates a new MCP URL. Update your agent configuration and use `init_auth` to sign in again.

## Upload local audio

Pass the local audio path directly to `upload_track`:

```json
{
  "file_path": "/home/user/Music/track.mp3",
  "playlist_id": "<playlist-uuid-from-list_playlists>"
}
```

Absolute paths can point to any audio file readable by the server process. Relative paths resolve from the directory where you started the server; for example, `test-data/sample-30s.mp3` when started from the project root. `get_server_info` returns that working directory, and `list_local_files` can browse a local directory for audio files.

On WSL, use Linux paths such as `/home/user/Music/track.mp3` or `/mnt/c/Users/user/Music/track.mp3`.

`upload_track` reads the original file as a stream and uploads it to Yandex Music. It returns a `job_id` immediately; call `get_upload_status` until complete. Keep the source file available and unchanged until the job finishes. The server does not copy or delete your audio files.

Repeated submissions of the same unchanged file to the same playlist reuse the saved job unless `force` is set. Absolute paths, relative paths, and symlinks resolving to the same file share the same job.

Supported filename extensions: MP3, FLAC, WAV, OGG, M4A, AAC, OPUS, and WMA. The maximum file size is 400 MiB; format acceptance and account upload quotas are enforced by Yandex.

The path must exist on the machine running this MCP server. If you later deploy the server elsewhere, the audio must be accessible on that server's filesystem.

## Tools

| Tool | Purpose |
| --- | --- |
| `get_server_info` | Working directory, audio size limit, and authentication method |
| `get_auth_status` | Verify the saved account |
| `init_auth` | Return a login URL and code |
| `complete_auth` | Wait for approval and save the verified token |
| `list_playlists` | List owned playlists |
| `create_playlist` | Create a private or public playlist; reuse matching titles by default |
| `list_playlist_tracks` | Read a page of playlist tracks |
| `upload_track` | Queue an upload from a local `file_path` |
| `get_upload_status` | Check a persistent upload job |
| `get_track_status` | Check a track's processing state |
| `list_local_files` | Browse audio files in a local directory |

Playlists must be selected explicitly by UUID or a Yandex Music playlist URL. Use pagination fields to read subsequent pages. Uploads are serialized. A completed job confirms both a playable track and playlist membership.

If a transfer is interrupted, its outcome may be unknown. Check the existing job or track before retrying. Jobs survive restarts, and interrupted transfers are never resent automatically. `force: true` intentionally bypasses deduplication and can create a duplicate.

## Configuration and deployment

| CLI option | Environment variable | Default |
| --- | --- | --- |
| `--host` | `MCP_HOST` | `127.0.0.1` |
| `--port` | `MCP_PORT` | `3000` |
| `--token` | `YANDEX_TOKEN_FILE` | `.auth/oauth.json` |
| `--public-url` | `MCP_PUBLIC_URL` | Unset |

For remote agents, put the server behind an HTTPS reverse proxy:

```sh
npm start -- --public-url https://music-mcp.example.com
```

Forward `/mcp/` to the local server. Audio uploads run as background jobs, so only MCP JSON requests pass through the proxy. `--public-url` accepts an HTTPS origin, without a path. Bind another interface with `--host` only if your deployment requires it.

Persistent data lives next to the token file: `mcp-key.json` and `mcp-uploads.json`. Token and state files use owner-only permissions. Keep that directory private and persist it across deployments. `.auth/`, local test audio, dependencies, environment files, and IDE metadata are excluded from Git; npm package contents use an explicit allowlist.

## Development

```sh
npm test
npm pack --dry-run
```

Tests exercise the real MCP HTTP transport, authentication polling, local file paths, upload deduplication, restart recovery, and Yandex request contracts using mocks. They do not modify a real Yandex account.

Licensed under ISC.
