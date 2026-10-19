// Thin PostgREST client: no SDK, no build step, works from static hosting.
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

const UID_KEY = 'ctm_uid';

export function uid() {
  let id = localStorage.getItem(UID_KEY);
  if (!id) {
    id = (crypto.randomUUID && crypto.randomUUID()) ||
      `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(UID_KEY, id);
  }
  return id;
}

export function username() {
  return `USER_${uid().replace(/-/g, '').slice(0, 6).toUpperCase()}`;
}

export function userColor() {
  const hues = [0, 28, 48, 96, 168, 192, 214, 260, 300, 330];
  const seed = uid().replace(/-/g, '');
  const n = parseInt(seed.slice(0, 8), 16) || seed.length;
  return `hsl(${hues[n % hues.length]}, 62%, 58%)`;
}

async function request(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'x-client-id': uid(),
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(text || res.statusText);
    err.status = res.status;
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

export const db = {
  select: (path) => request(path),
  insert: (table, row) => request(table, {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(row),
  }),
  patch: (path, row) => request(path, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(row),
  }),
  remove: (path) => request(path, {
    method: 'DELETE',
    headers: { Prefer: 'return=representation' },
  }),
};
