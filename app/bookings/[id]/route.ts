import { checkKey, respond } from '@/lib/http';
import { cancelBooking, getBooking } from '@/lib/store';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  const denied = checkKey(req);
  if (denied) return denied;
  const { id } = await params;
  return respond(getBooking(id));
}

export async function DELETE(req: Request, { params }: Ctx) {
  const denied = checkKey(req);
  if (denied) return denied;
  const { id } = await params;
  return respond(cancelBooking(id));
}
