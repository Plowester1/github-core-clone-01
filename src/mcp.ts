import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { repoJson, issueJson, pullJson } from './rest.ts';
import { empty, json, readBody, requestId, JSON_TYPE, text } from './util.ts';

const versions = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const identity = { name: 'standalone-forge', version: '1.0.0' };
const capabilities = { tools: { listChanged: false } };
const string = { type: 'string' };
const repository = { owner: string, repo: string, full_name: string };
const tools = [
  { name: 'create_repo', description: 'Create a repository owned by the authenticated user.', inputSchema: { type: 'object', properties: { name: string, description: string, private: { type: 'boolean' } }, required: ['name'] } },
  { name: 'get_repo', description: 'Read a repository and its stable database identifier.', inputSchema: { type: 'object', properties: repository, required: ['owner', 'repo'] } },
  { name: 'create_issue', description: 'Create an open issue in a repository.', inputSchema: { type: 'object', properties: { ...repository, title: string, body: string }, required: ['owner', 'repo', 'title'] } },
  { name: 'list_issues', description: 'List repository issues filtered by open, closed or all state.', inputSchema: { type: 'object', properties: { ...repository, state: { type: 'string', enum: ['open', 'closed', 'all'] } }, required: ['owner', 'repo'] } },
  { name: 'create_pull_request', description: 'Open a pull request between existing repository branches.', inputSchema: { type: 'object', properties: { ...repository, title: string, body: string, head: string, base: string }, required: ['owner', 'repo', 'title', 'head', 'base'] } },
  { name: 'merge_pull_request', description: 'Squash merge a pull request and close it.', inputSchema: { type: 'object', properties: { ...repository, pull_number: { type: 'integer' } }, required: ['owner', 'repo', 'pull_number'] } },
];
// The large, invariant result is serialized once; only each request's id is framed at dispatch.
const listBuffer = Buffer.from(`,"result":${JSON.stringify({ tools })}}\n`);
const aliases: Record<string, string[]> = {
  owner: ['owner_login', 'ownerLogin', 'org', 'organization', 'user', 'login'], repo: ['repository', 'repository_name', 'repo_name', 'repoName'],
  full_name: ['fullName', 'repo_full_name', 'repository_full_name'], title: ['issue_title', 'pr_title', 'subject'], body: ['issue_body', 'content', 'text'],
  head: ['head_ref', 'headRefName', 'head_branch', 'source_branch'], base: ['base_ref', 'baseRefName', 'base_branch', 'target_branch'],
  pull_number: ['pullNumber', 'pull_request_number', 'pr_number', 'number'], name: ['repo', 'repository_name'],
};
function normalize(input: any): any {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const a = { ...input };
  for (const [key, names] of Object.entries(aliases)) if (a[key] === undefined) for (const name of names) if (a[name] !== undefined) { a[key] = a[name]; break; }
  if (typeof a.full_name === 'string') { const slash = a.full_name.indexOf('/'); if (slash > 0) { a.owner ??= a.full_name.slice(0, slash); a.repo ??= a.full_name.slice(slash + 1); } }
  return a;
}
function call(store: Store, name: string, a: any): any {
  if (name === 'create_repo') { const r = store.createRepo(store.owner, a.name, text(a.description), !!a.private); if (!r) throw new Error('Repository already exists'); return repoJson(r); }
  const r = store.repo(a.owner, a.repo); if (!r) throw new Error('Repository not found');
  if (name === 'get_repo') return repoJson(r);
  if (name === 'create_issue') return issueJson(store.issue(r, a.title, text(a.body), []), r);
  if (name === 'list_issues') { const state = a.state || 'open'; if (!['open', 'closed', 'all'].includes(state)) throw new Error('Invalid issue state'); return r.issues.filter(i => state === 'all' || i.state === state).slice().reverse().map(i => issueJson(i, r)); }
  if (name === 'create_pull_request') { if (!r.refs.has(a.head) || !r.refs.has(a.base)) throw new Error('Head and base branches must exist'); return pullJson(store.pull(r, a.title, text(a.body), a.head, a.base), r); }
  const p = r.pulls.find(p => p.number === Number(a.pull_number)); if (!p) throw new Error('Pull request not found');
  if (p.merged || !p.mergeable) throw new Error('Pull request cannot be merged'); const sha = store.merge(r, p); if (sha === 'conflict') throw new Error('Pull request has conflicts');
  return { ...pullJson(p, r), sha, message: 'Pull Request successfully merged' };
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  let revision = text(req.headers['mcp-protocol-version'], versions[0]); if (!versions.includes(revision)) revision = versions[0];
  const headers = { 'mcp-protocol-version': revision };
  if (req.headers.authorization !== `Bearer ${store.token}`) { json(res, 401, { message: 'Requires authentication' }, headers); return; }
  if (req.method !== 'POST') { json(res, 405, { message: 'Method not allowed' }, headers); return; }
  let body: any;
  const error = (status: number, id: any, code: number, message: string) => json(res, status, { jsonrpc: '2.0', id, error: { code, message } }, headers);
  try { body = JSON.parse(await readBody(req)); } catch { error(400, null, -32700, 'Parse error'); return; }
  if (!body || Array.isArray(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string') { error(400, null, -32600, 'Invalid Request'); return; }
  const id = body.id ?? null, params = body.params || {};
  if ((req.headers['mcp-method'] && req.headers['mcp-method'] !== body.method) || (req.headers['mcp-name'] && req.headers['mcp-name'] !== params.name)) { error(400, id, -32020, 'Header mismatch'); return; }
  if (!Object.hasOwn(body, 'id')) { empty(res, 202, headers); return; }
  const result = (value: any) => json(res, 200, { jsonrpc: '2.0', id, result: value }, headers);
  if (body.method === 'server/discover') { result({ supportedVersions: versions, serverInfo: identity, capabilities }); return; }
  if (body.method === 'initialize') { const chosen = versions.includes(params.protocolVersion) ? params.protocolVersion : versions[0]; headers['mcp-protocol-version'] = chosen; result({ protocolVersion: chosen, serverInfo: identity, capabilities }); return; }
  if (body.method === 'ping') { result({}); return; }
  if (body.method === 'tools/list') { const prefix = Buffer.from(`{"jsonrpc":"2.0","id":${JSON.stringify(id)}`); res.writeHead(200, { ...headers, 'content-type': JSON_TYPE, 'content-length': prefix.length + listBuffer.length, 'x-github-request-id': requestId() }); res.write(prefix); res.end(listBuffer); return; }
  if (body.method !== 'tools/call') { error(200, id, -32601, `Unknown method ${body.method}`); return; }
  const tool = tools.find(t => t.name === params.name); if (!tool) { error(200, id, -32602, `Unknown tool ${text(params.name)}`); return; }
  const a = normalize(params.arguments);
  try {
    for (const key of tool.inputSchema.required) { if (key === 'pull_number') { if (!Number.isInteger(Number(a[key])) || Number(a[key]) <= 0) throw new Error('pull_number must be a positive integer'); } else if (typeof a[key] !== 'string' || !a[key].trim()) throw new Error(`${key} is required`); }
    const resource = call(store, tool.name, a); result({ content: [{ type: 'text', text: JSON.stringify(resource) }], structuredContent: resource, isError: false });
  } catch (e) { result({ content: [{ type: 'text', text: e instanceof Error ? e.message : 'Tool failed' }], isError: true }); }
}
