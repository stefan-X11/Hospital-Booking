import { checkKey, respond } from '@/lib/http';
import { listSlots } from '@/lib/store';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const denied = checkKey(req);
  if (denied) return denied;
  const url = new URL(req.url);
  return respond(listSlots(url.searchParams.get('available') === 'true'));
}
