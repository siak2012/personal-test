function ensureCsv() {
  if (!fs.existsSync(CSV_PATH)) {
    fs.writeFileSync(
      CSV_PATH,
      'timestamp,source,subscriptionId,signature,mint,buyPrice,sellPrice,pnlPerc,pnlSol,liqUsd,liqSol,volUsd\n'
    );
  }
}

// ws-listener-advanced-v2.js
// Listener WS con filtros + blocklist + trazas HIT/MISS + simulación básica

import 'dotenv/config';
import WebSocket from 'ws';
import axios from 'axios';
import fs from 'fs';

const ONLY_HITS     = process.env.ONLY_HITS === '1';
const DEBUG_MARKET  = process.env.DEBUG_MARKET === '1';

// ================== ENV & CONFIG ==================
const WS_URL = process.env.RPC_URL_WS || 'wss://api.mainnet-beta.solana.com';

const RAYDIUM_PROGRAM_IDS = (process.env.RAYDIUM_PROGRAM_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const PUMPFUN_PROGRAM_ID  = (process.env.PUMPFUN_PROGRAM_ID || '').trim() || null;

const SIMULATED_AMOUNT_SOL = Number(process.env.SIMULATED_AMOUNT_SOL || '0.001');
const SIM_SPREAD_BPS       = Number(process.env.SIM_SPREAD_BPS || '100'); // 1% RT
const SLIPPAGE_BPS         = Number(process.env.SLIPPAGE_BPS || '150');   // por si quieres usarlo
const MIN_LIQ_USD          = Number(process.env.MIN_LIQ_USD || '8000');
const MIN_VOL_USD          = Number(process.env.MIN_VOL_USD || '5000');

const MAX_MARKET_PROBES    = Number(process.env.MAX_MARKET_PROBES || '8'); // candidatos por tx

// Opcional Birdeye (si algún día pones API key)
const BIRDEYE_KEY          = (process.env.BIRDEYE_KEY || '').trim();

// CSV de resultados de simulación
const CSV_PATH = 'simulation_results.csv';
ensureCsv(); // ← deja esta llamada si ensureCsv es una function-declaration (ver abajo)

// ================== BLOCKLIST BASE ==================
const BLOCKLIST = new Set([
  // Raydium programs (a los que te suscribes; NO son mints)
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  '5quBtoiQqxF9Jv6KYKctB59NT3gtJD2Y65kdnB1Uev3h',
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',

  // Pump.fun
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',

  // Jupiter
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  'JUPXyUidBdSfAMVcG5yubXmcPXMq3bJmVovfsNmgvd6',
  'routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS',

  // Orca Whirlpool (router)
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',

  // Programas SPL / utilidades / cuentas comunes
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', // Token-2022
  'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo',  // Memo v2

  // Otras cuentas muy frecuentes en swaps y que NO son mints
  'SoLFiHG9TfgtdUXUjWAxi3LtvYuFyDLVhBWxdMZxyCe',
  // Programas base que salen en casi todas las tx (NO son mints)
'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // SPL Token
'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', // Associated Token
'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',  // Memo v1
'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo',  // Memo v2
'11111111111111111111111111111111',             // System Program
'ComputeBudget111111111111111111111111111111',  // Compute Budget

// Routers / agregadores que no son mints
'BBRouter1cVunVXvkcqeKkZQcBK7ruan37PPm3xzWaXD',
'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',

// Cuentas muy frecuentes en swaps (ruido)
'DvtCHYizicjpX3dSLkXVsS1Y5RGRHGahGirAsRjVbEVg',
'hydHwdP54fiTbJ5QXuKDLZFLY5m8pqx15RSmWcL1yAJ',
'3s1rAymURnacreXreMy718GfqW6kygQsLNka1xDyW8pC',
'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
'King7ki4SKMBPb3iupnQwTyjsq294jaXsgLmJo8cb7T',
'ZERor4xhbUycZ6gb9ntrhqscUcZmAbQDjEAtCf4hbZY',
'3JuLK88xU3gbiHvwd12mGdYC6iVNSfZkFtsyiY2yeZrZ',
'bank7GaK8LkjyrLpSZjGuXL8z7yae6JqbunEEnU9FS4',

// Otras que viste repetirse (no mints)
'NA247a7YE9S3p9CdKmMyETx8TTwbSdVbVYHHxpnHTUV',
'Fibo6vWHQLVqh6ci5BbdPrNR29q2qesJqiSEbR99y8L9',
'FoaFt2Dtz58RA6DPjbRb9t9z8sLJRChiGFTv21EfaseZ',
'4x2e73ZsMJbfk1nzwkJnkAAWDxCgxnQrYEmWXyd5nyvG',
'4zMQA8EqDLc1nkTBgpZErnCy49cQGFvEVmwcsxmVZLUE',
'MEViEnscUm6tsQRoGd9h6nLQaQspKj7DB2M5FwM3Xvz',

]);

// Añadir dinámicamente programas que vienen del .env
RAYDIUM_PROGRAM_IDS.forEach(k => BLOCKLIST.add(k));
if (PUMPFUN_PROGRAM_ID) BLOCKLIST.add(PUMPFUN_PROGRAM_ID);

// ================== UTILS ==================
const uniq = (arr) => [...new Set(arr)];

function ensureCsv() {
  if (!fs.existsSync(CSV_PATH)) {
    fs.writeFileSync(
      CSV_PATH,
      'timestamp,source,signature,mint,buyPrice,sellPrice,pnlPerc,pnlSol,liqUsd,liqSol,volUsd\n',
      'utf8'
    );
  }
}

function appendCsv(rowObj) {
  const row = [
    rowObj.timestamp,
    rowObj.source,
    rowObj.signature,
    rowObj.mint,
    safeNum(rowObj.buyPrice),
    safeNum(rowObj.sellPrice),
    safeNum(rowObj.pnlPerc),
    safeNum(rowObj.pnlSol),
    safeNum(rowObj.liqUsd),
    safeNum(rowObj.liqSol),
    safeNum(rowObj.volUsd),
  ].join(',') + '\n';
  fs.appendFileSync(CSV_PATH, row, 'utf8');
}

function safeNum(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '';
  return Number(n);
}

function isNoiseString(s) {
  // 8 caracteres idénticos consecutivos => casi seguro basura (AAAAAAA…)
  return /(.)\1{7,}/.test(s);
}

function extractBase58Candidates(logs) {
  const text = (logs || []).join(' ');
  // Base58 sin 0,O,I,l y a partir de 32 chars (hasta ~44)
  const re = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
  const raw = text.match(re) || [];
  return uniq(
    raw
      .filter(s => s.length >= 36)     // heurística mínima de longitud
      .filter(s => !isNoiseString(s))  // fuera AAAAAA…
      .filter(s => !BLOCKLIST.has(s))  // fuera blocklist
  );
}

function simulateRoundTrip(price) {
  // spread simétrico: +spread/2 al comprar, -spread/2 al vender → RT = spread
  const half = SIM_SPREAD_BPS / 20000; // ej: 100 bps → 0.5% cada lado
  const buy  = price * (1 + half);
  const sell = price * (1 - half);
  const pnlPerc = ((sell - buy) / buy) * 100; // en %
  const pnlSol  = SIMULATED_AMOUNT_SOL * (pnlPerc / 100);
  return { buy, sell, pnlPerc, pnlSol };
}

// ================== MARKET LOOKUPS ==================
async function getTokenData(mint) {
  // 1) Dexscreener (público)
  const d = await fetchDexscreener(mint);
  if (d) return d;

  // 2) Birdeye (si tienes API Key)
  const b = await fetchBirdeye(mint);
  if (b) return b;

  return null;
}

async function fetchDexscreener(mint) {
  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
    const { data } = await axios.get(url, { timeout: 7000 });

    if (!data || !Array.isArray(data.pairs) || data.pairs.length === 0) {
      return null;
    }

    // Elegimos el par con mayor liquidez USD
    const best = data.pairs
      .filter(p => Number(p.liquidity?.usd) > 0 && Number(p.priceUsd) > 0)
      .sort((a, b) => Number(b.liquidity.usd) - Number(a.liquidity.usd))[0];

    if (!best) return null;

    return {
      source: 'Dexscreener',
      price: Number(best.priceUsd),                   // USD
      liqUsd: Number(best.liquidity?.usd || 0),
      liqSol: Number(best.liquidity?.base || 0),      // no siempre es SOL, pero orienta
      volUsd: Number(best.volume?.h24 || 0),          // 24h
    };
  } catch {
    return null;
  }
}

async function fetchBirdeye(mint) {
  if (!BIRDEYE_KEY) return null;
  try {
    // Precio (USD)
    const p = await axios.get(
      `https://public-api.birdeye.so/defi/price?chain=solana&address=${mint}`,
      { headers: { 'X-API-KEY': BIRDEYE_KEY }, timeout: 6000 }
    );
    const price = Number(p?.data?.data?.value || 0);
    if (!price) return null;

    // Liquidez/volumen aproximados (si quieres puedes ampliar con endpoints de pools)
    // Aquí lo dejamos mínimo con precio; si quieres reforzar, añadimos más endpoints.
    return {
      source: 'Birdeye',
      price,
      liqUsd: 0,
      liqSol: 0,
      volUsd: 0,
    };
  } catch {
    return null;
  }
}

// ================== WS ==================
const ws = new WebSocket(WS_URL);

const pendingSubs = new Map();  // sentId -> label
const subLabels   = new Map();  // subId  -> label

let nextId = 2000;

ws.on('open', () => {
  console.log(`🚀 Conectando WS: ${WS_URL}`);
  console.log('✅ WS abierto. Creando suscripciones por programa...');

  // Raydium
  for (const pid of RAYDIUM_PROGRAM_IDS) {
    const id = nextId++;
    pendingSubs.set(id, 'Raydium');
    sendLogsSubByProgram(id, pid);
  }

  // Pump.fun
  if (PUMPFUN_PROGRAM_ID) {
    const id = nextId++;
    pendingSubs.set(id, 'Pump.fun');
    sendLogsSubByProgram(id, PUMPFUN_PROGRAM_ID);
  }

  // (Opcional) Suscripción ALL si quieres telemetría general
  // const idAll = nextId++;
  // pendingSubs.set(idAll, 'ALL');
  // sendLogsSubAll(idAll);
});

ws.on('message', async (raw) => {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }

  // Confirmación de suscripciones
  if (msg.id && pendingSubs.has(msg.id) && msg.result) {
    const label = pendingSubs.get(msg.id);
    pendingSubs.delete(msg.id);
    const subId = msg.result;
    subLabels.set(subId, label);
    console.log(`✅ Sub confirmada. sentId=${msg.id} → subId=${subId} [${label}]`);
    return;
  }

  // Notificaciones de logs
  if (msg.method === 'logsNotification') {
    const { result } = msg.params || {};
    const { value }  = result || {};
    const subId      = result?.subscription;
    const label      = subLabels.get(subId) || 'Unknown';

    const signature  = value?.signature?.slice(0, 12) + '…';
    const logs       = value?.logs || [];

    // Extraer candidatos (posibles mints)
    const candidates = extractBase58Candidates(logs);
    if (candidates.length === 0) return;

    if (!ONLY_HITS && label !== 'Unknown') {
        console.log(`🧪 candidatos=${candidates.length} (${candidates.join(',')})`);
        console.log(`🔎 ${label} tx=${signature} logs=${logs.length}`);
}

    // Consultar mercado para cada candidato (hasta MAX_MARKET_PROBES)
    let chosenMint = null;
    let market     = null;

    for (const c of candidates.slice(0, MAX_MARKET_PROBES)) {
      const m = await getTokenData(c);

      if (DEBUG_MARKET) {
        console.log(m
          ? `🟢 market HIT: ${c} → $${m.price} liqUsd=${m.liqUsd}`
          : `⚪ market MISS: ${c}`
        );
      }

      if (m && m.price > 0) {
        // Aplica filtros mínimos
        const liqOk = m.liqUsd === 0 ? true : (m.liqUsd >= MIN_LIQ_USD);
        const volOk = m.volUsd === 0 ? true : (m.volUsd >= MIN_VOL_USD);
        if (!liqOk || !volOk) {
          if (DEBUG_MARKET) {
            console.log(`⏭️ market HIT pero bajo filtros → liqUsd=${m.liqUsd} volUsd=${m.volUsd}`);
          }
          continue;
        }

        chosenMint = c;
        market     = m;
        break;
      }
    }

    if (!chosenMint || !market) return;

    // Simulación redonda con spread
    const { buy, sell, pnlPerc, pnlSol } = simulateRoundTrip(market.price);

    const out = {
      timestamp: new Date().toISOString(),
      source: `${label}/${market.source}`,
      signature: value?.signature || '',
      mint: chosenMint,
      buyPrice: buy,
      sellPrice: sell,
      pnlPerc,
      pnlSol,
      liqUsd: market.liqUsd,
      liqSol: market.liqSol,
      volUsd: market.volUsd,
    };

    console.log('🎯 SIM (válido):', out);
    appendCsv(out);
  }
});

ws.on('error', (err) => {
  console.error('❌ WS error:', err.message || err);
});

ws.on('close', (code, reason) => {
  console.log(`⚠️ WS cerrado: ${code} ${reason ? reason.toString() : ''}`);
  // Reintento sencillo
  setTimeout(() => {
    console.log('🚀 Conectando WS:', WS_URL);
    reconnect();
  }, 1500);
});

function reconnect() {
  // Nota: script sencillo; para producción, abstrae el socket y re-crea listeners.
  process.exit(0); // que tu PM2 / npm script lo relance, o vuelve a ejecutar manualmente
}

function sendLogsSubByProgram(id, programId) {
  const payload = {
    jsonrpc: '2.0',
    id,
    method: 'logsSubscribe',
    params: [
      { mentions: [programId] },
      { commitment: 'processed' }
    ]
  };
  ws.send(JSON.stringify(payload));
  console.log(`📨 Enviada sub ${id} → ${programId.includes('6EF8r') ? 'Pump.fun' : 'Raydium'} (${programId})`);
}

function sendLogsSubAll(id) {
  const payload = {
    jsonrpc: '2.0',
    id,
    method: 'logsSubscribe',
    params: [
      { filter: 'all' },
      { commitment: 'processed' }
    ]
  };
  ws.send(JSON.stringify(payload));
  console.log(`📨 Enviada sub ${id} → ALL`);
}
