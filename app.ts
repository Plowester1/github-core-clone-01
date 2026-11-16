import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleRest } from './src/rest.ts';
import { handleGraphQL } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import { Store } from './src/store.ts';
import { json } from './src/util.ts';
import { handleGit } from './src/git.ts';

export function createApp(): Server {
  const store = new Store(process.env.MAKEFUN_SHOP_TOKEN ?? '');
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '/').split('?', 1)[0];
    if (path === '/api/graphql') { await handleGraphQL(req, res, store); return; }
    if (path === '/mcp') { await handleMcp(req, res, store); return; }
    let url: URL;
    try { url = new URL(req.url ?? '/', 'http://forge'); } catch { json(res, 404, { message: 'Not Found' }); return; }
    if (req.method === 'GET' && url.pathname === '/healthz') { json(res, 200, { ok: true }); return; }
    if (url.pathname.startsWith('/api/v3')) { await handleRest(req, res, store, url); return; }
    if (await handleGit(req, res, store, url)) return;
    json(res, 404, { message: 'Not Found' });
  });
}
