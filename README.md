# Clinic Booking (Next.js)

Next.js App Router + TypeScript. The API route handlers and the web page live in one app.

    app/reset/route.ts            POST   /reset
    app/slots/route.ts            GET    /slots
    app/bookings/route.ts         POST/GET /bookings
    app/bookings/[id]/route.ts    GET/DELETE /bookings/{id}
    app/page.tsx                  the patient web page
    lib/store.ts                  all booking rules (slots, 409, idempotency, rate limit)
    lib/http.ts                   X-API-Key check + JSON helpers

## Run
    npm install
    API_KEY=your-secret-key npm run build && API_KEY=your-secret-key npm start   # http://localhost:3000
    # dev: API_KEY=your-secret-key npm run dev

If `API_KEY` is not set, the key is `koya-clinic-key`.

## Test (levels 1-5, includes 50 simultaneous bookings)
Terminal 1: `API_KEY=testkey npm start`
Terminal 2: `BASE_URL=http://127.0.0.1:3000 npm test`

## Deploy
Use a host that runs ONE long-lived Node process: Render, Railway, or Fly.io.
- Build command: `npm install && npm run build`
- Start command: `npm start`
- Environment variable: `API_KEY`

IMPORTANT: do not deploy to Vercel/serverless as-is. State is in memory, and serverless runs many
separate instances, so double-booking protection, idempotency and rate limits would not hold.
To use Vercel you need a shared database (e.g. Postgres with a UNIQUE constraint on the slot, and
Redis for rate limits).
