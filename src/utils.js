import { request } from 'undici';

export async function fetchJson(url, opts={}) {
  const r = await request(url, {
    method: opts.method||'GET',
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    headers: { 'content-type':'application/json', ...(opts.headers||{}) }
  });
  if (r.statusCode < 200 || r.statusCode >= 300) {
    const text = await r.body.text();
    throw new Error(`HTTP ${r.statusCode}: ${text}`);
  }
  return await r.body.json();
}

export function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }
