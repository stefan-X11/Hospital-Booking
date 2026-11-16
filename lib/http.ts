import { createHash, timingSafeEqual } from 'crypto';
import type { Result } from './store';

const API_KEY = process.env.API_KEY || 'koya-clinic-key';

const digest = (s: string) => createHash('sha256').update(s).digest();

/** Level 2: returns a 401 Response when the key is missing or wrong, otherwise null. */
export function checkKey(req: Request): Response | null {
  const key = req.headers.get('x-api-key');
  if (!key || !timingSafeEqual(digest(key), digest(API_KEY))) {
    return Response.json({ error: 'missing or invalid API key' }, { status: 401 });
  }
  return null;
}

export function respond(r: Result): Response {
  return Response.json(r.body, { status: r.status, headers: r.headers });
}

/** Parses a JSON body. Returns { body } (null when empty) or { error } (a ready 400 Response). */
export async function readJson(req: Request): Promise<{ body: unknown } | { error: Response }> {
  const raw = await req.text();
  if (!raw.trim()) return { body: null };
  try {
    return { body: JSON.parse(raw) };
  } catch {
    return { error: Response.json({ error: 'invalid JSON body' }, { status: 400 }) };
  }
}

export const notFound = () => Response.json({ error: 'not found' }, { status: 404 });
