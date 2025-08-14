import 'dotenv/config';
import WebSocket from 'ws';
import axios from 'axios';
import path from 'path';
import https from 'https';
import { createObjectCsvWriter } from 'csv-writer';

// ===================== ENV / CONFIG =====================
const WS_URL = process.env.RPC_URL_WS;
const BIRDEYE_KEY = (process.env.BIRDEYE_KEY || '').trim();

const RAYDIUM_PROGRAM_IDS = (process.env.RAYDIUM_PROGRAM_IDS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const PUMPFUN_PROGRAM_ID = (process.env.PUMPFUN_PROGRAM_ID || '').trim();

const MIN_LIQ_SOL = parseFloat(process.env.MIN_LIQ_SOL) || 5;
const MIN_VOL_USD = parseFloat(process.env.MIN_VOL_USD) || 5000;
const SIMULATED_AMOUNT_SOL = parseFloat(process.env.SIMULATED_AMOUNT_SOL) || 0.001;

// Sim engine
const SIM_ENGINE = (process.env.SIM_ENGINE || 'spread').toLowerCase(); // 'spread' | 'jupiter'
const SIM_WAIT_MS = parseInt(process.env.SIM_WAIT_MS || '0', 10);
const JUPITER_BASE = process.env.JUPITER_BASE || 'https://quote-api.jup.ag';
const SLIPPAGE_BPS = parseInt(process.env.SLIPPAGE_BPS || '150', 10);

// Limitar trabajo por transacción (para no saturar APIs)
const MAX_CANDIDATES_PER_TX = 5;
// Limitar concurrencia global de llamadas HTTP (anti ENOBUFS)
const MAX_CONCURRENT_HTTP = parseInt(process.env.MAX_CONCURRENT_HTTP || '2', 10);

// ===================== HTTP AGENT (keep-alive) =====================
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: Math.max(4, MAX_CONCURRENT_HTTP),
  maxFreeSockets: Math.max(2, Math.floor(MAX_CONCURRENT_HTTP / 2)),
  timeout: 15_000
});
const ax = axios.create({ httpsAgent, timeout: 10_000 });

// ===================== CSV =====================
const csvWriter = createObjectCsvWriter({
  path: path.join(process.cwd(), 'simulation_results.csv'),
  header: [
    { id: 'timestamp', title: 'Timestamp' },
    { id: 'source', title: 'Source' },
    { id: 'subscriptionId', title: 'SubId' },
    { id: 'signature', title: 'Signature' },
    { id: 'mint', title: 'Token Mint' },
    { id: 'buyPrice', title: 'Buy Price (USD)' },
    { id: 'sellPrice', title: 'Sell Price (USD)' },
    { id: 'pnlPerc', title: 'PnL %' },
    { id: 'pnlSol', title: 'PnL SOL' },
    { id: 'liqUsd', title: 'Liquidity USD' },
    { id: 'liqSol', title: 'Liquidity SOL' },
    { id: 'volUsd', title: 'Volume 24h USD' },
  ],
  append: true
});

// ===================== BLOQUEOS / HEURÍSTICAS =====================
// Programas/sysvars muy frecuentes en logs que NO son mints
const BLOCKLIST = new Set([
  // System / runtime
  '11111111111111111111111111111111', // System Program
  'ComputeBudget111111111111111111111111111111',
  'BPFLoaderUpgradeab1e11111111111111111111111',
  'AddressLookupTab1e111111111111111111111111',
  'SysvarC1ock11111111111111111111111111111111',
  'SysvarRent111111111111111111111111111111111',
  'Sysvar1nstructions1111111111111111111111',

  // SPL Token stack
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // SPL Token
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', // Associated Token
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', // Memo
  'KeccakSecp256k11111111111111111111111111111',
  'Stake11111111111111111111111111111111111111',
  'Vote111111111111111111111111111111111111111',

  // IMPORTANTE: ignora WSOL como mint objetivo
  'So11111111111111111111111111111111111111112',
]);

function isProbablyMint(pubkey) {
  // Heurística suave para reducir ruido:
  // - Longitud mínima 36 (evita muchas cuentas core de 32)
  // - No estar en la blocklist
  return pubkey.length >= 36 && !BLOCKLIST.has(pubkey);
}

function uniq(arr) { return [...new Set(arr)]; }

function extractBase58Candidates(logs) {
  const text = logs.join(' ');
  const re = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
  const raw = text.match(re) || [];
  return uniq(raw.filter(isProbablyMint));
}

// ===================== CONCURRENCIA HTTP =====================
let inflight = 0;
const waiters = [];
async function runWithLimit(taskFn) {
  if (inflight >= MAX_CONCURRENT_HTTP) {
    await new Promise(res => waiters.push(res));
  }
  inflight++;
  try {
    return await taskFn();
  } finally {
    inflight--;
    const next = waiters.shift();
    if (next) next();
  }
}

// ===================== MERCADO =====================
const WSOL = 'So11111111111111111111111111111111111111112';

async function getTokenData(mint) {
  try {
    if (BIRDEYE_KEY) {
      const rsp = await runWithLimit(() =>
        ax.get(`https://public-api.birdeye.so/public/token/${mint}`, {
          headers: { 'x-chain': 'solana', 'X-API-KEY': BIRDEYE_KEY }
        })
      );
      const d = rsp?.data?.data;
      if (!d) return null;
      return {
        price: d.price || 0,
        liqUsd: d.liquidity || 0,
        // Birdeye no da "liq en SOL" como tal; lo dejamos en 0
        liqSol: 0,
        volUsd: d.volume_24h || 0,
        source: 'Birdeye'
      };
    } else {
      const rsp = await runWithLimit(() =>
        ax.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`)
      );
      const pair = rsp?.data?.pairs?.[0];
      if (!pair) return null;

      // Mapeo correcto de SOL: solo si quote es SOL/WSOL
      const quoteIsSOL =
        (pair.quoteToken?.symbol === 'SOL') ||
        (pair.quoteToken?.address === WSOL);

      const liqSol = quoteIsSOL
        ? parseFloat(pair.liquidity?.quote) || 0
        : 0;

      return {
        price: parseFloat(pair.priceUsd) || 0,
        liqUsd: parseFloat(pair.liquidity?.usd) || 0,
        liqSol,
        volUsd: parseFloat(pair.volume?.h24) || 0,
        source: 'Dexscreener'
      };
    }
  } catch {
    return null; // silencioso: seguimos con otro candidato
  }
}

function simulateTradeSpread(priceUsd) {
  if (!priceUsd || priceUsd <= 0) {
    return { buyPrice: 0, sellPrice: 0, pnlPerc: 0, pnlSol: 0 };
  }
  const buyPrice = priceUsd * (1 + 0.005);   // +0.5% slippage
  const sellPrice = priceUsd * (1 - 0.005);  // -0.5% spread
  const pnlPerc = ((sellPrice - buyPrice) / buyPrice) * 100;
  const pnlSol = ((sellPrice - buyPrice) / priceUsd) * SIMULATED_AMOUNT_SOL;
  return { buyPrice, sellPrice, pnlPerc, pnlSol };
}

// ---------- Jupiter helpers ----------
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

// quote Jupiter v6. amount en átomos del inputMint (lamports si input=WSOL)
async function jupQuote(inputMint, outputMint, amountAtoms) {
  const url = `${JUPITER_BASE}/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountAtoms}&slippageBps=${SLIPPAGE_BPS}&onlyDirectRoutes=false`;
  const rsp = await runWithLimit(() => ax.get(url));
  // v6 puede devolver array en data.data; tomamos el primero si es array
  const d = rsp?.data?.data;
  const q = Array.isArray(d) ? d[0] : d;
  if (!q?.outAmount) return null;
  return {
    outAmount: BigInt(q.outAmount),           // salida en átomos del outputMint
    priceImpactPct: Number(q.priceImpactPct ?? 0)
  };
}

// Round-trip SOL->mint->SOL con espera opcional entre quotes
async function simulateRoundTripJupiter(mint) {
  try {
    const lamportsIn = BigInt(Math.round(SIMULATED_AMOUNT_SOL * 1e9));

    // 1) SOL -> mint
    const q1 = await jupQuote(WSOL, mint, lamportsIn);
    if (!q1) return null;

    // Espera opcional para capturar movimiento
    if (SIM_WAIT_MS > 0) await sleep(SIM_WAIT_MS);

    // 2) mint -> SOL (usamos todo lo que "compramos" en q1)
    const q2 = await jupQuote(mint, WSOL, q1.outAmount);
    if (!q2) return null;

    const lamportsOut = q2.outAmount;
    const pnlLamports = Number(lamportsOut - lamportsIn); // puede ser negativo/positivo
    const pnlSol = pnlLamports / 1e9;
    const pnlPerc = (pnlSol / SIMULATED_AMOUNT_SOL) * 100;

    return { pnlSol, pnlPerc };
  } catch {
    return null;
  }
}
// ------------------------------------

// ===================== WS LISTENER =====================
let ws;
const subIdToSource = new Map();    // subId (del nodo) -> etiqueta
const pendingIdToLabel = new Map(); // id que enviamos -> etiqueta
const seenSignatures = new Set();   // de-dup para no repetir mismo tx

const wantedPrograms = [
  ...RAYDIUM_PROGRAM_IDS.map(x => ({ pubkey: x, label: 'Raydium' })),
  ...(PUMPFUN_PROGRAM_ID ? [{ pubkey: PUMPFUN_PROGRAM_ID, label: 'Pump.fun' }] : [])
];

function connect() {
  console.log(`🚀 Conectando WS: ${WS_URL}`);
  ws = new WebSocket(WS_URL);

  ws.on('open', async () => {
    console.log('✅ WS abierto. Creando suscripciones por programa...');
    // Mantener vivo
    setInterval(() => { if (ws?.readyState === WebSocket.OPEN) ws.ping(); }, 15000);

    // Suscribir por programa con "mentions" (sin ALL para reducir ruido)
    let nextId = 2000;
    for (const { pubkey, label } of wantedPrograms) {
      const id = nextId++;
      pendingIdToLabel.set(id, label);
      const payload = {
        jsonrpc: '2.0',
        id,
        method: 'logsSubscribe',
        params: [ { mentions: [pubkey] }, { commitment: 'processed' } ]
      };
      ws.send(JSON.stringify(payload));
      console.log(`📨 Enviada sub ${id} → ${label} (${pubkey})`);
    }
  });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // Confirmaciones de suscripción
    if (msg.id && Number.isInteger(msg.result)) {
      const sentId = msg.id;
      const label = pendingIdToLabel.get(sentId) || 'Unknown';
      subIdToSource.set(msg.result, label);
      pendingIdToLabel.delete(sentId);
      console.log(`✅ Sub confirmada. sentId=${sentId} → subId=${msg.result} [${label}]`);
      return;
    }

    // Errores del nodo
    if (msg.error) {
      console.log('❌ Error WS:', msg.error);
      return;
    }

    // Notificaciones de logs
    if (msg.method === 'logsNotification') {
      const sub = msg.params?.subscription;
      const val = msg.params?.result?.value;
      if (!val) return;

      const sourceLabel = subIdToSource.get(sub) || 'Unknown';
      const { signature, logs } = val;

      // de-dup: misma tx puede salir por varias subs
      if (seenSignatures.has(signature)) return;
      seenSignatures.add(signature);
      if (seenSignatures.size > 50000) seenSignatures.clear();

      // Candidatos de mint “depurados”
      const candidates = extractBase58Candidates(logs).slice(0, MAX_CANDIDATES_PER_TX);
      if (!candidates.length) return;

      // Mercado: probar candidatos hasta encontrar uno válido
      let chosenMint = null, market = null;
      for (const c of candidates) {
        const m = await getTokenData(c);
        if (m && m.price > 0) { chosenMint = c; market = m; break; }
      }
      if (!chosenMint || !market) return;

      const { price, liqUsd, liqSol, volUsd, source: marketSrc } = market;

      // --- Simulación ---
      let buyPrice, sellPrice, pnlPerc, pnlSol;

      if (SIM_ENGINE === 'jupiter') {
        const rt = await simulateRoundTripJupiter(chosenMint);
        if (!rt) return; // si Jupiter falla esta vez, pasamos
        ({ pnlSol, pnlPerc } = rt);

        // buy/sell "informativos" (precio spot); si hay espera, refrescamos venta
        buyPrice = price;
        let priceAfter = price;
        if (SIM_WAIT_MS > 0) {
          const m2 = await getTokenData(chosenMint);
          if (m2?.price) priceAfter = m2.price;
        }
        sellPrice = priceAfter;
      } else {
        ({ buyPrice, sellPrice, pnlPerc, pnlSol } = simulateTradeSpread(price));
      }

      const row = {
        timestamp: new Date().toISOString(),
        source: `${sourceLabel}/${marketSrc}`,
        subscriptionId: sub,
        signature,
        mint: chosenMint,
        buyPrice,
        sellPrice,
        pnlPerc,
        pnlSol,
        liqUsd,
        liqSol,
        volUsd
      };

      console.log('🎯 SIM (válido):', row);

      // (Opcional) Filtro real antes de guardar
      // if (liqSol < MIN_LIQ_SOL || volUsd < MIN_VOL_USD) return;

      await csvWriter.writeRecords([row]);
      return;
    }
  });

  ws.on('error', (e) => {
    console.log('❌ WS error:', e?.message || e);
  });

  ws.on('close', (code, reason) => {
    console.log('⚠️ WS cerrado:', code, reason?.toString());
    setTimeout(connect, 3000); // reconexión con backoff simple
  });
}

connect();
