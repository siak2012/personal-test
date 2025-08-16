// index.cjs — Simulación + listener real con rate-limit, dedupe, LOG_LEVEL
// Integra filtros avanzados (ventana temprana + histograma de razones)
// ----------------------------------------------------------------------------------
// Requisitos: npm i dotenv axios ws @solana/web3.js @solana/spl-token bs58
// (El módulo de filtros usa fetch de Node 18+. Si usas Node <18, instala node-fetch.)

const path = require('path');
const dotenv = require('dotenv');
const res = dotenv.config({ path: path.join(__dirname, '.env') });
if (res.error) {
  console.log('[BOOT] dotenv ERROR:', res.error.message);
} else {
  console.log('[BOOT] dotenv OK. DEBUG_MARKET in .env =', res.parsed?.DEBUG_MARKET);
}
console.log('[BOOT] process.env.DEBUG_MARKET =', process.env.DEBUG_MARKET);

// ---------- Utils ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();
const asBool = (v, def = false) => {
  if (v === undefined || v === null) return def;
  return ['1', 'true', 'yes', 'on'].includes(String(v).trim().toLowerCase());
};
const env = (k, def) => (process.env[k] ?? def);

// --------- Config (.env) ---------
const ONLY_HITS              = asBool(env('ONLY_HITS', '0'), false);
const DEBUG_MARKET           = asBool(env('DEBUG_MARKET', '0'), false);
const MIN_LIQ_USD            = Number(env('MIN_LIQ_USD', '1000'));
const MIN_VOL_USD            = Number(env('MIN_VOL_USD', '1000'));   // 24h fallback
const MIN_VOL_USD_5M         = Number(env('MIN_VOL_USD_5M', '100')); // 5m preferente
const BUY_USD                = Number(env('BUY_USD', '100'));
const TP_PCT                 = Number(env('TP_PCT', '25'));
const SL_PCT                 = Number(env('SL_PCT', '20'));
const WATCH_SEC              = Number(env('WATCH_SEC', '15'));
const LOG_PREFIX             = env('LOG_PREFIX', 'SNIPER');
const LOG_LEVEL              = (env('LOG_LEVEL', 'info') || 'info').toLowerCase(); // debug|info|warn|error|silent
const MAX_HITS_PER_SEC       = Number(env('MAX_HITS_PER_SEC', '2'));
const DEDUP_TTL_MS           = Number(env('DEDUP_TTL_MS', '60000'));
const PRICE_TICK_MS          = Number(env('PRICE_TICK_MS', '2000'));
const FAST_PATH_NO_ONCHAIN   = asBool(env('FAST_PATH_NO_ONCHAIN_CHECK', '0'), false);

// Ventana temprana (usadas en filtros; aquí solo para imprimir parámetros):
const EARLY_AGE_SEC          = Number(env('EARLY_AGE_SEC', '180'));
const EARLY_MIN_LIQ_USD      = Number(env('EARLY_MIN_LIQ_USD', '300'));
const EARLY_REQUIRE_VOL      = asBool(env('EARLY_REQUIRE_VOL', '0'), false);
const EARLY_FAST_PASS        = asBool(env('EARLY_FAST_PASS', '0'), false);

// Listas opcionales (archivos locales; opcionalmente puedes usar variables ALLOWLIST_MINTS/BLOCKLIST_MINTS en .env)
let allowlist = new Set();
let blocklist = new Set();
try { allowlist = new Set(require('./allowlist.json')); } catch {}
try { blocklist = new Set(require('./blocklist.json')); } catch {}

// ------- Logger con niveles -------
const LEVEL_ORDER = { debug:10, info:20, warn:30, error:40, silent:99 };
const canLog = (lvl) => LEVEL_ORDER[lvl] >= LEVEL_ORDER[LOG_LEVEL];
const log = {
  debug: (...a) => { if (canLog('debug') && !ONLY_HITS) console.log(`[${LOG_PREFIX}] [${now()}] [DEBUG]`, ...a); },
  info:  (...a) => { if (canLog('info'))  console.log(`[${LOG_PREFIX}] [${now()}]`, ...a); },
  warn:  (...a) => { if (canLog('warn'))  console.warn(`[${LOG_PREFIX}] [${now()}] [WARN]`, ...a); },
  error: (...a) => { if (canLog('error')) console.error(`[${LOG_PREFIX}] [${now()}] [ERR]`, ...a); },
  hit:   (...a) => console.log(`[${LOG_PREFIX}] [${now()}] [HIT] ✅`, ...a),
  miss:  (...a) => { if (!ONLY_HITS && canLog('info')) console.log(`[${LOG_PREFIX}] [${now()}] [MISS] ❌`, ...a); },
  sim:   (...a) => console.log(`[${LOG_PREFIX}] [${now()}] [SIM] 🧪`, ...a),
};

// --- Stats ---
let _stats = { seen: 0, hits: 0, last5s: Date.now(), minute: Date.now(), dropped: 0 };
function _tickStats({ hit = false } = {}) {
  _stats.seen += 1;
  if (hit) _stats.hits += 1;
  if (Date.now() - _stats.last5s >= 5000) {
    log.info(`[STATS] candidatos=${_stats.seen} | hits=${_stats.hits} | descartes=${_stats.dropped} | hitRate=${(_stats.hits / Math.max(1,_stats.seen) * 100).toFixed(1)}%`);
    _stats.last5s = Date.now();
  }
  if (Date.now() - _stats.minute >= 60000) {
    console.log(`[${LOG_PREFIX}] [${now()}] [RESUMEN] último minuto → hits=${_stats.hits}, descartes=${_stats.dropped}, vistos=${_stats.seen}`);
    _stats.seen = 0; _stats.hits = 0; _stats.dropped = 0;
    _stats.minute = Date.now();
  }
}

// ---------- Módulos externos ----------
function tryRequire(p) { try { return require(p); } catch { return null; } }
const listener = tryRequire('./listener') || tryRequire('./src/listener') || tryRequire('./listener.cjs');

// NUEVO: filtros avanzados (src/filters.cjs)
const filtersMod =
  tryRequire('./src/filters.cjs') ||
  tryRequire('./filters.cjs');

const hasFilters = !!(filtersMod && typeof filtersMod.createFilter === 'function');
console.log('[BOOT] listener detectado =', !!listener);
console.log('[BOOT] filters detectado =', !!hasFilters);

// Instancia del filtro
let filterApi = null;
if (hasFilters) {
  filterApi = filtersMod.createFilter({ logger: log });
  // Histograma de razones cada 15s
  setInterval(() => {
    if (typeof filtersMod.getReasonStats === 'function') {
      const reasons = filtersMod.getReasonStats();
      const top = Object.entries(reasons).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([k,v])=>`${k}:${v}`).join(' | ');
      if (top) console.log(`[${LOG_PREFIX}] [${now()}] [STATS-REASONS] ${top}`);
    }
  }, 15000);
}

// ---------- Rate limiter & Deduper ----------
class RateLimiter {
  constructor(ratePerSec = 2, burst = 2) {
    this.ratePerSec = ratePerSec;
    this.burst = burst;
    this.tokens = burst;
    this.last = Date.now();
  }
  allow() {
    const nowTs = Date.now();
    const elapsed = (nowTs - this.last) / 1000;
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.ratePerSec);
    this.last = nowTs;
    if (this.tokens >= 1) { this.tokens -= 1; return true; }
    return false;
  }
}
class Deduper {
  constructor(ttlMs = 60000) { this.ttl = ttlMs; this.map = new Map(); }
  has(key) {
    const t = this.map.get(key);
    if (!t) return false;
    if (Date.now() - t > this.ttl) { this.map.delete(key); return false; }
    return true;
  }
  add(key) { this.map.set(key, Date.now()); }
  sweep() {
    const nowTs = Date.now();
    for (const [k, t] of this.map.entries()) if (nowTs - t > this.ttl) this.map.delete(k);
  }
}
const rl = new RateLimiter(MAX_HITS_PER_SEC, MAX_HITS_PER_SEC);
const dedup = new Deduper(DEDUP_TTL_MS);
setInterval(() => dedup.sweep(), Math.max(DEDUP_TTL_MS, 5_000));

// ---------- Generador de candidatos SIM ----------
function randomTokenMint() {
  const chars = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let s = '';
  for (let i = 0; i < 44; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
function makeCandidateSim() {
  const mint = randomTokenMint();
  const liq  = Math.floor(500 + Math.random() * 5000);   // USD
  const vol5 = Math.floor(50 + Math.random() * 2000);    // USD 5m
  const vol24= vol5 * (50 + Math.random() * 100);        // USD 24h aprox
  const price= +(0.0001 + Math.random() * 0.05).toFixed(6);
  return {
    mint,
    symbol: `SIM${mint.slice(0,4)}`,
    liquidityUsd: liq,
    volume5mUsd: vol5,
    volume24hUsd: vol24,
    price,
    ts: Date.now()
  };
}

// ---------- Filtro “legacy” por si no existe src/filters.cjs ----------
function defaultApplyFilters(cand) {
  if (allowlist.size && !allowlist.has(cand.mint) && !allowlist.has(cand.symbol)) {
    return { pass:false, reason:'not-in-allowlist' };
  }
  if (blocklist.size && (blocklist.has(cand.mint) || blocklist.has(cand.symbol))) {
    return { pass:false, reason:'in-blocklist' };
  }
  const liq   = Number(cand.liquidityUsd ?? NaN);
  const vol5  = Number(cand.volume5mUsd ?? cand.volumeUsd5m ?? NaN);
  const vol24 = Number(cand.volume24hUsd ?? NaN);
  const haveLiq  = Number.isFinite(liq)  && liq  > 0;
  const haveVol5 = Number.isFinite(vol5) && vol5 > 0;
  const haveVol24= Number.isFinite(vol24)&& vol24> 0;
  if (!FAST_PATH_NO_ONCHAIN) {
    if (!haveLiq || (!haveVol5 && !haveVol24)) return { pass:false, reason:'metrics-missing' };
  }
  if (haveLiq && liq < MIN_LIQ_USD) return { pass:false, reason:`liq<${MIN_LIQ_USD}` };
  if (haveVol5 && MIN_VOL_USD_5M > 0 && vol5 < MIN_VOL_USD_5M) return { pass:false, reason:`vol5m<${MIN_VOL_USD_5M}` };
  if (!haveVol5 && haveVol24 && MIN_VOL_USD > 0 && vol24 < MIN_VOL_USD) return { pass:false, reason:`vol24h<${MIN_VOL_USD}` };
  return { pass:true };
}

// ---------- Simulación de trade ----------
async function simulateTradeFlow(cand) {
  const buyPrice = cand.price || 0.01;
  const qty = +(BUY_USD / buyPrice).toFixed(6);
  log.sim(`Compra simulada ${BUY_USD} USD en ${cand.symbol} (${cand.mint || cand.signature || 'NA'}) @ ${buyPrice} → qty=${qty}`);

  const targetUp   = buyPrice * (1 + TP_PCT/100);
  const targetDown = buyPrice * (1 - SL_PCT/100);
  const start = Date.now();

  while ((Date.now()-start)/1000 < WATCH_SEC) {
    await sleep(PRICE_TICK_MS + Math.random()*Math.min(1500, PRICE_TICK_MS));
    const drift = (Math.random()-0.5) * 0.06; // ±6%
    const px = +(buyPrice * (1 + drift)).toFixed(6);
    if (px >= targetUp) {
      const pnl = +((px - buyPrice) * qty).toFixed(4);
      const pct = +(((px/buyPrice)-1)*100).toFixed(2);
      log.sim(`Venta TP alcanzada @ ${px} | PnL=${pnl} USD (${pct}%)`);
      return;
    }
    if (px <= targetDown) {
      const pnl = +((px - buyPrice) * qty).toFixed(4);
      const pct = +(((px/buyPrice)-1)*100).toFixed(2);
      log.sim(`Venta SL alcanzada @ ${px} | PnL=${pnl} USD (${pct}%)`);
      return;
    }
    log.debug(`Precio simulado=${px} (TP ${targetUp.toFixed(6)} / SL ${targetDown.toFixed(6)})`);
  }
  const lastPx = +(buyPrice * (0.98 + Math.random()*0.06)).toFixed(6);
  const pnl = +((lastPx - buyPrice) * qty).toFixed(4);
  const pct = +(((lastPx/buyPrice)-1)*100).toFixed(2);
  log.sim(`Cierre por tiempo @ ${lastPx} | PnL=${pnl} USD (${pct}%)`);
}

// ---------- Gating (rate-limit + dedupe) ----------
async function gatedProcessCandidate(cand) {
  const key =
    cand.signature ? `sig:${cand.signature}` :
    cand.mint      ? `mint:${cand.mint}` :
                     `sym:${cand.symbol}|${Math.floor((cand.ts || Date.now())/5000)}`;

  if (dedup.has(key)) { _stats.dropped++; return; }
  dedup.add(key);
  if (!rl.allow()) { _stats.dropped++; return; }
  await processCandidate(cand);
}

// ---------- Pipeline principal ----------
async function applyFiltersAdvanced(cand) {
  if (!filterApi) return defaultApplyFilters(cand);

  // Mapea campos del listener → API de filtros
  const candForFilter = {
    mint: cand.mint,
    createdAtMs: cand.ts || cand.createdAtMs || Date.now(),
    metrics: {
      liq_usd: cand.liquidityUsd,
      vol_usd_5m: cand.volume5mUsd ?? cand.volumeUsd5m,
      vol_usd_24h: cand.volume24hUsd,
      buyTax: cand.buyTax,
      sellTax: cand.sellTax,
    },
    tokenInfo: {
      freezeAuthority: cand.freezeAuthority,
      mintAuthority: cand.mintAuthority,
    },
  };
  const res = await filterApi.filterCandidate(candForFilter);
  if (res && res.pass) return { pass:true };
  return { pass:false, reason: res?.reason || 'fail' };
}

async function processCandidate(cand) {
  _tickStats({ hit: false });

  // allow/block locales (archivos)
  if (allowlist.size && !allowlist.has(cand.mint) && !allowlist.has(cand.symbol)) {
    log.miss(`No pasa filtros: ${cand.symbol} -> not-in-allowlist`);
    return;
  }
  if (blocklist.size && (blocklist.has(cand.mint) || blocklist.has(cand.symbol))) {
    log.miss(`No pasa filtros: ${cand.symbol} -> in-blocklist`);
    return;
  }

  if (DEBUG_MARKET) {
    log.debug(`Candidato: ${cand.symbol} | liq=${cand.liquidityUsd ?? '-'} | vol5m=${cand.volume5mUsd ?? cand.volumeUsd5m ?? '-'} | vol24h=${cand.volume24hUsd ?? '-'} | px=${cand.price ?? '-'}`);
  }

  let filterRes = null;
  try {
    filterRes = await applyFiltersAdvanced(cand);
  } catch (e) {
    log.error('Error en filtros avanzados, usando filtros por defecto.', e.message || e);
    filterRes = defaultApplyFilters(cand);
  }

  if (filterRes.pass) {
    log.hit(`PASA filtros: ${cand.symbol} (${cand.mint || cand.signature || 'NA'}) | liq=${cand.liquidityUsd ?? '-'} | vol5m=${cand.volume5mUsd ?? cand.volumeUsd5m ?? '-'} | vol24h=${cand.volume24hUsd ?? '-'}`);
    _tickStats({ hit: true });
    await simulateTradeFlow(cand);
  } else {
    log.miss(`No pasa filtros: ${cand.symbol || cand.mint || 'NA'} -> ${filterRes.reason}`);
  }
}

// ---------- Arranque ----------
async function start() {
  log.info('Arrancando bot en modo simulación. Parámetros:', {
    ONLY_HITS, DEBUG_MARKET, LOG_LEVEL,
    MIN_LIQ_USD, MIN_VOL_USD, MIN_VOL_USD_5M,
    BUY_USD, TP_PCT, SL_PCT, WATCH_SEC,
    MAX_HITS_PER_SEC, DEDUP_TTL_MS, PRICE_TICK_MS,
    FAST_PATH_NO_ONCHAIN,
    EARLY_AGE_SEC, EARLY_MIN_LIQ_USD, EARLY_REQUIRE_VOL, EARLY_FAST_PASS
  });

  if (FAST_PATH_NO_ONCHAIN) {
    log.warn('FAST_PATH_NO_ONCHAIN_CHECK=1 → se aceptarán candidatos con métricas desconocidas (más ruido). Ponlo a 0 para filtrar duro.');
  }

  if (listener) {
    if (typeof listener.start === 'function') {
      log.info('Usando listener real: start({ onCandidate })');
      await listener.start({
        onCandidate: async (cand) => gatedProcessCandidate(cand).catch(e => log.error('processCandidate error', e))
      });
      return;
    }
    if (typeof listener.on === 'function') {
      log.info('Usando listener real: EventEmitter.on("candidate")');
      listener.on('candidate', (cand) => gatedProcessCandidate(cand).catch(e => log.error('processCandidate error', e)));
      if (typeof listener.init === 'function') await listener.init();
      return;
    }
    log.warn('listener detectado pero sin API conocida. Se usa simulación interna.');
  }

  if (DEBUG_MARKET) {
    log.info('Generador de mercado SIM activado (DEBUG_MARKET=1).');
    while (true) { await gatedProcessCandidate(makeCandidateSim()); await sleep(800); }
  } else {
    log.info('DEBUG_MARKET=0; generando candidatos simulados a baja frecuencia.');
    while (true) { await gatedProcessCandidate(makeCandidateSim()); await sleep(3000); }
  }
}

// Resumen en SIGINT
process.on('SIGINT', () => {
  console.log(`\n[${LOG_PREFIX}] [${now()}] Saliendo… Resumen → vistos=${_stats.seen}, hits=${_stats.hits}, descartes=${_stats.dropped}`);
  process.exit(0);
});

// --------- GO ---------
start().catch((e) => log.error('Fatal:', e));
