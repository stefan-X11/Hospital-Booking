import { checkKey, readJson, respond } from '@/lib/http';
import { bookSlot, listBookings } from '@/lib/store';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const denied = checkKey(req);
  if (denied) return denied;
  const parsed = await readJson(req);
  if ('error' in parsed) return parsed.error;
  return respond(bookSlot(parsed.body === null ? {} : parsed.body, req.headers.get('idempotency-key')));
}

export async function GET(req: Request) {
  const denied = checkKey(req);
  if (denied) return denied;
  const q = new URL(req.url).searchParams;
  return respond(listBookings(q.get('email'), q.get('page'), q.get('limit')));
}
