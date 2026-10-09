import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpTools } from './mcp-tools.js';

export function createMcpApp({ service, accessKey, host = '127.0.0.1', publicOrigin }) {
  const app = createMcpExpressApp({ host, ...(publicOrigin ? { allowedHosts: [new URL(publicOrigin).hostname, 'localhost', '127.0.0.1', '[::1]'] } : {}) });
  const endpoint = `/mcp/${accessKey}`;
  // Browsers from unrelated origins cannot operate the authenticated server.
  app.use((req, res, next) => {
    if (req.headers.origin) {
      let origin;
      try { origin = new URL(req.headers.origin); } catch { res.sendStatus(403); return; }
      const sameOrigin = origin.origin === `http://${req.headers.host}` || origin.origin === publicOrigin;
      if (!sameOrigin) { res.sendStatus(403); return; }
    }
    next();
  });
  app.get('/health', (req, res) => res.json({ status: 'ok', service: 'yandex-music-uploader' }));
  app.post(endpoint, async (req, res) => {
    const server = createMcpTools(service);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'MCP request failed' }, id: null });
    }
  });
  app.all(endpoint, (req, res) => res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Use Streamable HTTP POST requests.' }, id: null }));
  app.use((error, req, res, next) => {
    if (res.headersSent) { next(error); return; }
    res.status(error.status ?? 500).json({ error: error.status === 413 ? 'Request body is too large.' : 'Invalid request.' });
  });
  return { app, endpoint };
}
