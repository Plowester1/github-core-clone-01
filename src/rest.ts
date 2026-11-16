import type { IncomingMessage, ServerResponse } from 'node:http';
import { empty, json, jsonBody, page, text, TRIAL_NOW } from './util.ts';
import { Store, type Issue, type Pull, type Repo } from './store.ts';

const now = TRIAL_NOW;
export { repoJson, issueJson, pullJson };
function error(res: ServerResponse, status: number, message: string): void { json(res, status, { message }); }
function repoJson(r: Repo): any { return { id: r.id, node_id: `R_${r.id}`, name: r.name, full_name: `${r.owner}/${r.name}`, owner: { login: r.owner }, private: r.private, description: r.description, default_branch: r.defaultBranch, html_url: `/ ${r.owner}/${r.name}`.replace(' ', ''), has_issues: true }; }
function issueJson(i: Issue, r: Repo): any { return { id: i.number, number: i.number, title: i.title, body: i.body, state: i.state, labels: i.labels.map(name => ({ name })), comments: i.comments.length, repository_url: `/api/v3/repos/${r.owner}/${r.name}`, created_at: now, updated_at: now }; }
function pullJson(p: Pull, r: Repo): any { const headSha = r.refs.get(p.head) || ''; const baseSha = r.refs.get(p.base) || ''; return { id: p.number, number: p.number, title: p.title, body: p.body, state: p.state, merged: p.merged, mergeable: p.mergeable, head: { ref: p.head, sha: headSha }, base: { ref: p.base, sha: baseSha }, merged_at: p.merged ? now : null, merge_commit_sha: p.mergeSha || null }; }
function pathParts(path: string): string[] { return path.split('/').filter(Boolean).map(decodeURIComponent); }
function commonAncestor(r: Repo, a: string, b: string): string | undefined { const seen = new Set<string>(); let x: string | undefined = a; while (x) { seen.add(x); x = r.commits.get(x)?.parents[0]; } x = b; while (x) { if (seen.has(x)) return x; x = r.commits.get(x)?.parents[0]; } return undefined; }
function paginate(res: ServerResponse, items: any[], url: URL, req?: IncomingMessage): void { const result = page(items, url); const link = result.link && req ? result.link.replace('<http://forge', `<http://${req.headers.host || 'localhost'}`) : result.link; json(res, 200, result.items, link ? { link } : {}); }

export async function handleRest(req: IncomingMessage, res: ServerResponse, store: Store, url: URL): Promise<boolean> {
  if (!url.pathname.startsWith('/api/v3')) return false;
  if (req.headers.authorization !== `Bearer ${store.token}`) { error(res, 401, 'Requires authentication'); return true; }
  const tail = url.pathname.slice('/api/v3'.length).replace(/^\/+|\/+$/g, ''); const parts = pathParts(tail); const method = req.method || 'GET';
  try {
    if ((tail === '' || tail === '/') && method === 'GET') { json(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' }); return true; }
    if (parts[0] === 'meta' && method === 'GET') { json(res, 200, { installed_version: '1.0.0' }); return true; }
    if (parts[0] === 'user' && parts[1] === 'repos') {
      if (method === 'GET') { paginate(res, store.allRepos(store.owner).map(repoJson), url, req); return true; }
      if (method === 'POST') { const b = await jsonBody(req); const r = store.createRepo(store.owner, text(b.name), text(b.description), !!b.private); if (!r) { error(res, 422, 'Repository already exists'); return true; } json(res, 201, repoJson(r)); return true; }
    }
    if (parts[0] === 'user' && method === 'GET' && parts[1] === undefined) { json(res, 200, { login: store.owner, id: 1, name: store.owner }); return true; }
    if (parts[0] !== 'repos' || !parts[1] || !parts[2]) { error(res, 404, 'Not Found'); return true; }
    const owner = parts[1], name = parts[2], r = store.repo(owner, name); if (!r) { error(res, 404, 'Not Found'); return true; }
    const sub = parts.slice(3);
    if (sub.length === 0) {
      if (method === 'GET') { json(res, 200, repoJson(r)); return true; }
      if (method === 'PATCH') { const b = await jsonBody(req); if (typeof b.description === 'string') r.description = b.description; json(res, 200, repoJson(r)); return true; }
      if (method === 'DELETE') { r.deleted = true; empty(res, 204); return true; }
    }
    if (sub[0] === 'git' && sub[1] === 'refs' && method === 'POST' && sub.length === 2) { const b = await jsonBody(req); const ref = text(b.ref).replace(/^refs\/heads\//, ''); if (!r.objects.has(text(b.sha))) { error(res, 422, 'Reference does not exist'); return true; } r.refs.set(ref, text(b.sha)); if (ref === r.defaultBranch) store.setFileSnapshot(r, text(b.sha)); json(res, 201, { ref: `refs/heads/${ref}`, object: { sha: text(b.sha), type: 'commit' } }); return true; }
    if (sub[0] === 'branches' && method === 'GET') { const list = [...r.refs].map(([name, sha]) => ({ name, commit: { sha } })); if (sub[1]) { const found = list.find(x => x.name === sub[1]); if (!found) { error(res, 404, 'Branch not found'); return true; } json(res, 200, found); } else paginate(res, list, url, req); return true; }
    if (sub[0] === 'commits' && method === 'GET') { const ref = url.searchParams.get('sha') || r.defaultBranch; const tip = r.refs.get(ref); if (!tip) { error(res, 404, 'Reference not found'); return true; } const out: any[] = []; let sha: string | undefined = tip; while (sha) { const c = r.commits.get(sha); if (!c) break; out.push({ sha, commit: { message: c.message, author: { name: store.owner, date: now }, committer: { name: store.owner, date: now } } }); sha = c.parents[0]; } paginate(res, out, url, req); return true; }
    if (sub[0] === 'contents') return await contents(req, res, store, r, sub.slice(1), url);
    if (sub[0] === 'labels') { if (method === 'POST') { const b = await jsonBody(req); const n = text(b.name); if (!n) { error(res, 422, 'Name is required'); return true; } const label = { name: n, color: text(b.color, 'ededed') }; r.labels.set(n, label); json(res, 201, label); return true; } if (method === 'GET') { paginate(res, [...r.labels.values()], url); return true; } }
    if (sub[0] === 'issues') return await issues(req, res, store, r, sub.slice(1), url);
    if (sub[0] === 'pulls') return await pulls(req, res, store, r, sub.slice(1), url);
    error(res, 404, 'Not Found'); return true;
  } catch (e) { if (e instanceof SyntaxError || (e instanceof Error && e.message.includes('body'))) error(res, 400, 'Invalid JSON'); else error(res, 400, e instanceof Error ? e.message : 'Bad Request'); return true; }
}

async function contents(req: IncomingMessage, res: ServerResponse, store: Store, r: Repo, bits: string[], url: URL): Promise<boolean> {
  const path = bits.join('/'); const method = req.method || 'GET';
  if (method === 'GET') { const ref = url.searchParams.get('ref') || r.defaultBranch; const snapshot = r.commits.get(r.refs.get(ref) || '')?.files ?? r.files; const f = snapshot.get(path); if (f) { const raw = Buffer.from(f.content, 'base64'); json(res, 200, { type: 'file', encoding: 'base64', content: f.content, sha: f.sha, size: raw.length, name: path.split('/').pop(), path }); return true; } const prefix = path ? `${path}/` : ''; const dirs = new Set<string>(); const out: any[] = []; for (const [p, file] of snapshot) if (p.startsWith(prefix)) { const rest = p.slice(prefix.length), name = rest.split('/')[0]; if (rest.includes('/')) dirs.add(name); else out.push({ type: 'file', name, path: p, sha: file.sha, size: Buffer.from(file.content, 'base64').length }); } for (const name of dirs) out.push({ type: 'dir', name, path: `${prefix}${name}`, sha: '0000000000000000000000000000000000000000' }); if (!out.length) { error(res, 404, 'Not Found'); return true; } json(res, 200, out); return true; }
  const b = await jsonBody(req); const message = text(b.message, 'Update content'); const branch = text(b.branch, r.defaultBranch);
  if (method === 'PUT') { const result = store.writeFile(r, path, Buffer.from(text(b.content).replace(/[\r\n\s]/g, ''), 'base64').toString(), message, branch, b.sha); if (result === 'stale') { error(res, 409, 'sha does not match'); return true; } json(res, result.created ? 201 : 200, { content: { name: path.split('/').pop(), path, sha: result.file.sha, encoding: 'base64' }, commit: { sha: result.commit } }); return true; }
  if (method === 'DELETE') { const result = store.deleteFile(r, path, message, b.sha); if (!result || result === 'stale') { error(res, result === 'stale' ? 409 : 404, result === 'stale' ? 'sha does not match' : 'Not Found'); return true; } json(res, 200, { commit: { sha: result } }); return true; }
  error(res, 404, 'Not Found'); return true;
}

async function issues(req: IncomingMessage, res: ServerResponse, store: Store, r: Repo, bits: string[], url: URL): Promise<boolean> {
  const method = req.method || 'GET'; const n = bits[0] ? Number(bits[0]) : 0;
  if (!bits.length && method === 'POST') { const b = await jsonBody(req); const labels = Array.isArray(b.labels) ? b.labels.map(String) : []; if (labels.some(x => !r.labels.has(x))) { error(res, 422, 'Label does not exist'); return true; } json(res, 201, issueJson(store.issue(r, text(b.title), text(b.body), labels), r)); return true; }
  if (!bits.length && method === 'GET') { let list = r.issues.filter(i => !url.searchParams.get('state') || url.searchParams.get('state') === 'all' || i.state === url.searchParams.get('state')); list = [...list].sort((a, b) => (url.searchParams.get('direction') === 'asc' ? a.created - b.created : b.created - a.created)); paginate(res, list.map(i => issueJson(i, r)), url, req); return true; }
  const issue = r.issues.find(i => i.number === n); if (!issue) { error(res, 404, 'Not Found'); return true; }
  if (bits[1] === 'comments') { if (method === 'POST') { const b = await jsonBody(req); json(res, 201, store.comment(issue, text(b.body))); return true; } if (method === 'GET') { json(res, 200, issue.comments); return true; } }
  if (method === 'GET') { json(res, 200, issueJson(issue, r)); return true; } if (method === 'PATCH') { const b = await jsonBody(req); if (b.state === 'open' || b.state === 'closed') issue.state = b.state; if (typeof b.title === 'string') issue.title = b.title; if (typeof b.body === 'string') issue.body = b.body; json(res, 200, issueJson(issue, r)); return true; } error(res, 404, 'Not Found'); return true;
}

async function pulls(req: IncomingMessage, res: ServerResponse, store: Store, r: Repo, bits: string[], url: URL): Promise<boolean> {
  const method = req.method || 'GET'; if (!bits.length && method === 'POST') { const b = await jsonBody(req); const p = store.pull(r, text(b.title), text(b.body), text(b.head), text(b.base, r.defaultBranch)); json(res, 201, pullJson(p, r)); return true; }
  if (!bits.length && method === 'GET') { const state = url.searchParams.get('state') || 'open'; const list = r.pulls.filter(p => state === 'all' || p.state === state); paginate(res, list.map(p => pullJson(p, r)), url, req); return true; }
  const p = r.pulls.find(x => x.number === Number(bits[0])); if (!p) { error(res, 404, 'Not Found'); return true; }
  if (bits[1] === 'files' && method === 'GET') { const h = r.commits.get(r.refs.get(p.head) || ''), b = r.commits.get(r.refs.get(p.base) || ''); const common = h && b ? commonAncestor(r, r.refs.get(p.head)!, r.refs.get(p.base)!) : undefined; const before = common ? r.commits.get(common)?.files : new Map(); const paths = new Set([...(h?.files.keys() || []), ...(b?.files.keys() || [])]); json(res, 200, [...paths].filter(x => h?.files.get(x)?.sha !== b?.files.get(x)?.sha).map(filename => ({ filename, status: before?.has(filename) ? 'modified' : 'added', additions: 1, deletions: 0, changes: 1 }))); return true; }
  if (bits[1] === 'merge' && method === 'PUT') { if (!p.mergeable || p.merged) { error(res, 405, 'Pull request cannot be merged'); return true; } const sha = store.merge(r, p); if (sha === 'conflict') { error(res, 405, 'Pull request is not mergeable'); return true; } json(res, 200, { sha, merged: true, message: 'Pull Request successfully merged' }); return true; }
  if (method === 'GET') { json(res, 200, pullJson(p, r)); return true; } error(res, 404, 'Not Found'); return true;
}
