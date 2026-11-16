import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store, type Repo, type GitObject } from './store.ts';
import { pkt, packets, flush, delim, sideband, readPack, writePack, treeEntries } from './pack.ts';
import { json } from './util.ts';

const zero = '0'.repeat(40);
const cache = new WeakMap<Repo, { key: string; pack: Buffer; boundary: Set<string> }>();
const fullRef = (name: string) => name.startsWith('refs/') ? name : `refs/heads/${name}`;
const storeRef = (name: string) => name.replace(/^refs\/heads\//, '');
function refs(r: Repo): [string, string][] {
  const out = [...r.refs].map(([name, sha]) => [fullRef(name), sha] as [string, string]).sort(([a], [b]) => a < b ? -1 : 1);
  const head = r.refs.get(r.defaultBranch); if (head) out.unshift(['HEAD', head]); return out;
}
function target(o: GitObject): string { const value = /^object ([a-f0-9]{40})$/m.exec(o.bytes.toString())?.[1]; if (!value) throw new Error('Invalid tag'); return value; }
function peeled(r: Repo, sha: string): string | undefined {
  let o = r.objects.get(sha); if (o?.type !== 'tag') return;
  const seen = new Set<string>();
  while (o?.type === 'tag') { if (seen.has(sha)) throw new Error('Tag cycle'); seen.add(sha); sha = target(o); o = r.objects.get(sha); } return sha;
}
function commit(o: GitObject): { tree: string; parents: string[] } {
  const headers = o.bytes.toString().split('\n\n', 1)[0]; const tree = /^tree ([a-f0-9]{40})$/m.exec(headers)?.[1];
  if (!tree) throw new Error('Invalid commit'); return { tree, parents: [...headers.matchAll(/^parent ([a-f0-9]{40})$/gm)].map(m => m[1]) };
}
function reachable(r: Repo, roots: string[], depth = Infinity, stops = new Set<string>()): { ids: Set<string>; boundary: Set<string> } {
  const ids = new Set<string>(), boundary = new Set<string>(), levels = new Map<string, number>();
  const queue: [string, number][] = roots.map(id => [id, 1]);
  while (queue.length) {
    const [id, level] = queue.pop()!; if ((levels.get(id) ?? Infinity) <= level) continue; levels.set(id, level);
    const o = r.objects.get(id); if (!o) throw new Error(`Missing object ${id}`); ids.add(id);
    if (o.type === 'commit') { const c = commit(o); queue.push([c.tree, 0]); if (level >= depth || stops.has(id)) { if (c.parents.length) boundary.add(id); } else { boundary.delete(id); for (const p of c.parents) queue.push([p, level + 1]); } }
    else if (o.type === 'tree') for (const e of treeEntries(o.bytes)) { if (e.mode !== '160000') queue.push([e.sha, 0]); }
    else if (o.type === 'tag') queue.push([target(o), level]);
  }
  return { ids, boundary };
}
function validateIncoming(r: Repo, incoming: Map<string, GitObject>, roots: string[]): void {
  const seen = new Set<string>(); const stack = [...roots];
  while (stack.length) {
    const id = stack.pop()!; if (seen.has(id) || r.commits.has(id)) continue; seen.add(id);
    const o = incoming.get(id) ?? r.objects.get(id); if (!o) throw new Error(`Missing object ${id}`);
    if (o.type === 'commit') { const headers = o.bytes.toString().split('\n\n', 1)[0]; const tree = /^tree ([a-f0-9]{40})$/m.exec(headers)?.[1]; if (!tree) throw new Error('Invalid commit'); stack.push(tree); for (const m of headers.matchAll(/^parent ([a-f0-9]{40})$/gm)) stack.push(m[1]); }
    else if (o.type === 'tree') for (const e of treeEntries(o.bytes)) { if (e.mode !== '160000') stack.push(e.sha); }
    else if (o.type === 'tag') { const t = /^object ([a-f0-9]{40})$/m.exec(o.bytes.toString())?.[1]; if (!t) throw new Error('Invalid tag'); stack.push(t); }
  }
}
function ancestor(r: Repo, old: string, tip: string): boolean {
  const pending = [tip], seen = new Set<string>();
  while (pending.length) { const id = pending.pop()!; if (id === old) return true; if (seen.has(id)) continue; seen.add(id); const indexed = r.commits.get(id); if (indexed) pending.push(...indexed.parents); else { const o = r.objects.get(id); if (o?.type === 'commit') pending.push(...commit(o).parents); } }
  return false;
}
function advertise(r: Repo, service: string, v2: boolean): Buffer {
  if (v2) return Buffer.concat(['version 2\n', 'agent=standalone-forge/1\n', 'ls-refs=unborn\n', 'fetch=shallow\n', 'object-format=sha1\n'].map(pkt).concat(flush));
  const caps = service === 'git-receive-pack' ? 'report-status delete-refs side-band-64k ofs-delta agent=standalone-forge/1' : `multi_ack thin-pack side-band-64k ofs-delta shallow no-progress include-tag symref=HEAD:refs/heads/${r.defaultBranch} agent=standalone-forge/1`;
  const list = refs(r); if (!list.length) list.push(['capabilities^{}', zero]);
  const out = [pkt(`# service=${service}\n`), flush];
  list.forEach(([name, sha], i) => { out.push(pkt(`${sha} ${name}${i === 0 ? '\0' + caps : ''}\n`)); const peel = peeled(r, sha); if (peel) out.push(pkt(`${peel} ${name}^{}\n`)); }); out.push(flush); return Buffer.concat(out);
}
function lsRefs(r: Repo, lines: string[]): Buffer {
  const prefixes = lines.filter(x => x.startsWith('ref-prefix ')).map(x => x.slice(11));
  const list = refs(r); if (!r.refs.has(r.defaultBranch) && lines.includes('unborn')) list.unshift(['HEAD', 'unborn']);
  const out: Buffer[] = [];
  for (const [name, sha] of list) {
    if (prefixes.length && !prefixes.some(p => name.startsWith(p))) continue;
    const peel = lines.includes('peel') ? peeled(r, sha) : undefined;
    out.push(pkt(`${sha} ${name}${name === 'HEAD' && lines.includes('symrefs') ? ` symref-target:refs/heads/${r.defaultBranch}` : ''}${peel ? ` peeled:${peel}` : ''}\n`));
  }
  return Buffer.concat([...out, flush]);
}
function upload(r: Repo, lines: string[], v2: boolean): Buffer {
  if (v2 && lines.includes('command=ls-refs')) return lsRefs(r, lines);
  if (v2 && !lines.includes('command=fetch')) throw new Error('Unknown command');
  const args = (key: string) => lines.filter(x => x.startsWith(key + ' ')).map(x => x.split(' ')[1]);
  const wants = args('want'), haves = args('have').filter(id => r.objects.has(id)), shallow = new Set(args('shallow'));
  const depthArg = args('deepen')[0], depth = depthArg === undefined ? Infinity : Number(depthArg);
  if (depth <= 0 || (!Number.isSafeInteger(depth) && depth !== Infinity)) throw new Error('Invalid depth');
  if (!v2) { const allowed = reachable(r, [...r.refs.values()]).ids; if (wants.some(w => !allowed.has(w))) throw new Error('Unadvertised want'); }
  if (!lines.includes('done') && haves.length) return Buffer.concat(v2 ? [pkt('acknowledgments\n'), ...haves.map(id => pkt(`ACK ${id}\n`)), flush] : [...haves.map(id => pkt(`ACK ${id} continue\n`)), pkt('NAK\n')]);
  const key = depth === 1 && !haves.length && !shallow.size ? wants.slice().sort().join(',') : '';
  let packed = key ? cache.get(r) : undefined;
  if (!packed || packed.key !== key) {
    const wanted = reachable(r, wants, depth, depth === Infinity ? shallow : new Set());
    const held = reachable(r, haves, Infinity, shallow).ids;
    const objects = [...wanted.ids].filter(id => !held.has(id)).map(id => r.objects.get(id)!);
    packed = { key, pack: writePack(objects), boundary: wanted.boundary }; if (key) cache.set(r, packed);
  }
  const out: Buffer[] = []; const boundary = packed.boundary;
  const shallowLines = [...boundary].map(id => `shallow ${id}\n`);
  if (depth !== Infinity) for (const id of shallow) if (!boundary.has(id) && wants.some(w => ancestor(r, id, w))) shallowLines.push(`unshallow ${id}\n`);
  if (shallowLines.length) { if (v2) out.push(pkt('shallow-info\n')); out.push(...shallowLines.map(pkt), v2 ? delim : flush); }
  if (v2) out.push(pkt('packfile\n')); else out.push(pkt(haves.length ? `ACK ${haves[haves.length - 1]}\n` : 'NAK\n'));
  const band = v2 || lines.some(x => x.includes('side-band-64k'));
  out.push(...(band ? [...sideband(packed.pack), flush] : [packed.pack])); return Buffer.concat(out);
}
function receive(store: Store, r: Repo, body: Buffer): Buffer {
  const parsed = packets(body, true);
  // A shallow sender prefixes its command list with shallow boundary packets.
  parsed.lines = parsed.lines.filter(line => !/^shallow [a-f0-9]{40}$/.test(line));
  const caps = parsed.lines[0]?.split('\0')[1] ?? '';
  const commands = parsed.lines.map(line => { const parts = line.split('\0', 1)[0].split(' '); if (parts.length !== 3 || !/^[a-f0-9]{40}$/.test(parts[0]) || !/^[a-f0-9]{40}$/.test(parts[1]) || !/^refs\/(heads|tags)\/.+/.test(parts[2]) || /[\s~^:?*\[\\]|\.\.|@\{|\/$|\.$/.test(parts[2])) throw new Error('Invalid ref command'); return { old: parts[0], next: parts[1], ref: parts[2] }; });
  let unpack = 'ok';
  try {
    const incoming = body.length > parsed.offset ? readPack(body.subarray(parsed.offset), r.objects, false) : new Map<string, GitObject>();
    if (body.length === parsed.offset && commands.some(c => c.next !== zero)) throw new Error('Missing pack');
    validateIncoming(r, incoming, commands.filter(c => c.next !== zero).map(c => c.next));
    for (const [sha, o] of incoming) if (!r.objects.has(sha)) r.objects.set(sha, o);
    for (const [sha, o] of incoming) if (o.type === 'commit') store.indexCommit(r, sha);
  } catch (e) { unpack = e instanceof Error ? e.message.replace(/[\r\n]/g, ' ') : 'Invalid pack'; }
  const report = [pkt(`unpack ${unpack}\n`)];
  for (const c of commands) {
    const key = storeRef(c.ref), current = r.refs.get(key) ?? zero; let reason = unpack === 'ok' ? '' : 'unpacker error';
    if (!reason && current !== c.old) reason = 'stale old object';
    if (!reason && c.next !== zero && c.ref.startsWith('refs/heads/') && r.objects.get(c.next)?.type !== 'commit') reason = 'not a commit';
    if (!reason && c.old !== zero && c.next !== zero && !ancestor(r, peeled(r, c.old) ?? c.old, peeled(r, c.next) ?? c.next)) reason = 'non-fast-forward';
    if (!reason) { if (c.next === zero) r.refs.delete(key); else r.refs.set(key, c.next); if (key === r.defaultBranch) { if (c.next === zero) r.files = new Map(); else store.setFileSnapshot(r, c.next); } }
    report.push(pkt(reason ? `ng ${c.ref} ${reason}\n` : `ok ${c.ref}\n`));
  }
  report.push(flush); const bytes = Buffer.concat(report); return caps.includes('side-band-64k') ? Buffer.concat([...sideband(bytes), flush]) : bytes;
}
export async function handleGit(req: IncomingMessage, res: ServerResponse, store: Store, url: URL): Promise<boolean> {
  const match = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(url.pathname); if (!match) return false;
  if (req.headers.authorization !== `Bearer ${store.token}`) { json(res, 401, { message: 'Requires authentication' }); return true; }
  const r = store.repo(decodeURIComponent(match[1]), decodeURIComponent(match[2])); if (!r) { json(res, 404, { message: 'Not Found' }); return true; }
  try {
    const discovery = match[3] === 'info/refs', service = discovery ? url.searchParams.get('service') : match[3];
    if (!['git-upload-pack', 'git-receive-pack'].includes(service ?? '') || req.method !== (discovery ? 'GET' : 'POST')) { json(res, 404, { message: 'Not Found' }); return true; }
    const v2 = service === 'git-upload-pack' && String(req.headers['git-protocol']).includes('version=2');
    let response: Buffer;
    if (discovery) response = advertise(r, service!, v2);
    else { const chunks: Buffer[] = []; let length = 0; for await (const chunk of req) { length += chunk.length; if (length > 64 * 1024 * 1024) throw new Error('Body too large'); chunks.push(chunk); } const body = Buffer.concat(chunks); response = service === 'git-receive-pack' ? receive(store, r, body) : upload(r, packets(body).lines, v2); }
    res.writeHead(200, { 'content-type': `application/x-${service}-${discovery ? 'advertisement' : 'result'}`, 'content-length': response.length, 'cache-control': 'no-cache' }); res.end(response);
  } catch (e) { json(res, 400, { message: e instanceof Error ? e.message : 'Invalid git request' }); }
  return true;
}
