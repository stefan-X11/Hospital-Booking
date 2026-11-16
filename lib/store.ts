/**
 * In-memory booking store and rules.
 *
 * Concurrency: every check-then-write below is synchronous (no await between
 * checking a slot and marking it booked), and a Node process runs JS on one
 * thread, so two simultaneous requests can never both win the same slot.
 * This holds for ONE long-running server process (`next start`). It does NOT
 * hold on serverless platforms where each request may hit a different instance.
 */
import { createHash, randomUUID } from 'crypto';

export type Slot = { id: string; [k: string]: unknown };
export type Booking = {
  id: string;
  slot_id: string;
  name: string;
  email: string;
  status: 'confirmed' | 'cancelled';
  created_at: string;
  cancelled_at?: string;
};
export type Result = { status: number; body: unknown; headers?: Record<string, string> };

export const RATE_LIMIT = 5;
export const RATE_WINDOW_MS = 60_000;

type State = {
  slots: Slot[];
  bookings: Map<string, Booking>;
  slotToBooking: Map<string, string>;
  idempotency: Map<string, { hash: string; status: number; body: unknown }>;
  attempts: Map<string, number[]>;
};

// One state object shared by every route bundle, and across dev hot reloads.
const g = globalThis as unknown as { __clinic?: State };
const S: State = (g.__clinic ??= {
  slots: [],
  bookings: new Map(),
  slotToBooking: new Map(),
  idempotency: new Map(),
  attempts: new Map(),
});

const START_FIELDS = ['start', 'starts_at', 'start_time', 'startsAt', 'startTime', 'datetime', 'time'];

function slotStartMs(slot: Slot): number {
  for (const f of START_FIELDS) {
    const v = slot[f];
    if (v !== undefined) {
      const t = typeof v === 'number' ? v : Date.parse(String(v));
      if (!Number.isNaN(t)) return t;
    }
  }
  return NaN;
}

function defaultSlots(): Slot[] {
  const out: Slot[] = [];
  const base = new Date();
  base.setUTCHours(0, 0, 0, 0);
  let n = 1;
  for (let day = 1; day <= 5; day++) {
    for (const hour of [9, 10, 11, 13, 14, 15]) {
      const start = new Date(base.getTime() + day * 86_400_000 + hour * 3_600_000);
      const end = new Date(start.getTime() + 30 * 60_000);
      out.push({ id: `s${n++}`, start: start.toISOString(), end: end.toISOString() });
    }
  }
  return out;
}

function loadSlots(list: Slot[]) {
  S.slots = list.map((s, i) => ({ ...s, id: String(s.id !== undefined ? s.id : `s${i + 1}`) }));
  S.bookings = new Map();
  S.slotToBooking = new Map();
  S.idempotency = new Map();
  S.attempts = new Map();
}
if (S.slots.length === 0) loadSlots(defaultSlots());

const err = (status: number, message: string, headers?: Record<string, string>): Result => ({
  status,
  body: { error: message },
  headers,
});

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const o = v as Record<string, unknown>;
  return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(o[k])).join(',') + '}';
}
const hashBody = (b: unknown) => createHash('sha256').update(stableStringify(b)).digest('hex');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isStr = (v: unknown): v is string => typeof v === 'string';

// ------------------------------------------------------------ operations
export function reset(body: unknown): Result {
  let list: unknown[] | null = null;
  if (Array.isArray(body)) list = body;
  else if (body && typeof body === 'object' && Array.isArray((body as { slots?: unknown }).slots)) {
    list = (body as { slots: unknown[] }).slots;
  }
  if (list && list.some((s) => s === null || typeof s !== 'object' || Array.isArray(s))) {
    return err(400, 'slots must be objects');
  }
  loadSlots(list && list.length ? (list as Slot[]) : defaultSlots());
  return { status: 200, body: { ok: true, slots: S.slots.length } };
}

export function listSlots(onlyAvailable: boolean): Result {
  let out = S.slots.map((s) => ({ ...s, available: !S.slotToBooking.has(s.id) }));
  if (onlyAvailable) out = out.filter((s) => s.available);
  return { status: 200, body: out };
}

function createBooking(body: Record<string, unknown>): Result {
  const slotId = isStr(body.slot_id) ? body.slot_id.trim() : '';
  const name = isStr(body.name) ? body.name.trim() : '';
  const email = isStr(body.email) ? body.email.trim().toLowerCase() : '';

  if (!slotId) return err(400, 'slot_id is required');
  if (!name) return err(400, 'name is required');
  if (!email) return err(400, 'email is required');
  if (!EMAIL_RE.test(email)) return err(400, 'email is invalid');

  const slot = S.slots.find((s) => s.id === slotId);
  if (!slot) return err(404, 'slot not found');

  const startMs = slotStartMs(slot);
  if (!Number.isNaN(startMs) && startMs <= Date.now()) return err(400, 'slot has already started');

  // Check-and-set with no await in between = atomic.
  if (S.slotToBooking.has(slot.id)) return err(409, 'slot already booked');

  const booking: Booking = {
    id: randomUUID(),
    slot_id: slot.id,
    name,
    email,
    status: 'confirmed',
    created_at: new Date().toISOString(),
  };
  S.bookings.set(booking.id, booking);
  S.slotToBooking.set(slot.id, booking.id);
  return { status: 201, body: booking };
}

/** Sliding window. Returns 0 if allowed (and records the attempt), else seconds to wait. */
function takeAttempt(email: string): number {
  const now = Date.now();
  const recent = (S.attempts.get(email) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) {
    S.attempts.set(email, recent);
    return Math.max(1, Math.ceil((recent[0] + RATE_WINDOW_MS - now) / 1000));
  }
  recent.push(now);
  S.attempts.set(email, recent);
  return 0;
}

export function bookSlot(body: unknown, idemKey: string | null): Result {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return err(400, 'body must be a JSON object');
  }
  const b = body as Record<string, unknown>;
  const hash = hashBody(b);

  // Exact replay: same key + same body returns the stored response, creates nothing.
  if (idemKey) {
    const saved = S.idempotency.get(idemKey);
    if (saved && saved.hash === hash) return { status: saved.status, body: saved.body };
  }

  // Rate limit by email: every attempt counts, including ones that fail validation.
  if (isStr(b.email) && b.email.trim()) {
    const wait = takeAttempt(b.email.trim().toLowerCase());
    if (wait > 0) return err(429, 'too many attempts for this email, try again later', { 'Retry-After': String(wait) });
  }

  if (idemKey && S.idempotency.has(idemKey)) {
    return err(422, 'Idempotency-Key was already used with a different request body');
  }

  const result = createBooking(b);
  if (idemKey) S.idempotency.set(idemKey, { hash, status: result.status, body: result.body });
  return result;
}

export function listBookings(emailRaw: string | null, pageRaw: string | null, limitRaw: string | null): Result {
  if (!emailRaw || !emailRaw.trim()) return err(400, 'email query parameter is required');
  const email = emailRaw.trim().toLowerCase();
  const page = pageRaw === null ? 1 : Number(pageRaw);
  const limit = limitRaw === null ? 10 : Number(limitRaw);
  if (!Number.isInteger(page) || page < 1) return err(400, 'page must be a positive integer');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return err(400, 'limit must be an integer between 1 and 100');

  const mine = [...S.bookings.values()]
    .filter((b) => b.email === email)
    .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
  const total = mine.length;
  return {
    status: 200,
    body: { data: mine.slice((page - 1) * limit, page * limit), page, limit, total, total_pages: Math.ceil(total / limit) },
  };
}

export function getBooking(id: string): Result {
  const b = S.bookings.get(id);
  return b ? { status: 200, body: b } : err(404, 'booking not found');
}

export function cancelBooking(id: string): Result {
  const b = S.bookings.get(id);
  if (!b) return err(404, 'booking not found');
  if (b.status !== 'cancelled') {
    b.status = 'cancelled';
    b.cancelled_at = new Date().toISOString();
    if (S.slotToBooking.get(b.slot_id) === b.id) S.slotToBooking.delete(b.slot_id); // frees the slot
  }
  return { status: 200, body: b };
}
