import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { defaultTokenPath } from './device-auth.js';
import { MusicService } from './mcp-service.js';
import { createMcpApp } from './mcp-http.js';
import { writeState } from './state.js';

async function accessKey(path) {
  try {
    const { key } = JSON.parse(await readFile(path, 'utf8'));
    if (!/^[a-f0-9]{64}$/.test(key ?? '')) throw new Error('Invalid MCP access key format.');
    return key;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const key = randomBytes(32).toString('hex');
  await writeState({ key }, path);
  return key;
}

async function main() {
  const { values } = parseArgs({ options: {
    host: { type: 'string', default: process.env.MCP_HOST ?? '127.0.0.1' },
    port: { type: 'string', default: process.env.MCP_PORT ?? '3000' },
    token: { type: 'string', default: process.env.YANDEX_TOKEN_FILE ?? defaultTokenPath },
    'public-url': { type: 'string', default: process.env.MCP_PUBLIC_URL },
    help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('npm start -- [--port 3000] [--host 127.0.0.1] [--token .auth/oauth.json] [--public-url https://music-mcp.example.com]');
    return;
  }
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid TCP port.');
  let publicOrigin;
  if (values['public-url']) {
    const publicUrl = new URL(values['public-url']);
    if (publicUrl.protocol !== 'https:' || publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash || publicUrl.username || publicUrl.password) {
      throw new Error('--public-url must be an HTTPS origin without a path, query, or credentials.');
    }
    publicOrigin = publicUrl.origin;
  }
  const tokenPath = resolve(values.token);
  const stateDirectory = dirname(tokenPath);
  const service = new MusicService({ tokenPath, jobsPath: resolve(stateDirectory, 'mcp-uploads.json') });
  await service.initialize();
  const key = await accessKey(resolve(stateDirectory, 'mcp-key.json'));
  const { app, endpoint } = createMcpApp({ service, accessKey: key, host: values.host, publicOrigin });
  const listener = await new Promise((resolve, reject) => {
    const listener = app.listen(port, values.host, () => resolve(listener));
    listener.once('error', reject);
  });
  const displayHost = ['0.0.0.0', '::'].includes(values.host) ? '127.0.0.1' : values.host;
  const addressHost = displayHost.includes(':') ? `[${displayHost}]` : displayHost;
  console.log(`MCP URL: ${publicOrigin ?? `http://${addressHost}:${listener.address().port}`}${endpoint}`);
  console.log('Transport: Streamable HTTP. Add the MCP URL to your agent settings.');
  const shutdown = () => {
    console.log('Stopping MCP. Incomplete transfers will not be retried automatically after restart.');
    listener.close();
    listener.closeAllConnections();
    setTimeout(() => process.exit(0), 200).unref();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((error) => { console.error(`MCP error: ${error.message}`); process.exitCode = 1; });
