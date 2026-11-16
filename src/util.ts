import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const JSON_TYPE = 'application/json; charset=utf-8';
const fixedNow = process.env.MAKEFUN_TRIAL_NOW || '2026-11-14T00:00:00.000Z';
export const TRIAL_NOW = fixedNow;

let requestNumber = 0;
export function requestId(): string { requestNumber += 1; return `req-${requestNumber.toString(16)}`; }
export function sha1(data: Uint8Array | string): string { return createHash('sha1').update(data).digest('hex'); }
export function blobSha(bytes: Buffer): string { return sha1(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])); }
export function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), 'x-github-request-id': requestId(), ...headers });
  res.end(text);
}
export function empty(res: ServerResponse, status: number, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'x-github-request-id': requestId(), ...headers }); res.end();
}
export function readBody(req: IncomingMessage, limit = 2 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks: Buffer[] = [];
    req.on('data', (part: Buffer) => { size += part.length; if (size > limit) { reject(new Error('request body too large')); req.destroy(); return; } chunks.push(part); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
export async function jsonBody(req: IncomingMessage): Promise<Record<string, any>> {
  const raw = await readBody(req); if (!raw.trim()) return {};
  const value = JSON.parse(raw); if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('body must be an object');
  return value as Record<string, any>;
}
export function page<T>(items: T[], url: URL): { items: T[]; link?: string } {
  const per = Math.max(1, Math.min(100, Number(url.searchParams.get('per_page') || 30) || 30));
  const current = Math.max(1, Number(url.searchParams.get('page') || 1) || 1);
  const start = (current - 1) * per; const out = items.slice(start, start + per);
  if (start + per >= items.length) return { items: out };
  const next = new URL(url); next.searchParams.set('page', String(current + 1));
  return { items: out, link: `<${next}>; rel="next"` };
}
export function text(value: any, fallback = ''): string { return typeof value === 'string' ? value : fallback; }
