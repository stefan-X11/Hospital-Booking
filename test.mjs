// Run: API_KEY=testkey npm start  (one terminal), then: BASE_URL=http://127.0.0.1:3000 npm test
import assert from 'node:assert';
const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';


const H = { 'X-API-Key': 'testkey', 'Content-Type': 'application/json' };
let base;
const call = async (method, path, body, headers = {}) => {
  const r = await fetch(base + path, { method, headers: { ...H, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null; try { data = await r.json(); } catch {}
  return { status: r.status, data, headers: r.headers };
};
const reset = () => call('POST', '/reset');

(async () => {
  base = BASE;
  const ok = (m) => console.log('  ok  ' + m);

  // Level 2: auth
  let r = await fetch(base + '/slots'); assert.equal(r.status, 401);
  r = await fetch(base + '/slots', { headers: { 'X-API-Key': 'nope' } }); assert.equal(r.status, 401);
  assert.deepEqual(await r.json(), { error: 'missing or invalid API key' }); ok('401 without/with wrong key');

  // Level 1
  await reset();
  r = await call('GET', '/slots'); assert.equal(r.status, 200); assert(r.data.length > 0);
  const sid = r.data[0].id;
  r = await call('POST', '/bookings', { slot_id: sid, name: '  Ada Obi ', email: ' ADA@Example.com ' });
  assert.equal(r.status, 201); assert.equal(r.data.status, 'confirmed');
  assert.equal(r.data.name, 'Ada Obi'); assert.equal(r.data.email, 'ada@example.com'); assert(r.data.id && r.data.created_at);
  const bid = r.data.id;
  r = await call('GET', '/bookings/' + bid); assert.equal(r.status, 200); assert.equal(r.data.id, bid);
  r = await call('GET', '/bookings/nope'); assert.equal(r.status, 404); ok('level 1 book + lookup');

  // Level 2: validation
  await reset();
  for (const bad of [{}, { slot_id: 's1', name: 'A' }, { slot_id: 's1', email: 'a@b.co' }, { name: 'A', email: 'a@b.co' },
    { slot_id: 's1', name: '   ', email: 'a@b.co' }, { slot_id: 's1', name: 'A', email: 'not-an-email' }, { slot_id: 5, name: 'A', email: 'a@b.co' }]) {
    r = await call('POST', '/bookings', bad); assert.equal(r.status, 400, JSON.stringify(bad)); assert(r.data.error);
  }
  r = await call('POST', '/bookings', { slot_id: 'zzz', name: 'A', email: 'v1@b.co' }); assert.equal(r.status, 404);
  assert.deepEqual(r.data, { error: 'slot not found' });
  await call('POST', '/reset', { slots: [{ id: 'past', start: new Date(Date.now() - 3600e3).toISOString() }, { id: 'future', start: new Date(Date.now() + 3600e3).toISOString() }] });
  r = await call('POST', '/bookings', { slot_id: 'past', name: 'A', email: 'p@b.co' }); assert.equal(r.status, 400); ok('level 2 validation, 404, started slot');

  // Level 3: concurrency + cancel
  await reset();
  const results = await Promise.all(Array.from({ length: 50 }, (_, i) => call('POST', '/bookings', { slot_id: 's2', name: 'P' + i, email: `p${i}@b.co` })));
  const wins = results.filter((x) => x.status === 201).length, conflicts = results.filter((x) => x.status === 409).length;
  assert.equal(wins, 1); assert.equal(conflicts, 49); ok('50 simultaneous bookings -> exactly 1 wins, 49 x 409');
  const winner = results.find((x) => x.status === 201).data;
  r = await call('DELETE', '/bookings/' + winner.id); assert.equal(r.status, 200); assert.equal(r.data.status, 'cancelled');
  r = await call('POST', '/bookings', { slot_id: 's2', name: 'Next', email: 'next@b.co' }); assert.equal(r.status, 201); ok('cancel frees the slot');
  r = await call('DELETE', '/bookings/nope'); assert.equal(r.status, 404);

  // Level 4: idempotency + paging
  await reset();
  const body = { slot_id: 's3', name: 'Ida', email: 'ida@b.co' };
  const a = await call('POST', '/bookings', body, { 'Idempotency-Key': 'k1' });
  const b = await call('POST', '/bookings', body, { 'Idempotency-Key': 'k1' });
  assert.equal(a.status, 201); assert.equal(b.status, 201); assert.equal(a.data.id, b.data.id);
  r = await call('POST', '/bookings', { ...body, name: 'Other' }, { 'Idempotency-Key': 'k1' }); assert.equal(r.status, 422);
  const par = await Promise.all(Array.from({ length: 10 }, () => call('POST', '/bookings', { slot_id: 's4', name: 'Z', email: 'z@b.co' }, { 'Idempotency-Key': 'kpar' })));
  assert.equal(new Set(par.map((x) => x.data.id)).size, 1); ok('idempotent replay, 422 on different body, parallel retries');
  for (let i = 5; i <= 9; i++) await call('POST', '/bookings', { slot_id: 's' + i, name: 'Pg', email: 'pg@b.co' }); // 5 attempts
  await reset();
  // paging: use 3 different emails-worth of attempts? same email limited to 5/min, so page with limit 2
  for (let i = 1; i <= 5; i++) await call('POST', '/bookings', { slot_id: 's' + i, name: 'Pg', email: 'pg@b.co' });
  r = await call('GET', '/bookings?email=PG@b.co&page=1&limit=2'); assert.equal(r.data.data.length, 2); assert.equal(r.data.total, 5);
  r = await call('GET', '/bookings?email=pg@b.co&page=3&limit=2'); assert.equal(r.data.data.length, 1);
  r = await call('GET', '/bookings?email=pg@b.co&page=9&limit=2'); assert.equal(r.data.data.length, 0);
  r = await call('GET', '/bookings'); assert.equal(r.status, 400); ok('paging by email');

  // Level 5: rate limit
  await reset();
  for (let i = 1; i <= 5; i++) { r = await call('POST', '/bookings', { slot_id: 'nope', name: 'S', email: 'spam@b.co' }); assert.equal(r.status, 404); }
  r = await call('POST', '/bookings', { slot_id: 's1', name: 'S', email: 'SPAM@b.co' });
  assert.equal(r.status, 429); const ra = Number(r.headers.get('retry-after')); assert(Number.isInteger(ra) && ra >= 1 && ra <= 60);
  r = await call('POST', '/bookings', { slot_id: 's1', name: 'S', email: 'other@b.co' }); assert.equal(r.status, 201); ok('6th attempt -> 429 + Retry-After, other emails unaffected');

  console.log('\nAll checks passed');
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
