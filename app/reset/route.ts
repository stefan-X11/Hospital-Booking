import { checkKey, readJson, respond } from '@/lib/http';
import { reset } from '@/lib/store';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const denied = checkKey(req);
  if (denied) return denied;
  const parsed = await readJson(req);
  if ('error' in parsed) return parsed.error;
  return respond(reset(parsed.body));
}
