// listener.cjs — POLLING + fallbacks para extraer mints
// Requisitos: npm i @solana/web3.js bs58

const { Connection, PublicKey } = require('@solana/web3.js');
const bs58 = require('bs58');

const LOG_PREFIX = 'LISTENER-POLL';

// ===== Config (.env) =====
const RPC_URL_HTTP = process.env.RPC_URL_HTTP || 'https://api.mainnet-beta.solana.com';
const LISTENER_POLL_MS = Number(process.env.LISTENER_POLL_MS || '1500');
const PROCESS_RPS      = Number(process.env.LISTENER_FETCH_RPS || '3');
const MAX_EMIT_RPS     = Number(process.env.LISTENER_MAX_EMIT_RPS || '5');
const TX_COMMITMENT    = (process.env.TX_FETCH_COMMITMENT || 'confirmed');
const MAX_TX_RETRIES   = Number(process.env.LISTENER_MAX_TX_RETRIES || '5');
const RETRY_NULL_TX_MS = Number(process.env.LISTENER_RETRY_NULL_TX_MS || '1200');
const DEDUP_TTL_MS     = Number(process.env.LISTENER_DEDUP_TTL_MS || '60000');
const CANDIDATE_MAX_PER_TX = Number(process.env.CANDIDATE_MAX_PER_TX || '3');
const MINT_LOOKUP_RPS  = Number(process.env.MINT_LOOKUP_RPS || '8');
const MINT_LOOKUP_MAX_PER_TX = Number(process.env.MINT_LOOKUP_MAX_PER_TX || '6');

const RAYDIUM_PROGRAM_IDS = (process.env.RAYDIUM_PROGRAM_IDS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

// ===== Estado dedupe =====
const dedup = new Map();
function dedupHas(k) {
  const t = dedup.get(k);
  if (!t) return false;
  if (Date.now() - t > DEDUP_TTL_MS) { dedup.delete(k); return false; }
  return true;
}
function dedupAdd(k) { dedup.set(k, Date.now()); }
setInterval(() => {
  const now = Date.now();
  for (const [k,t] of dedup.entries()) if (now - t > DEDUP_TTL_MS) dedup.delete(k);
}, Math.max(DEDUP_TTL_MS, 5000));

// ===== Rate limit (tokens/seg) =====
let emitTokens = MAX_EMIT_RPS, emitLast = Date.now();
function allowEmit() {
  const now = Date.now(), d = (now - emitLast) / 1000;
  const add = Math.floor(d * MAX_EMIT_RPS);
  if (add > 0) { emitTokens = Math.min(MAX_EMIT_RPS, emitTokens + add); emitLast = now; }
  if (emitTokens > 0) { emitTokens--; return true; }
  return false;
}

let processTokens = PROCESS_RPS, processLast = Date.now();
function allowProcess() {
  const now = Date.now(), d = (now - processLast) / 1000;
  const add = Math.floor(d * PROCESS_RPS);
  if (add > 0) { processTokens = Math.min(PROCESS_RPS, processTokens + add); processLast = now; }
  if (processTokens > 0) { processTokens--; return true; }
  return false;
}

let lookupTokens = MINT_LOOKUP_RPS, lookupLast = Date.now();
function allowLookup() {
  const now = Date.now(), d = (now - lookupLast) / 1000;
  const add = Math.floor(d * MINT_LOOKUP_RPS);
  if (add > 0) { lookupTokens = Math.min(MINT_LOOKUP_RPS, lookupTokens + add); lookupLast = now; }
  if (lookupTokens > 0) { lookupTokens--; return true; }
  return false;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ===== Utils =====
function isValidMint(s) {
  try { return bs58.decode(s).length === 32; } catch { return false; }
}
function uniq(arr) { return Array.from(new Set(arr)); }

// ---------- Extracción de mints ----------
function extractMintsFast(tx) {
  const out = new Set();
  const meta = tx?.meta;

  if (meta) {
    const pre = meta.preTokenBalances || [];
    const post = meta.postTokenBalances || [];
    for (const b of pre)  if (b?.mint && isValidMint(b.mint)) out.add(b.mint);
    for (const b of post) if (b?.mint && isValidMint(b.mint)) out.add(b.mint);
    if (out.size > 0) return Array.from(out).slice(0, CANDIDATE_MAX_PER_TX);
  }

  try {
    const iis = meta?.innerInstructions || [];
    for (const ii of iis) {
      const ins = ii?.instructions || [];
      for (const inst of ins) {
        const mintA = inst?.parsed?.info?.mint;
        if (mintA && isValidMint(mintA)) out.add(mintA);
        const mintB = inst?.data?.parsed?.info?.mint;
        if (mintB && isValidMint(mintB)) out.add(mintB);
      }
    }
    if (out.size > 0) return Array.from(out).slice(0, CANDIDATE_MAX_PER_TX);
  } catch (_) {}

  try {
    const msgIns = tx?.transaction?.message?.instructions || [];
    for (const inst of msgIns) {
      const mintA = inst?.parsed?.info?.mint;
      if (mintA && isValidMint(mintA)) out.add(mintA);
      const mintB = inst?.data?.parsed?.info?.mint;
      if (mintB && isValidMint(mintB)) out.add(mintB);
    }
    if (out.size > 0) return Array.from(out).slice(0, CANDIDATE_MAX_PER_TX);
  } catch (_) {}

  try {
    const lines = meta?.logMessages || [];
    if (Array.isArray(lines) && lines.length) {
      const text = lines.join(' ');
      const re = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
      const hits = text.match(re) || [];
      for (const s of hits) {
        if (isValidMint(s)) out.add(s);
        if (out.size >= CANDIDATE_MAX_PER_TX) break;
      }
      if (out.size > 0) return Array.from(out).slice(0, CANDIDATE_MAX_PER_TX);
    }
  } catch (_) {}

  try {
    const keys = tx?.transaction?.message?.accountKeys || [];
    for (const k of keys) {
      const pk = typeof k === 'string' ? k : k?.pubkey;
      if (pk && isValidMint(pk)) {
        out.add(pk);
        if (out.size >= CANDIDATE_MAX_PER_TX) break;
      }
    }
  } catch (_) {}

  return Array.from(out).slice(0, CANDIDATE_MAX_PER_TX);
}

async function resolveMintsFromAccounts(conn, tx) {
  const out = new Set();
  const keysRaw = tx?.transaction?.message?.accountKeys || [];
  const keys = keysRaw.map(k => (typeof k === 'string' ? k : k?.pubkey)).filter(Boolean);

  for (const k of keys.slice(0, MINT_LOOKUP_MAX_PER_TX)) {
    if (out.size >= CANDIDATE_MAX_PER_TX) break;
    try {
      while (!allowLookup()) await sleep(50);
      const info = await conn.getParsedAccountInfo(new PublicKey(k), { commitment: TX_COMMITMENT });
      const val = info?.value;
      const parsed = val?.data?.parsed;
      const type = parsed?.type;

      if (type === 'mint') {
        if (isValidMint(k)) out.add(k);
      } else if (type === 'account') {
        const mint = parsed?.info?.mint;
        if (mint && isValidMint(mint)) out.add(mint);
      }
    } catch (_) {}
  }
  return Array.from(out).slice(0, CANDIDATE_MAX_PER_TX);
}

// ===== Cola de firmas =====
const sigQueue = [];
const queued = new Set();
const inflight = new Set();
const attempts = new Map();

function enqueue(sig) {
  if (!sig) return;
  if (queued.has(sig) || inflight.has(sig)) return;
  queued.add(sig);
  sigQueue.push(sig);
}

// ===== Heartbeat =====
let hbPolled = 0, hbQueued = 0, hbFetched = 0, hbEmitted = 0;
setInterval(() => {
  console.log(`[${LOG_PREFIX}] hb polled=${hbPolled} | queued=${sigQueue.length} | fetchedTx=${hbFetched} | emitted=${hbEmitted} | lookupsRps=${MINT_LOOKUP_RPS}`);
  hbPolled = 0; hbQueued = sigQueue.length; hbFetched = 0; hbEmitted = 0;
}, 10000);

// ===== Main =====
async function start({ onCandidate }) {
  console.log(`[${LOG_PREFIX}] HTTP: ${RPC_URL_HTTP}`);
  console.log(`[${LOG_PREFIX}] Programas: ${RAYDIUM_PROGRAM_IDS.join(', ')}`);
  console.log(`[${LOG_PREFIX}] pollMs=${LISTENER_POLL_MS} | processRps=${PROCESS_RPS} | emitRps=${MAX_EMIT_RPS} | commitment=${TX_COMMITMENT} | lookupRps=${MINT_LOOKUP_RPS}`);

  const conn = new Connection(RPC_URL_HTTP, { commitment: 'confirmed' });

  async function pollOnce() {
    for (const pid of RAYDIUM_PROGRAM_IDS) {
      try {
        const sigs = await conn.getSignaturesForAddress(new PublicKey(pid), { limit: 25 });
        hbPolled += sigs.length;
        for (const s of sigs) {
          const sig = s?.signature;
          if (!sig) continue;
          const key = `sig:${sig}`;
          if (dedupHas(key)) continue;
          dedupAdd(key);
          enqueue(sig);
        }
      } catch (e) {
        console.log(`[${LOG_PREFIX}] [WARN] poll ${pid.slice(0,6)}…:`, e?.message || e);
      }
    }
  }
  setInterval(pollOnce, LISTENER_POLL_MS);
  pollOnce().catch(()=>{});

  async function processOne(signature) {
    inflight.add(signature);
    try {
      let tx = await conn.getParsedTransaction(signature, {
        commitment: TX_COMMITMENT,
        maxSupportedTransactionVersion: 0
      });

      if (!tx) {
        const n = (attempts.get(signature) || 0) + 1;
        attempts.set(signature, n);
        if (n < MAX_TX_RETRIES) setTimeout(() => enqueue(signature), RETRY_NULL_TX_MS);
        return;
      }

      hbFetched++;

      // Debug cada 12 tx
      if (hbFetched % 12 === 0) {
        const meta = tx?.meta || {};
        console.log(
          `[${LOG_PREFIX}] shape sig=${signature.slice(0,8)}…`
          + ` pre=${meta.preTokenBalances?.length||0}`
          + ` post=${meta.postTokenBalances?.length||0}`
          + ` inner=${meta.innerInstructions?.length||0}`
          + ` logs=${Array.isArray(meta.logMessages)?meta.logMessages.length:0}`
          + ` keys=${tx?.transaction?.message?.accountKeys?.length||0}`
        );
      }

      // Fast path
      let mints = extractMintsFast(tx);
      console.log(`[${LOG_PREFIX}] extractMintsFast ->`, mints);

      if (!mints.length) {
        mints = await resolveMintsFromAccounts(conn, tx);
        console.log(`[${LOG_PREFIX}] resolveMintsFromAccounts ->`, mints);
      }

      for (const mint of mints) {
        const mKey = `mint:${mint}`;
        if (dedupHas(mKey)) continue;
        if (!allowEmit()) continue;
        dedupAdd(mKey);

        const candidate = { mint, symbol: mint.slice(0,4), ts: Date.now() };
        try { hbEmitted++; await onCandidate(candidate); }
        catch (e) { console.log(`[${LOG_PREFIX}] [ERR] onCandidate:`, e?.message || e); }
      }
    } catch (e) {
      const n = (attempts.get(signature) || 0) + 1;
      attempts.set(signature, n);
      if (n < MAX_TX_RETRIES) setTimeout(() => enqueue(signature), RETRY_NULL_TX_MS);
      console.log(`[${LOG_PREFIX}] [WARN] getParsedTransaction ${signature}:`, e?.message || e);
    } finally {
      inflight.delete(signature);
    }
  }

  setInterval(async () => {
    let budget = PROCESS_RPS;
    while (budget > 0 && sigQueue.length) {
      if (!allowProcess()) break;
      const sig = sigQueue.shift();
      queued.delete(sig);
      budget--;
      processOne(sig).catch(()=>{});
    }
  }, 200);
}

module.exports = { start };
