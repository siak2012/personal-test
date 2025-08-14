// src/ws-listener-advanced-v2.js
// WS listener con filtros + blocklist/allowlist + dedupe + trazas HIT/MISS + simulación simple

import 'dotenv/config';
import WebSocket from 'ws';
import axios from 'axios';
import fs from 'fs';
import path from 'path';

// ================== ENV & CONFIG ==================
const WS_URL = process.env.RPC_URL_WS || 'wss://api.mainnet-beta.solana.com';

// Defaults de Raydium (si no pones nada en .env)
const RAYDIUM_DEFAULT = [
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', // AMM CPMM
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // AMM V4
  '5quBtoiQqxF9Jv6KYKctB59NT3gtJD2Y65kdnB1Uev3h', // CLMM helper
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK'  // Router
];

const RAYDIUM_PROGRAM_IDS = (process.env.RAYDIUM_PROGRAM_IDS || RAYDIUM_DEFAULT.join(','))
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const PUMPFUN_PROGRAM_ID = (process.env.PUMPFUN_PROGRAM_ID || '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P').trim();

const ONLY_HITS            = process.env.ONLY_HITS === '1';   // solo imprime si pasa filtros
const DEBUG_MARKET         = process.env.DEBUG_MARKET === '1';
const MAX_MARKET_PROBES    = Number(process.env.MAX_MARKET_PROBES || '8');   // candidatos por tx
const SIMULATED_AMOUNT_SOL = Number(process.env.SIMULATED_AMOUNT_SOL || '0.001');
const SIM_SPREAD_BPS       = Number(process.env.SIM_SPREAD_BPS || '100');    // 1% RT
const SLIPPAGE_BPS         = Number(process.env.SLIPPAGE_BPS || '150');      // 1.5% (sim)
const MIN_LIQ_USD          = Number(process.env.MIN_LIQ_USD || '8000');
const MIN_VOL_USD          = Number(process.env.MIN_VOL_USD || '5000');
const BIRDEYE_KEY          = (process.env.BIRDEYE_KEY || '').trim(); // opcional

// ================== RUTAS & FICHEROS ==================
const ROOT = process.cwd();
const CSV_PATH        = path.join(ROOT, 'simulation_results.csv');
const BLOCKLIST_PATH  = path.join(ROOT, 'blocklist.txt');   // una mint por línea
const ALLOWLIST_PATH  = path.join(ROOT, 'allowlist.txt');   // opcional: si tiene contenido, solo mints de aquí

ensureFile(BLOCKLIST_PATH, '# una mint por línea\n');
ensureFile(ALLOWLIST_PATH, '# (opcional) si pones mints aquí, solo se considerarán estas\n');
ensureCsv();

// Carga listas
function loadList(fp) {
  try {
    const raw = fs.readFileSync(fp, 'utf8');
    return new Set(raw
      .split(/\r?\n/)
      .map(l => l.split('#')[0].trim())
      .filter(Boolean));
  } catch {
    return new Set();
  }
}

let BLOCKLIST = loadList(BLOCKLIST_PATH);
let ALLOWLIST = loadList(ALLOWLIST_PATH);

// (re)cargar si cambian
fs.watch(BLOCKLIST_PATH, { persistent: false }, () => BLOCKLIST = loadList(BLOCKLIST_PATH));
fs.watch(ALLOWLIST_PATH,  { persistent: false }, () => ALLOWLIST = loadList(ALLOWLIST_PATH));

// ================== CSV ==================
function ensureCsv() {
  if (!fs.existsSync(CSV_PATH)) {
    fs.writeFileSync(
      CSV_PATH,
      'timestamp,source,signature,mint,buyPrice,sellPrice,pnlPerc,pnlSol,liqUsd,volUsd\n',
      'utf8'
    );
  }
}

function appendCsv(row) {
  const {
    timestamp, source, signature, mint,
    buyPrice, sellPrice, pnlPerc, pnlSol,
    liqUsd, volUsd
  } = row;
  const line = [
    timestamp, source, signature, mint,
    buyPrice, sellPrice, pnlPerc, pnlSol,
    liqUsd, volUsd
  ].join(',') + '\n';
  fs.appendFile(CSV_PATH, line, () => {});
}

// ================== UTILES ==================
function ensureFile(fp, defaultContent = '') {
  try {
    if (!fs.existsSync(fp)) fs.writeFileSync(fp, defaultContent, 'utf8');
  } catch (e) {
    console.error('⚠️ No se pudo crear', fp, e.message);
  }
}

const BASE58_RE = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;

// cuentas que ignoramos siempre (programas comunes)
const IGNORE_ACCOUNTS = new Set([
  '11111111111111111111111111111111', // System
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // SPL Token
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', // Associated Token
  'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo', // Memo
  ...RAYDIUM_PROGRAM_IDS,
  PUMPFUN_PROGRAM_ID,
]);

function nowIso() { return new Date().toISOString(); }

// dedupe: por firma y mint
const seenSigMint = new Set();           // `${signature}:${mint}`
const seenSignature = new Set();         // firma sola (para spam)
const cooldownMint = new Map();          // mint -> ts (evitar hammering de API)
const MINT_COOLDOWN_MS = 30_000;

// simple cola para no pasar de X requests simultáneas a Dexscreener
let activeRequests = 0;
const MAX_CONCURRENCY = 3;
const queue = [];
async function runQueued(task) {
  return new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    pumpQueue();
  });
}
function pumpQueue() {
  if (activeRequests >= MAX_CONCURRENCY) return;
  const next = queue.shift();
  if (!next) return;
  activeRequests++;
  next.task()
    .then(res => next.resolve(res))
    .catch(err => next.reject(err))
    .finally(() => {
      activeRequests--;
      pumpQueue();
    });
}

// ================== WS & SUBS ==================
let ws;
let nextId = 2000;
const sentIdToLabel = new Map(); // sent id -> label (Raydium/Pump.fun)
const subIdToLabel  = new Map(); // sub id -> label

function connect() {
  console.log(`🚀 Conectando WS: ${WS_URL}`);
  ws = new WebSocket(WS_URL);

  const pingIntervalMs = 25_000;
  let heartbeat;

  ws.on('open', () => {
    console.log('✅ WS abierto. Creando suscripciones por programa...');
    // Raydium
    for (const pid of RAYDIUM_PROGRAM_IDS) {
      const id = nextId++;
      sentIdToLabel.set(id, 'Raydium');
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'logsSubscribe',
        params: [{ mentions: [pid] }, { commitment: 'finalized' }]
      }));
      console.log(`📨 Enviada sub ${id} → Raydium (${pid})`);
    }
    // Pump.fun
    if (PUMPFUN_PROGRAM_ID) {
      const id = nextId++;
      sentIdToLabel.set(id, 'Pump.fun');
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'logsSubscribe',
        params: [{ mentions: [PUMPFUN_PROGRAM_ID] }, { commitment: 'finalized' }]
      }));
      console.log(`📨 Enviada sub ${id} → Pump.fun (${PUMPFUN_PROGRAM_ID})`);
    }

    heartbeat = setInterval(() => {
      try { ws.ping?.(); } catch {}
    }, pingIntervalMs);
  });

  ws.on('message', onMessage);

  ws.on('close', () => {
    console.log('⚠️ WS cerrado. Reintentando en 2s…');
    clearInterval(heartbeat);
    setTimeout(connect, 2000);
  });

  ws.on('error', (err) => {
    console.log('⚠️ WS error:', err.message);
  });
}

function onMessage(buf) {
  let msg;
  try { msg = JSON.parse(buf.toString()); } catch { return; }

  // confirmación de suscripción
  if (msg.id && msg.result && typeof msg.result === 'number') {
    const label = sentIdToLabel.get(msg.id) || 'Unknown';
    subIdToLabel.set(msg.result, label);
    console.log(`✅ Sub confirmada. sentId=${msg.id} → subId=${msg.result} [${label}]`);
    return;
  }

  // notificaciones de logs
  if (msg.method === 'logsNotification' && msg.params?.result) {
    const { subscription, value } = msg.params;
    const label = subIdToLabel.get(subscription) || 'Unknown';
    const { logs = [], signature } = value || {};

    if (!signature || seenSignature.has(signature)) return;
    seenSignature.add(signature);
    setTimeout(() => seenSignature.delete(signature), 60_000); // dedupe por 60s

    const candidates = extractCandidates(logs);
    if (DEBUG_MARKET) {
      console.log(`🧪 candidatos=${candidates.length} (${candidates.join(',')})`);
    }

    // limita cuántos probamos por tx
    const toProbe = candidates.slice(0, MAX_MARKET_PROBES);
    for (const mint of toProbe) {
      if (BLOCKLIST.has(mint)) {
        if (DEBUG_MARKET) console.log(`🚫 Blocklist: ${mint}`);
        continue;
      }
      if (ALLOWLIST.size > 0 && !ALLOWLIST.has(mint)) {
        if (DEBUG_MARKET) console.log(`⏭️ Fuera de allowlist: ${mint}`);
        continue;
      }
      const key = `${signature}:${mint}`;
      if (seenSigMint.has(key)) continue;
      seenSigMint.add(key);
      setTimeout(() => seenSigMint.delete(key), 120_000);

      // cooldown por mint (evitar hammering)
      const last = cooldownMint.get(mint) || 0;
      if (Date.now() - last < MINT_COOLDOWN_MS) continue;
      cooldownMint.set(mint, Date.now());

      simulateOnDexscreener(label, signature, mint).catch(() => {});
    }
  }
}

// ================== PARSEO CANDIDATOS ==================
function extractCandidates(logs) {
  const set = new Set();
  for (const line of logs || []) {
    const matches = line.match(BASE58_RE) || [];
    for (const a of matches) {
      if (IGNORE_ACCOUNTS.has(a)) continue;
      // Heurística: no parece clave de sistema, ni programa conocido
      if (a.length >= 32 && a.length <= 44) set.add(a);
    }
  }
  return Array.from(set);
}

// ================== SIMULACIÓN (Dexscreener) ==================
async function simulateOnDexscreener(label, signature, mint) {
  try {
    const pair = await runQueued(() => bestDexPairForMint(mint));
    if (!pair) {
      if (!ONLY_HITS && DEBUG_MARKET) {
        console.log(`❌ MISS (sin pares): src=${label} mint=${mint}`);
      }
      return;
    }

    const priceNative = Number(pair.priceNative || 0);
    const liqUsd = Number(pair.liquidity?.usd || 0);
    const volUsd = Number(pair.volume?.h24 || 0);

    if (!priceNative || liqUsd < MIN_LIQ_USD || volUsd < MIN_VOL_USD) {
      if (!ONLY_HITS && DEBUG_MARKET) {
        console.log(`❌ MISS filtros: ${mint} liqUsd=${liqUsd} volUsd=${volUsd} priceNative=${priceNative}`);
      }
      return;
    }

    // simulación super simple: buy al precio + slippage, sell al precio - (slippage+spread)
    const buyPrice  = priceNative * (1 + SLIPPAGE_BPS / 10_000);
    const sellPrice = priceNative * (1 - (SLIPPAGE_BPS + SIM_SPREAD_BPS) / 10_000);
    const pnlPerc   = ((sellPrice - buyPrice) / buyPrice) * 100;
    const pnlSol    = (pnlPerc / 100) * SIMULATED_AMOUNT_SOL;

    const row = {
      timestamp: nowIso(),
      source: `${label}/Dexscreener`,
      signature,
      mint,
      buyPrice,
      sellPrice,
      pnlPerc,
      pnlSol,
      liqUsd,
      volUsd
    };

    console.log('🎯 SIM (válido):', row);
    appendCsv(row);
  } catch (e) {
    if (!ONLY_HITS && DEBUG_MARKET) {
      console.log(`⚠️ Error Dexscreener (${mint}):`, e.message);
    }
  }
}

async function bestDexPairForMint(mint) {
  // Dexscreener: https://api.dexscreener.com/latest/dex/tokens/{mint}
  const url = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
  const { data } = await axios.get(url, { timeout: 8000 });
  const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
  if (pairs.length === 0) return null;

  // nos quedamos con el par de mayor liquidez USD
  pairs.sort((a, b) => (Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0)));
  const top = pairs[0];

  // normalizamos algunos campos que usamos después
  return {
    priceNative: Number(top.priceNative || 0), // precio en SOL si está disponible
    liquidity: { usd: Number(top.liquidity?.usd || 0) },
    volume: { h24: Number(top.volume?.h24 || 0) },
    dexId: top.dexId,
    pairAddress: top.pairAddress
  };
}

// ================== BOOT ==================
connect();
