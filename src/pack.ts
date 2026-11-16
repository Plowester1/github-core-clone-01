import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { GitObject } from './store.ts';

export const flush = Buffer.from('0000'), delim = Buffer.from('0001');
export function pkt(value: string | Buffer): Buffer {
  const b = typeof value === 'string' ? Buffer.from(value) : value;
  if (b.length > 65516) throw new Error('Packet too large');
  return Buffer.concat([Buffer.from((b.length + 4).toString(16).padStart(4, '0')), b]);
}
export function packets(b: Buffer, stopAtFlush = false): { lines: string[]; offset: number } {
  let offset = 0; const lines: string[] = [];
  while (offset < b.length) {
    const h = b.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(h)) throw new Error('Invalid packet header');
    const n = parseInt(h, 16); offset += 4;
    if (n < 3) { if (n === 0 && stopAtFlush) return { lines, offset }; continue; }
    if (n < 4 || n > 65520 || offset + n - 4 > b.length) throw new Error('Truncated packet');
    lines.push(b.toString('utf8', offset, offset + n - 4).replace(/\n$/, '')); offset += n - 4;
  }
  return { lines, offset };
}
export function sideband(b: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let i = 0; i < b.length; i += 65515) out.push(pkt(Buffer.concat([Buffer.from([1]), b.subarray(i, i + 65515)])));
  return out;
}
export function objectId(type: string, bytes: Buffer): string { return createHash('sha1').update(`${type} ${bytes.length}\0`).update(bytes).digest('hex'); }
const codes = { commit: 1, tree: 2, blob: 3, tag: 4 };
const types = ['', 'commit', 'tree', 'blob', 'tag'] as const;
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let p = 0;
  const byte = () => { if (p >= delta.length) throw new Error('Truncated delta'); return delta[p++]; };
  const size = () => { let n = 0, shift = 0, b: number; do { b = byte(); n += (b & 127) * 2 ** shift; shift += 7; if (shift > 49) throw new Error('Invalid delta size'); } while (b & 128); return n; };
  if (size() !== base.length) throw new Error('Delta base size mismatch');
  const length = size(); if (length > 64 * 1024 * 1024) throw new Error('Object too large');
  const out = Buffer.alloc(length); let at = 0;
  while (p < delta.length) {
    const op = byte(); let offset = 0, count = 0;
    if (op & 128) {
      for (let i = 0; i < 4; i++) if (op & (1 << i)) offset += byte() * 2 ** (8 * i);
      for (let i = 0; i < 3; i++) if (op & (16 << i)) count += byte() * 2 ** (8 * i);
      count ||= 65536;
      if (offset + count > base.length || at + count > length) throw new Error('Invalid delta copy');
      base.copy(out, at, offset, offset + count);
    } else {
      count = op; if (!count || p + count > delta.length || at + count > length) throw new Error('Invalid delta insert');
      delta.copy(out, at, p, p + count); p += count;
    }
    at += count;
  }
  if (at !== length) throw new Error('Delta length mismatch'); return out;
}
export function readPack(b: Buffer, existing = new Map<string, GitObject>(), compress = true): Map<string, GitObject> {
  const end = b.length - 20;
  if (b.length < 32 || b.toString('ascii', 0, 4) !== 'PACK' || ![2, 3].includes(b.readUInt32BE(4))) throw new Error('Invalid pack header');
  if (!createHash('sha1').update(b.subarray(0, end)).digest().equals(b.subarray(end))) throw new Error('Pack checksum mismatch');
  let p = 12;
  const byte = () => { if (p >= end) throw new Error('Truncated pack'); return b[p++]; };
  const entries: { offset: number; code: number; bytes: Buffer; base?: string | number; object?: GitObject }[] = [];
  const offsets = new Map<number, typeof entries[number]>(); const objects = new Map<string, GitObject>();
  for (let i = 0; i < b.readUInt32BE(8); i++) {
    const offset = p; let c = byte(), size = c & 15, shift = 4; const code = (c >> 4) & 7;
    while (c & 128) { c = byte(); size += (c & 127) * 2 ** shift; shift += 7; if (shift > 49) throw new Error('Invalid pack size'); }
    let base: string | number | undefined;
    if (code === 6) { c = byte(); let distance = c & 127; while (c & 128) { c = byte(); distance = (distance + 1) * 128 + (c & 127); } base = offset - distance; if (!offsets.has(base)) throw new Error('Invalid delta offset'); }
    else if (code === 7) { if (p + 20 > end) throw new Error('Truncated base'); base = b.toString('hex', p, p + 20); p += 20; }
    else if (code < 1 || code > 4) throw new Error('Invalid object type');
    const result = inflateSync(b.subarray(p, end), { info: true, maxOutputLength: 64 * 1024 * 1024 }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    p += result.engine.bytesWritten; if (result.buffer.length !== size) throw new Error('Pack object size mismatch');
    const entry = { offset, code, bytes: result.buffer, base } as typeof entries[number]; entries.push(entry); offsets.set(offset, entry);
  }
  if (p !== end) throw new Error('Trailing pack bytes');
  let pending = entries.length;
  while (pending) {
    let progress = false;
    for (const e of entries) {
      if (e.object) continue;
      const base = typeof e.base === 'number' ? offsets.get(e.base)?.object : typeof e.base === 'string' ? objects.get(e.base) ?? existing.get(e.base) : undefined;
      if (e.code > 4 && !base) continue;
      const type = base ? base.type : types[e.code] as GitObject['type']; const bytes = base ? applyDelta(base.bytes, e.bytes) : e.bytes;
      e.object = { type, bytes, deflated: compress ? deflateSync(bytes) : undefined }; objects.set(objectId(type, bytes), e.object); pending--; progress = true;
    }
    if (!progress) throw new Error('Missing delta base');
  }
  return objects;
}
export function writePack(objects: GitObject[]): Buffer {
  const header = Buffer.alloc(12); header.write('PACK'); header.writeUInt32BE(2, 4); header.writeUInt32BE(objects.length, 8);
  const parts = [header];
  for (const o of objects) {
    let size = o.bytes.length, b = (codes[o.type] << 4) | (size & 15); size = Math.floor(size / 16); const bytes: number[] = [];
    while (size) { bytes.push(b | 128); b = size & 127; size = Math.floor(size / 128); } bytes.push(b);
    parts.push(Buffer.from(bytes), o.deflated ??= deflateSync(o.bytes));
  }
  const body = Buffer.concat(parts); const pack = Buffer.concat([body, createHash('sha1').update(body).digest()]);
  const checked = readPack(pack, undefined, false);
  for (const o of objects) if (!checked.get(objectId(o.type, o.bytes))?.bytes.equals(o.bytes)) throw new Error('Generated pack verification failed');
  return pack;
}
export function treeEntries(bytes: Buffer): { mode: string; name: string; sha: string }[] {
  const out = []; let p = 0;
  while (p < bytes.length) {
    const space = bytes.indexOf(32, p), nul = bytes.indexOf(0, space + 1);
    if (space < p || nul < space || nul + 21 > bytes.length) throw new Error('Invalid tree');
    out.push({ mode: bytes.toString('ascii', p, space), name: bytes.toString('utf8', space + 1, nul), sha: bytes.toString('hex', nul + 1, nul + 21) }); p = nul + 21;
  }
  return out;
}
