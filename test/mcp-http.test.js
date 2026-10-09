import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpApp } from '../src/mcp-http.js';

test('real MCP client initializes, lists tools, and calls them over Streamable HTTP', async (t) => {
  const service = {
    startUpload: async (input) => ({ job_id: 'local-job', ...input }),
    getAuthStatus: async () => ({ authenticated: true, uid: '123' }),
    listPlaylists: async ({ page, pageSize }) => ({ playlists: [{ id: 'example', title: 'Sample' }], page, page_size: pageSize }),
  };
  const { app, endpoint } = createMcpApp({ service, accessKey: 'test-secret' });
  const listener = await new Promise((resolve) => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
  t.after(() => { listener.closeAllConnections(); return new Promise((resolve) => listener.close(resolve)); });
  const origin = `http://127.0.0.1:${listener.address().port}`;
  const client = new Client({ name: 'integration-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}${endpoint}`)));
  const { tools } = await client.listTools();
  for (const name of ['init_auth', 'complete_auth', 'list_playlists', 'create_playlist', 'upload_track', 'get_upload_status', 'list_playlist_tracks']) assert.ok(tools.some((tool) => tool.name === name));
  const upload = tools.find((tool) => tool.name === 'upload_track');
  assert.ok(upload.inputSchema.required.includes('file_path'));
  assert.equal(upload.inputSchema.properties.file_id, undefined);
  assert.equal(tools.some((tool) => ['list_staged_files', 'delete_staged_file', 'list_local_files', 'get_server_info'].includes(tool.name)), false);
  assert.equal((await client.callTool({ name: 'upload_track', arguments: { playlist_id: '00000000-0000-4000-8000-000000000001' } })).isError, true);
  const job = (await client.callTool({ name: 'upload_track', arguments: { file_path: '/home/user/song.mp3', playlist_id: '00000000-0000-4000-8000-000000000001' } })).structuredContent;
  assert.equal(job.filePath, '/home/user/song.mp3');
  assert.equal((await fetch(`${origin}${endpoint}/files/sample.mp3`, { method: 'PUT', body: 'audio' })).status, 404);
  const auth = await client.callTool({ name: 'get_auth_status', arguments: {} });
  assert.deepEqual(auth.structuredContent, { authenticated: true, uid: '123' });
  const playlists = await client.callTool({ name: 'list_playlists', arguments: {} });
  assert.equal(playlists.structuredContent.page_size, 50);
  assert.equal((await client.callTool({ name: 'list_playlists', arguments: { page_size: 10000 } })).isError, true);
  assert.equal((await fetch(`${origin}/mcp/wrong-key`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 404);
  assert.equal((await fetch(`${origin}${endpoint}`, { method: 'POST', headers: { origin: 'https://unrelated.example.com', 'content-type': 'application/json' }, body: '{}' })).status, 403);
});
