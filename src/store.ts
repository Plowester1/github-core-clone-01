import { blobSha, sha1, TRIAL_NOW } from './util.ts';
import { deflateSync } from 'node:zlib';
import { treeEntries } from './pack.ts';

export type GitObject = { type: 'blob' | 'tree' | 'commit' | 'tag'; bytes: Buffer; deflated?: Buffer };
export type FileEntry = { sha: string; content: string; commitSha: string };
export type Issue = { number: number; title: string; body: string; state: 'open' | 'closed'; labels: string[]; comments: { id: number; body: string }[]; created: number };
export type Pull = { number: number; title: string; body: string; head: string; base: string; state: 'open' | 'closed'; merged: boolean; mergeable: boolean; mergeSha?: string; created: number };
export type Repo = { id: number; owner: string; name: string; description: string; defaultBranch: string; private: boolean; refs: Map<string, string>; objects: Map<string, GitObject>; files: Map<string, FileEntry>; commits: Map<string, { tree: string; parents: string[]; message: string; files: Map<string, FileEntry> }>; issues: Issue[]; pulls: Pull[]; labels: Map<string, { name: string; color: string }>; deleted?: boolean };

export class Store {
  readonly owner: string; readonly token: string;
  private repoId = 1; private issueNo = 1; private pullNo = 1; private commentNo = 1; private commitNo = 1;
  readonly repos = new Map<string, Repo>();
  constructor(token: string, owner = 'adaiversen') { this.token = token; this.owner = owner; }
  key(owner: string, name: string): string { return `${owner}/${name}`.toLowerCase(); }
  repo(owner: string, name: string): Repo | undefined { const r = this.repos.get(this.key(owner, name)); return r && !r.deleted && r.owner === owner ? r : undefined; }
  createRepo(owner: string, name: string, description = '', priv = false): Repo | undefined {
    if (this.repos.has(this.key(owner, name))) return undefined;
    const repo: Repo = { id: this.repoId++, owner, name, description, defaultBranch: 'main', private: !!priv, refs: new Map(), objects: new Map(), files: new Map(), commits: new Map(), issues: [], pulls: [], labels: new Map() };
    this.repos.set(this.key(owner, name), repo); return repo;
  }
  allRepos(owner: string): Repo[] { return [...this.repos.values()].filter(r => !r.deleted && r.owner === owner); }
  addObject(repo: Repo, type: GitObject['type'], bytes: Buffer): string { const sha = sha1(Buffer.concat([Buffer.from(`${type} ${bytes.length}\0`), bytes])); if (!repo.objects.has(sha)) repo.objects.set(sha, { type, bytes, deflated: deflateSync(bytes) }); return sha; }
  indexCommit(repo: Repo, sha: string): void {
    if (repo.commits.has(sha)) return;
    const object = repo.objects.get(sha); if (object?.type !== 'commit') return;
    const raw = object.bytes.toString(), end = raw.indexOf('\n\n'), headers = raw.slice(0, end).split('\n');
    const tree = headers.find(x => x.startsWith('tree '))?.slice(5); if (!tree) throw new Error('Missing commit tree');
    const parents = headers.filter(x => x.startsWith('parent ')).map(x => x.slice(7));
    const files = new Map<string, FileEntry>();
    const walk = (id: string, prefix: string) => {
      const object = repo.objects.get(id); if (object?.type !== 'tree') throw new Error('Missing tree');
      for (const e of treeEntries(object.bytes)) {
        if (e.mode === '40000' || e.mode === '040000') walk(e.sha, `${prefix}${e.name}/`);
        else if (e.mode !== '160000') { const blob = repo.objects.get(e.sha); if (blob?.type !== 'blob') throw new Error('Missing blob'); files.set(prefix + e.name, { sha: e.sha, content: blob.bytes.toString('base64'), commitSha: sha }); }
      }
    };
    walk(tree, ''); repo.commits.set(sha, { tree, parents, message: raw.slice(end + 2).replace(/\n$/, ''), files });
  }
  commit(repo: Repo, files: Map<string, FileEntry>, message: string, parents: string[] = []): string {
    type Node = { files: Map<string, FileEntry>; dirs: Map<string, Node> };
    const node = (): Node => ({ files: new Map(), dirs: new Map() }); const root = node();
    for (const [path, file] of files) { const bits = path.split('/'); let at = root; for (const bit of bits.slice(0, -1)) { if (!at.dirs.has(bit)) at.dirs.set(bit, node()); at = at.dirs.get(bit)!; } at.files.set(bits[bits.length - 1], file); this.addObject(repo, 'blob', Buffer.from(file.content, 'base64')); }
    const build = (n: Node): string => {
      const entries = [...n.files].map(([name, f]) => ({ name, mode: '100644', sha: f.sha }));
      for (const [name, child] of n.dirs) entries.push({ name, mode: '40000', sha: build(child) });
      entries.sort((a, b) => Buffer.compare(Buffer.from(a.name + (a.mode === '40000' ? '/' : '')), Buffer.from(b.name + (b.mode === '40000' ? '/' : ''))));
      return this.addObject(repo, 'tree', Buffer.concat(entries.flatMap(e => [Buffer.from(`${e.mode} ${e.name}\0`), Buffer.from(e.sha, 'hex')])));
    };
    const tree = build(root);
    const body = `tree ${tree}\n${parents.map(p => `parent ${p}\n`).join('')}author ${this.owner} <${this.owner}@example.invalid> 1794528000 +0000\ncommitter ${this.owner} <${this.owner}@example.invalid> 1794528000 +0000\n\n${message}\n`;
    const sha = this.addObject(repo, 'commit', Buffer.from(body));
    repo.commits.set(sha, { tree, parents, message, files: new Map(files) }); this.commitNo += 1; return sha;
  }
  writeFile(repo: Repo, path: string, content: string, message: string, branch = repo.defaultBranch, expected?: string): { file: FileEntry; commit: string; created: boolean } | 'stale' {
    const currentTip = repo.refs.get(branch); const branchFiles = currentTip ? repo.commits.get(currentTip)?.files : undefined;
    const prior = (branchFiles ?? (branch === repo.defaultBranch ? repo.files : new Map())).get(path); if (expected !== undefined && (!prior || prior.sha !== expected)) return 'stale';
    const bytes = Buffer.from(content, 'utf8'); const file: FileEntry = { sha: blobSha(bytes), content: Buffer.from(bytes).toString('base64'), commitSha: '' };
    const files = new Map(branchFiles ?? (branch === repo.defaultBranch ? repo.files : new Map())); files.set(path, file); const parent = repo.refs.get(branch); const commit = this.commit(repo, files, message, parent ? [parent] : []);
    file.commitSha = commit; if (branch === repo.defaultBranch) repo.files = files; repo.refs.set(branch, commit); return { file, commit, created: !prior };
  }
  deleteFile(repo: Repo, path: string, message: string, expected?: string): string | 'stale' | undefined {
    const prior = repo.files.get(path); if (!prior) return undefined; if (expected !== undefined && prior.sha !== expected) return 'stale';
    const files = new Map(repo.files); files.delete(path); const parent = repo.refs.get(repo.defaultBranch); const commit = this.commit(repo, files, message, parent ? [parent] : []); repo.files = files; repo.refs.set(repo.defaultBranch, commit); return commit;
  }
  issue(repo: Repo, title: string, body: string, labels: string[]): Issue { const issue = { number: this.issueNo++, title, body, state: 'open' as const, labels, comments: [], created: this.issueNo }; repo.issues.push(issue); return issue; }
  comment(issue: Issue, body: string): { id: number; body: string } { const c = { id: this.commentNo++, body }; issue.comments.push(c); return c; }
  pull(repo: Repo, title: string, body: string, head: string, base: string): Pull { const p = { number: this.pullNo++, title, body, head, base, state: 'open' as const, merged: false, mergeable: true, created: this.pullNo }; repo.pulls.push(p); return p; }
  merge(repo: Repo, pull: Pull): string | 'conflict' { const head = repo.refs.get(pull.head), base = repo.refs.get(pull.base); if (!head || !base) return 'conflict'; if (pullsConflict(repo, head, base)) return 'conflict'; const source = repo.commits.get(head), baseCommit = repo.commits.get(base); if (!source || !baseCommit) return 'conflict'; const mergedFiles = new Map(baseCommit.files); for (const [path, file] of source.files) mergedFiles.set(path, file); const sha = this.commit(repo, mergedFiles, `Merge pull request #${pull.number}: ${pull.title}`, [base]); repo.files = mergedFiles; repo.refs.set(pull.base, sha); pull.state = 'closed'; pull.merged = true; pull.mergeSha = sha; return sha; }
  setFileSnapshot(repo: Repo, sha: string): void { const files = repo.commits.get(sha)?.files; if (files) repo.files = new Map(files); }
}
function ancestor(repo: Repo, descendant: string, possible: string): boolean { let at: string | undefined = descendant; while (at) { if (at === possible) return true; at = repo.commits.get(at)?.parents[0]; } return false; }
function mergeBase(repo: Repo, a: string, b: string): string | undefined { let at: string | undefined = a; while (at) { if (ancestor(repo, b, at)) return at; at = repo.commits.get(at)?.parents[0]; } return undefined; }
function pullsConflict(repo: Repo, head: string, base: string): boolean { const h = repo.commits.get(head), b = repo.commits.get(base); if (!h || !b) return false; const ancestorSha = mergeBase(repo, head, base); const ancestorFiles = ancestorSha ? repo.commits.get(ancestorSha)?.files : undefined; if (!ancestorFiles) return false; const paths = new Set([...h.files.keys(), ...b.files.keys()]); for (const path of paths) { const old = ancestorFiles.get(path)?.sha, hv = h.files.get(path)?.sha, bv = b.files.get(path)?.sha; if (hv !== old && bv !== old && hv !== bv) return true; } return false; }
