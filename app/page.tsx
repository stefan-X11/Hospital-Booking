'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

type Slot = { id: string; available?: boolean; [k: string]: unknown };
type Booking = { id: string; slot_id: string; name: string; email: string; status: string };
type Selected = { id: string; label: string };
type BookingsPage = { data: Booking[]; page: number; total_pages: number };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const KEY_STORE = 'clinic_api_key';

const startOf = (s: Slot) => new Date(String(s.start ?? s.starts_at ?? s.start_time ?? s.startsAt ?? s.datetime ?? s.time));
const fmtDay = (d: Date) => d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
const fmtTime = (d: Date) => d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

type SlotsState =
  | { kind: 'loading' }
  | { kind: 'auth' }
  | { kind: 'unreachable' }
  | { kind: 'error' }
  | { kind: 'ready'; slots: Slot[] };

export default function Page() {
  const [apiKey, setApiKey] = useState('');
  const [slotsState, setSlotsState] = useState<SlotsState>({ kind: 'loading' });
  const [selected, setSelected] = useState<Selected | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState<{ b: Booking; when: string } | null>(null);
  const [lookupEmail, setLookupEmail] = useState('');
  const [lookupPage, setLookupPage] = useState(1);
  const [bookings, setBookings] = useState<BookingsPage | null>(null);
  const [lookupMsg, setLookupMsg] = useState('');

  const formRef = useRef<HTMLElement>(null);
  const pending = useRef<{ sig: string; key: string }>({ sig: '', key: '' }); // Idempotency-Key reused while retrying the same details
  const keyRef = useRef('');
  keyRef.current = apiKey.trim();

  const api = useCallback(async (path: string, init: RequestInit = {}) => {
    const res = await fetch(path, {
      ...init,
      headers: { 'Content-Type': 'application/json', 'X-API-Key': keyRef.current, ...(init.headers || {}) },
    });
    let data: any = null;
    try { data = await res.json(); } catch {}
    return { res, data };
  }, []);

  const loadSlots = useCallback(async () => {
    try {
      const { res, data } = await api('/slots');
      if (res.status === 401) return setSlotsState({ kind: 'auth' });
      if (!res.ok) return setSlotsState({ kind: 'error' });
      setSlotsState({ kind: 'ready', slots: Array.isArray(data) ? data : data.slots || [] });
    } catch {
      setSlotsState({ kind: 'unreachable' });
    }
  }, [api]);

  // Restore the saved key once, then load times. Reload ~0.4s after the key changes.
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      const saved = localStorage.getItem(KEY_STORE) || new URLSearchParams(location.hash.slice(1)).get('key') || '';
      if (saved) { setApiKey(saved); keyRef.current = saved.trim(); }
      loadSlots();
      return;
    }
    const t = setTimeout(() => {
      localStorage.setItem(KEY_STORE, apiKey.trim());
      setError('');
      loadSlots();
    }, 400);
    return () => clearTimeout(t);
  }, [apiKey, loadSlots]);

  function pick(s: Slot, label: string) {
    setSelected({ id: s.id, label });
    setError('');
    if (window.matchMedia('(max-width:820px)').matches) {
      formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    localStorage.setItem(KEY_STORE, apiKey.trim());
    if (!selected) {
      return setError(slotsState.kind === 'auth' ? 'Enter the correct clinic access key first. No times can load without it.' : 'Choose a time first.');
    }
    if (!name.trim()) return setError('Enter your full name.');
    if (!EMAIL_RE.test(email.trim())) return setError('Enter a valid email address.');

    const body = JSON.stringify({ slot_id: selected.id, name: name.trim(), email: email.trim() });
    if (pending.current.sig !== body) pending.current = { sig: body, key: (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36)) }; // same details = safe retry
    setBusy(true);
    try {
      const { res, data } = await api('/bookings', { method: 'POST', body, headers: { 'Idempotency-Key': pending.current.key } });
      if (res.status === 201) {
        pending.current = { sig: '', key: '' };
        setConfirmed({ b: data, when: selected.label });
        setSelected(null);
        setName('');
        setEmail('');
        loadSlots();
      } else if (res.status === 409) {
        setError('Someone just booked that time. Pick another one.');
        setSelected(null);
        loadSlots();
      } else if (res.status === 401) setError('The clinic access key is missing or wrong.');
      else if (res.status === 429) setError(`Too many attempts for this email. Try again in ${res.headers.get('Retry-After') || 'a few'} seconds.`);
      else setError(data?.error ? data.error[0].toUpperCase() + data.error.slice(1) + '.' : 'Something went wrong. Try again.');
    } catch {
      setError('No connection. Check your network and try again.');
    } finally {
      setBusy(false);
    }
  }

  const loadBookings = useCallback(async (page: number, mail: string) => {
    if (!mail.trim()) { setBookings(null); setLookupMsg('Enter the email you booked with.'); return; }
    try {
      const { res, data } = await api(`/bookings?email=${encodeURIComponent(mail.trim())}&page=${page}&limit=5`);
      if (!res.ok) { setBookings(null); setLookupMsg(data?.error || 'Could not load bookings.'); return; }
      setLookupMsg(data.data.length ? '' : 'No bookings for this email yet.');
      setBookings(data);
    } catch {
      setBookings(null);
      setLookupMsg('Cannot reach the booking server.');
    }
  }, [api]);

  async function cancel(id: string) {
    await api(`/bookings/${id}`, { method: 'DELETE' });
    loadBookings(lookupPage, lookupEmail);
    loadSlots();
  }

  // Group slots by day
  const days = new Map<string, { s: Slot; d: Date }[]>();
  if (slotsState.kind === 'ready') {
    for (const s of slotsState.slots) {
      const d = startOf(s);
      if (isNaN(d.getTime())) continue;
      const k = d.toDateString();
      if (!days.has(k)) days.set(k, []);
      days.get(k)!.push({ s, d });
    }
  }

  return (
    <>
      <header>
        <h1>Book an appointment</h1>
        <p>Pick a time that suits you, enter your details, and you will get your confirmation straight away.</p>
      </header>

      <main>
        <section aria-labelledby="slots-h">
          <h2 id="slots-h">Available times</h2>
          <label htmlFor="apikey" style={{ marginTop: 0 }}>Clinic access key</label>
          <input id="apikey" type="password" autoComplete="off" style={{ maxWidth: 360 }} value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
          <div className="small" style={{ margin: '4px 0 16px' }}>Enter this first. Times appear below once it is accepted. Saved in this browser only.</div>

          <div aria-live="polite">
            {slotsState.kind === 'loading' && <p className="empty">Loading times…</p>}
            {slotsState.kind === 'auth' && <p className="empty">The clinic access key is missing or wrong, so no times can be shown. Enter the correct key above.</p>}
            {slotsState.kind === 'unreachable' && <p className="empty">Cannot reach the booking server. Make sure it is running and try again.</p>}
            {slotsState.kind === 'error' && <p className="empty">Times could not be loaded. Try again shortly.</p>}
            {slotsState.kind === 'ready' && days.size === 0 && <p className="empty">No times are open right now.</p>}
            {[...days.values()].map((items) => {
              items.sort((a, b) => a.d.getTime() - b.d.getTime());
              return (
                <div className="day" key={items[0].d.toDateString()}>
                  <h3>{fmtDay(items[0].d)}</h3>
                  <div className="times">
                    {items.map(({ s, d }) => {
                      const taken = s.available === false;
                      const label = `${fmtDay(d)}, ${fmtTime(d)}`;
                      return (
                        <button
                          key={s.id}
                          type="button"
                          className="time"
                          disabled={taken}
                          aria-pressed={selected?.id === s.id}
                          aria-label={`${fmtDay(d)} at ${fmtTime(d)}${taken ? ', taken' : ''}`}
                          onClick={() => pick(s, label)}
                        >
                          {fmtTime(d)}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <div>
          {!confirmed ? (
            <section id="form-card" ref={formRef}>
              <h2>Your details</h2>
              <div className="chosen small">{selected ? selected.label : 'Choose a time on the left.'}</div>
              <form onSubmit={submit} noValidate>
                <label htmlFor="name">Full name</label>
                <input id="name" autoComplete="name" required value={name} onChange={(e) => setName(e.target.value)} />
                <label htmlFor="email">Email</label>
                <input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
                <button className="primary" type="submit" disabled={busy}>{busy ? 'Booking…' : 'Book this time'}</button>
                {error && <div className="msg err" role="alert">{error}</div>}
              </form>
            </section>
          ) : (
            <section className="confirm" aria-live="polite">
              <h2>Your appointment is confirmed</h2>
              <p className="small" style={{ margin: 0 }}>Keep your booking reference in case you need to cancel.</p>
              <dl>
                <dt>When</dt><dd>{confirmed.when}</dd>
                <dt>Name</dt><dd>{confirmed.b.name}</dd>
                <dt>Email</dt><dd>{confirmed.b.email}</dd>
                <dt>Status</dt><dd>{confirmed.b.status}</dd>
                <dt>Reference</dt><dd>{confirmed.b.id}</dd>
              </dl>
              <button className="primary" type="button" onClick={() => setConfirmed(null)}>Book another time</button>
            </section>
          )}

          <section style={{ marginTop: 24 }}>
            <h2>Your bookings</h2>
            <div className="row">
              <input
                type="email"
                placeholder="Email used to book"
                aria-label="Email used to book"
                style={{ flex: 1, minWidth: 180 }}
                value={lookupEmail}
                onChange={(e) => setLookupEmail(e.target.value)}
              />
              <button className="primary" type="button" style={{ marginTop: 0 }} onClick={() => { setLookupPage(1); loadBookings(1, lookupEmail); }}>
                Show bookings
              </button>
            </div>
            <ul className="bk">
              {lookupMsg && <li className="empty">{lookupMsg}</li>}
              {bookings?.data.map((b) => (
                <li key={b.id}>
                  <span>
                    <strong>Slot {b.slot_id}</strong>
                    <br />
                    <span className="small">{b.status} · {b.id.slice(0, 8)}</span>
                  </span>
                  {b.status === 'confirmed' && <button className="link" type="button" onClick={() => cancel(b.id)}>Cancel</button>}
                </li>
              ))}
            </ul>
            {bookings && bookings.total_pages > 1 && (
              <div className="row">
                <button className="link" type="button" disabled={bookings.page <= 1} onClick={() => { const p = lookupPage - 1; setLookupPage(p); loadBookings(p, lookupEmail); }}>Previous</button>
                <span className="small">Page {bookings.page} of {bookings.total_pages}</span>
                <button className="link" type="button" disabled={bookings.page >= bookings.total_pages} onClick={() => { const p = lookupPage + 1; setLookupPage(p); loadBookings(p, lookupEmail); }}>Next</button>
              </div>
            )}
          </section>
        </div>
      </main>
    </>
  );
}
