import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store, type Repo, type Issue, type Pull } from './store.ts';
import { json, readBody, text } from './util.ts';

type Field = { name: string; alias: string; args: Record<string, any>; children: Field[]; condition?: string };
type Operation = { name: string; kind: string; fields: Field[]; defaults: Record<string, any> };
type Document = { operations: Operation[]; fragments: Map<string, Field[]> };
const documents = new Map<string, Document>();
const types: Record<string, any> = Object.create(null);
const fields: Record<string, string> = {
  Query: 'viewer repository node __type __schema', Mutation: 'createIssue closeIssue createPullRequest mergePullRequest addComment',
  Repository: 'id databaseId name nameWithOwner owner defaultBranchRef viewerPermission hasIssuesEnabled issue issues pullRequests pullRequest',
  Issue: 'id databaseId number title state body', PullRequest: 'id databaseId number title body headRefName baseRefName mergeable state merged files',
  User: 'login', Ref: 'name', IssueComment: 'id databaseId body',
};
for (const [name, names] of Object.entries(fields)) types[name] = { name, kind: 'OBJECT', fields: names.split(' ').map(name => ({ name })), enumValues: null };
for (const [name, values] of Object.entries({ SearchType: 'ISSUE REPOSITORY USER', IssueState: 'OPEN CLOSED', PullRequestState: 'OPEN CLOSED MERGED', MergeableState: 'MERGEABLE CONFLICTING UNKNOWN', PullRequestMergeMethod: 'MERGE SQUASH REBASE', RepositoryPermission: 'ADMIN MAINTAIN WRITE TRIAGE READ', IssueOrderField: 'CREATED_AT UPDATED_AT COMMENTS', OrderDirection: 'ASC DESC' })) types[name] = { name, kind: 'ENUM', fields: null, enumValues: values.split(' ').map(name => ({ name })) };
const schema = { queryType: types.Query, mutationType: types.Mutation, subscriptionType: null, types: Object.values(types), directives: [] };

// A small recursive parser keeps aliases, variables and selections independent of operation names.
function parse(source: string): Document {
  const cached = documents.get(source); if (cached) return cached;
  const tokens: string[] = []; let at = 0;
  while (at < source.length) {
    const c = source[at];
    if (c <= ' ' || c === ',') { at++; continue; }
    if (c === '#') { while (at < source.length && source[at] !== '\n') at++; continue; }
    if (c === '"') { const start = at++; let escaped = false; while (at < source.length) { const ch = source[at++]; if (ch === '"' && !escaped) break; escaped = ch === '\\' && !escaped; } tokens.push(source.slice(start, at)); continue; }
    if (source.startsWith('...', at)) { tokens.push('...'); at += 3; continue; }
    if ('{}():![]$=@'.includes(c)) { tokens.push(c); at++; continue; }
    const start = at;
    while (at < source.length) { const x = source[at]; if ((x >= 'a' && x <= 'z') || (x >= 'A' && x <= 'Z') || (x >= '0' && x <= '9') || x === '_' || x === '-' || x === '.') at++; else break; }
    if (start === at) throw new Error(`Unexpected character ${c}`);
    tokens.push(source.slice(start, at));
  }
  let pos = 0;
  const take = (expected?: string): string => { const t = tokens[pos++]; if (t === undefined || (expected && t !== expected)) throw new Error(`Expected ${expected || 'token'}, got ${t}`); return t; };
  const value = (): any => {
    const t = take(); if (t === '$') return { variable: take() };
    if (t === '{') { const o: any = Object.create(null); while (tokens[pos] !== '}') { const key = take(); take(':'); o[key] = value(); } take('}'); return o; }
    if (t === '[') { const a: any[] = []; while (tokens[pos] !== ']') a.push(value()); take(']'); return a; }
    if (t[0] === '"') return JSON.parse(t); if (t === 'null') return null; if (t === 'true' || t === 'false') return t === 'true';
    return Number.isFinite(Number(t)) ? Number(t) : t;
  };
  const args = (): Record<string, any> => { const a = Object.create(null); if (tokens[pos] === '(') { take(); while (tokens[pos] !== ')') { const k = take(); take(':'); a[k] = value(); } take(')'); } return a; };
  const selection = (): Field[] => {
    take('{'); const out: Field[] = [];
    while (tokens[pos] !== '}') {
      let name = take(), alias = name;
      if (name === '...') { const condition = take(); if (condition === 'on') out.push({ name: '...', alias: '', args: {}, condition: take(), children: selection() }); else out.push({ name: '...', alias: condition, args: {}, children: [] }); continue; }
      if (tokens[pos] === ':') { take(); name = take(); }
      const a = args(); while (tokens[pos] === '@') { take(); const directive = take(); a[`@${directive}`] = args(); }
      out.push({ name, alias, args: a, children: tokens[pos] === '{' ? selection() : [] });
    }
    take('}'); return out;
  };
  const document: Document = { operations: [], fragments: new Map() };
  while (pos < tokens.length) {
    if (tokens[pos] === 'fragment') { take(); const name = take(); take('on'); const condition = take(); document.fragments.set(name, [{ name: '...', alias: '', args: {}, condition, children: selection() }]); continue; }
    const kind = tokens[pos] === '{' ? 'query' : take(); if (kind !== 'query' && kind !== 'mutation') throw new Error(`Unsupported operation ${kind}`);
    const name = tokens[pos] !== '{' && tokens[pos] !== '(' ? take() : ''; const defaults: any = Object.create(null);
    if (tokens[pos] === '(') { take(); while (tokens[pos] !== ')') { take('$'); const key = take(); take(':'); while (tokens[pos] !== '$' && tokens[pos] !== ')' && tokens[pos] !== '=') take(); if (tokens[pos] === '=') { take(); defaults[key] = value(); } } take(')'); }
    document.operations.push({ kind, name, defaults, fields: selection() });
  }
  if (documents.size >= 256) documents.delete(documents.keys().next().value!); documents.set(source, document); return document;
}

function globalId(type: string, id: number): string { return Buffer.from(`${type}:${id}`).toString('base64'); }
function connection(nodes: any[], args: any): any {
  const start = args.after ? Number(Buffer.from(args.after, 'base64').toString().split(':')[1]) : 0;
  if (!Number.isInteger(start) || start < 0) throw new Error('Invalid cursor');
  const count = args.first ?? 100; if (!Number.isInteger(count) || count < 0) throw new Error('Invalid first');
  const selected = nodes.slice(start, start + count); const cursor = (n: number) => Buffer.from(`cursor:${n}`).toString('base64');
  return { nodes: selected, totalCount: nodes.length, edges: selected.map((node, n) => ({ node, cursor: cursor(start + n + 1) })), pageInfo: { hasNextPage: start + selected.length < nodes.length, hasPreviousPage: start > 0, startCursor: selected.length ? cursor(start + 1) : null, endCursor: selected.length ? cursor(start + selected.length) : null } };
}

function execute(store: Store, request: any): any {
  try {
    if (!request || typeof request.query !== 'string') throw new Error('query must be a string');
    const doc = parse(request.query); const op = request.operationName ? doc.operations.find(o => o.name === request.operationName) : doc.operations.length === 1 ? doc.operations[0] : undefined;
    if (!op) throw new Error('An operationName selecting one operation is required');
    const variables = { ...op.defaults, ...request.variables };
    const resolveValue = (v: any): any => { if (Array.isArray(v)) return v.map(resolveValue); if (v && typeof v === 'object') { if (Object.hasOwn(v, 'variable')) return variables[v.variable]; return Object.fromEntries(Object.entries(v).map(([k, v]) => [k, resolveValue(v)])); } return v; };
    const issueView = (i: Issue): any => ({ __typename: 'Issue', id: globalId('Issue', i.number), databaseId: i.number, number: i.number, title: i.title, body: i.body, state: i.state.toUpperCase() });
    const pullView = (p: Pull, r: Repo): any => ({ __typename: 'PullRequest', id: globalId('PullRequest', p.number), databaseId: p.number, number: p.number, title: p.title, body: p.body, headRefName: p.head, baseRefName: p.base, state: p.merged ? 'MERGED' : p.state.toUpperCase(), merged: p.merged, mergeable: p.mergeable ? 'MERGEABLE' : 'CONFLICTING', files: (a: any) => { const h = r.commits.get(r.refs.get(p.head) || '')?.files, b = r.commits.get(r.refs.get(p.base) || '')?.files; return connection([...new Set([...(h?.keys() || []), ...(b?.keys() || [])])].filter(path => h?.get(path)?.sha !== b?.get(path)?.sha).map(path => ({ path })), a); } });
    const repoView = (r: Repo): any => ({ __typename: 'Repository', id: globalId('Repository', r.id), databaseId: r.id, name: r.name, nameWithOwner: `${r.owner}/${r.name}`, owner: { __typename: 'User', login: r.owner }, defaultBranchRef: r.refs.has(r.defaultBranch) ? { name: r.defaultBranch } : null, viewerPermission: 'ADMIN', hasIssuesEnabled: true,
      issue: (a: any) => { const i = r.issues.find(i => i.number === a.number); return i ? issueView(i) : null; },
      issues: (a: any) => { const list = r.issues.filter(i => !a.states || a.states.includes(i.state.toUpperCase())); list.sort((x, y) => a.orderBy?.direction === 'DESC' ? y.created - x.created : x.created - y.created); return connection(list.map(issueView), a); },
      pullRequest: (a: any) => { const p = r.pulls.find(p => p.number === a.number); return p ? pullView(p, r) : null; },
      pullRequests: (a: any) => connection(r.pulls.filter(p => !a.states || a.states.includes(p.merged ? 'MERGED' : p.state.toUpperCase())).map(p => pullView(p, r)), a),
    });
    const find = (id: any): { type: string; repo: Repo; item: any } | undefined => {
      if (typeof id !== 'string') return; const [type, numeric] = /^R_\d+$/.test(id) ? ['Repository', id.slice(2)] : Buffer.from(id, 'base64').toString().split(':'); const n = Number(numeric);
      for (const repo of store.repos.values()) { if (repo.deleted) continue; const item = type === 'Repository' ? (repo.id === n ? repo : undefined) : type === 'Issue' ? repo.issues.find(i => i.number === n) : type === 'PullRequest' ? repo.pulls.find(p => p.number === n) : undefined; if (item) return { type, repo, item }; }
    };
    const required = (id: any, type: string) => { const found = find(id); if (!found || found.type !== type) throw new Error(`${type} not found`); return found; };
    const root: any = { __typename: op.kind === 'mutation' ? 'Mutation' : 'Query' };
    if (op.kind === 'query') Object.assign(root, { viewer: { __typename: 'User', login: store.owner }, repository: (a: any) => { const r = store.repo(text(a.owner), text(a.name)); return r ? repoView(r) : null; }, __type: (a: any) => types[a.name] || null, __schema: schema, node: (a: any) => { const f = find(a.id); return !f ? null : f.type === 'Repository' ? repoView(f.repo) : f.type === 'Issue' ? issueView(f.item) : pullView(f.item, f.repo); } });
    else Object.assign(root, {
      createIssue: ({ input: i }: any) => { const { repo } = required(i.repositoryId, 'Repository'); if (!i.title) throw new Error('title is required'); return { issue: issueView(store.issue(repo, i.title, text(i.body), [])) }; },
      closeIssue: ({ input: i }: any) => { const { item } = required(i.issueId, 'Issue'); item.state = 'closed'; return { issue: issueView(item) }; },
      createPullRequest: ({ input: i }: any) => { const { repo } = required(i.repositoryId, 'Repository'); if (!i.title || !repo.refs.has(i.headRefName) || !repo.refs.has(i.baseRefName)) throw new Error('title and existing head/base refs are required'); return { pullRequest: pullView(store.pull(repo, i.title, text(i.body), i.headRefName, i.baseRefName), repo) }; },
      mergePullRequest: ({ input: i }: any) => { const { repo, item } = required(i.pullRequestId, 'PullRequest'); if (i.mergeMethod && i.mergeMethod !== 'SQUASH') throw new Error('Only SQUASH merges are supported'); if (item.merged || !item.mergeable || store.merge(repo, item) === 'conflict') throw new Error('Pull request cannot be merged'); return { pullRequest: pullView(item, repo) }; },
      addComment: ({ input: i }: any) => { const { item } = required(i.subjectId, 'Issue'); if (typeof i.body !== 'string') throw new Error('body is required'); const c = store.comment(item, i.body); return { commentEdge: { node: { __typename: 'IssueComment', id: globalId('IssueComment', c.id), databaseId: c.id, body: c.body } } }; },
    });
    const project = (object: any, selection: Field[], depth = 0): any => {
      if (depth > 64) throw new Error('Selection is too deep'); if (object == null) return null; if (Array.isArray(object)) return object.map(x => project(x, selection, depth + 1));
      const out: any = Object.create(null);
      for (const f of selection) {
        if (f.name === '...') { if (!f.condition || f.condition === object.__typename) Object.assign(out, project(object, f.condition ? f.children : doc.fragments.get(f.alias) || [], depth + 1)); continue; }
        const a = resolveValue(f.args); if (a['@skip']?.if === true || a['@include']?.if === false) continue;
        if (!Object.hasOwn(object, f.name)) throw new Error(`Unknown field ${f.name} on ${object.__typename || 'object'}`);
        const v = typeof object[f.name] === 'function' ? object[f.name](a) : object[f.name]; out[f.alias] = f.children.length ? project(v, f.children, depth + 1) : v;
      }
      return out;
    };
    return { data: project(root, op.fields) };
  } catch (e) { return { errors: [{ message: e instanceof Error ? e.message : 'Invalid operation' }] }; }
}

export async function handleGraphQL(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  if (req.headers.authorization !== `Bearer ${store.token}`) { json(res, 401, { message: 'Requires authentication' }); return; }
  if (req.method !== 'POST') { json(res, 405, { message: 'Method not allowed' }); return; }
  try { const body = JSON.parse(await readBody(req)); json(res, 200, Array.isArray(body) ? body.map(entry => execute(store, entry)) : execute(store, body)); }
  catch { json(res, 400, { errors: [{ message: 'Invalid JSON body' }] }); }
}
