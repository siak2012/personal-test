// index.js — MVP simulación + auto-enganche a módulos existentes
// --------------------------------------------------------------
// Requisitos: npm i dotenv axios ws @solana/web3.js @solana/spl-token bs58
// (Puedes tener otros módulos; este archivo intenta usarlos si existen.)

require('dotenv').config();

// ---------- Utilidades ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();

const env = (k, def) => (process.env[k] ?? def);
const ONLY_HITS   = env('ONLY_HITS', '0') === '1';
const DEBUG_MARKET= env('DEBUG_MARKET', '0') === '1';
const MIN_LIQ_USD = Number(env('MIN_LIQ_USD', '1000'));
const MIN_VOL_USD = Number(env('MIN_VOL_USD', '1000'));
const BUY_USD     = Number(env('BUY_USD', '100'));        // Monto de compra simulada
const TP_PCT      = Number(env('TP_PCT', '25'));          // take profit %
const SL_PCT      = Number(env('SL_PCT', '20'));          // stop loss %
const WATCH_SEC   = Number(env('WATCH_SEC', '15'));       // segundos a vigilar antes de decidir
const LOG_PREFIX  = env('LOG_PREFIX', 'SNIPER');

// Carga opcional de listas si existen:
let allowlist = new Set();
let blocklist = new Set();
try {
  allowlist = new Set(require('./allowlist.json'));
} catch {}
try {
  blocklist = new Set(require('./blocklist.json'));
} catch {}

// Logger sencillo
const log = {
  info: (...a) => console.log(`[${LOG_PREFIX}] [${now()}]`, ...a),
  dbg:  (...a) => console.log(`[${LOG_PREFIX}] [${now()}] [DEBUG]`, ...a),
  hit:  (...a) => console.log(`[${LOG_PREFIX}] [${now()}] [HIT] ✅`, ...a),
  miss: (...a) => console.log(`[${LOG_PREFIX}] [${now()}] [MISS] ❌`, ...a),
  sim:  (...a) => console.log(`[${LOG_PREFIX}] [${now()}] [SIM] 🧪`, ...a),
  err:  (...a) => console.error(`[${LOG_PREFIX}] [${now()}] [ERR]`, ...a),
};

// ---------- Intenta enganchar módulos reales si existen ----------
function tryRequire(path) {
  try { return require(path); } catch { return null; }
}

// listener real opcional (de tu repo)
const listenerModule = tryRequire('./listener') || tryRequire('./src/listener');
// filtros reales opcionales (de tu repo)
const filtersModule  = tryRequire('./filters')  || tryRequire('./src/filters');

// ---------- Generador de candidatos (simulado) ----------
function randomTokenMint() {
  const chars = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let s = '';
  for (let i = 0; i < 44; i++) s += chars[Math.floor(Math.random()*chars.length)];
  return s;
}

function makeCandidateSim() {
  const mint = randomTokenMint();
  const liq  = Math.floor(500 + Math.random()*5000);   // USD
  const vol  = Math.floor(500 + Math.random()*8000);   // USD
  const price= +(0.0001 + Math.random()*0.05).toFixed(6);
  return {
    mint,
    symbol: `SIM${mint.slice(0,4)}`,
    liquidityUsd: liq,
    volume24hUsd: vol,
    price,
    ts: Date.now()
  };
}

// ---------- Filtros por defecto (si no hay módulo real) ----------
function defaultApplyFilters(cand) {
  if (allowlist.size && !allowlist.has(cand.mint) && !allowlist.has(cand.symbol)) {
    return { pass:false, reason:'not-in-allowlist' };
  }
  if (blocklist.size && (blocklist.has(cand.mint) || blocklist.has(cand.symbol))) {
    return { pass:false, reason:'in-blocklist' };
  }
  if ((cand.liquidityUsd ?? 0) < MIN_LIQ_USD) {
    return { pass:false, reason:`liq<${MIN_LIQ_USD}` };
  }
  if ((cand.volume24hUsd ?? 0) < MIN_VOL_USD) {
    return { pass:false, reason:`vol<${MIN_VOL_USD}` };
  }
  return { pass:true };
}

// ---------- Simulación de trade ----------
async function simulateTradeFlow(cand) {
  // Compra simulada
  const buyPrice = cand.price;
  const qty = +(BUY_USD / buyPrice).toFixed(6);
  log.sim(`Compra simulada ${BUY_USD} USD en ${cand.symbol} (${cand.mint}) @ ${buyPrice} → qty=${qty}`);

  // Vigilar precio (simulación de movimiento)
  const targetUp   = buyPrice * (1 + TP_PCT/100);
  const targetDown = buyPrice * (1 - SL_PCT/100);
  const start = Date.now();

  while ((Date.now()-start)/1000 < WATCH_SEC) {
    await sleep(1000 + Math.random()*600);
    // precio simulado con pequeña deriva
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
    log.dbg(`Precio simulado=${px} (objetivos: TP ${targetUp.toFixed(6)} / SL ${targetDown.toFixed(6)})`);
  }

  // Si no tocó TP/SL, cierre por tiempo
  const lastPx = +(buyPrice * (0.98 + Math.random()*0.06)).toFixed(6);
  const pnl = +((lastPx - buyPrice) * qty).toFixed(4);
  const pct = +(((lastPx/buyPrice)-1)*100).toFixed(2);
  log.sim(`Cierre por tiempo @ ${lastPx} | PnL=${pnl} USD (${pct}%)`);
}

// ---------- Pipeline principal ----------
async function processCandidate(cand) {
  if (DEBUG_MARKET) {
    log.dbg(`Candidato: ${cand.symbol} | liq=${cand.liquidityUsd} USD | vol24h=${cand.volume24hUsd} USD | px=${cand.price}`);
  }

  // Aplica filtros (módulo real si existe; si no, default)
  let filterRes = null;
  if (filtersModule && typeof filtersModule.applyFilters === 'function') {
    try {
      filterRes = await filtersModule.applyFilters(cand, { MIN_LIQ_USD, MIN_VOL_USD, allowlist, blocklist });
    } catch (e) {
      log.err('Error en filters.applyFilters, usando filtros por defecto.', e.message);
      filterRes = defaultApplyFilters(cand);
    }
  } else {
    filterRes = defaultApplyFilters(cand);
  }

  if (filterRes.pass) {
    log.hit(`PASA filtros: ${cand.symbol} (${cand.mint}) | liq=${cand.liquidityUsd} | vol=${cand.volume24hUsd}`);
    await simulateTradeFlow(cand);
  } else {
    if (!ONLY_HITS) log.miss(`No pasa filtros: ${cand.symbol} -> ${filterRes.reason}`);
  }
}

// ---------- Arranque del flujo ----------
// 1) Si hay listener real exportado, úsalo. Debe emitir candidatos (objetos como makeCandidateSim()).
//    Contrato esperado: listener.start({ onCandidate }) o listener.on('candidate', handler)
async function start() {
  log.info('Arrancando bot en modo simulación. Parámetros:',
    { ONLY_HITS, DEBUG_MARKET, MIN_LIQ_USD, MIN_VOL_USD, BUY_USD, TP_PCT, SL_PCT, WATCH_SEC });

  if (listenerModule) {
    // Intento 1: listener.start({ onCandidate })
    if (typeof listenerModule.start === 'function') {
      log.info('Usando listener real: start({ onCandidate })');
      await listenerModule.start({
        onCandidate: async (cand) => processCandidate(cand).catch(e => log.err('processCandidate error', e))
      });
      return;
    }
    // Intento 2: EventEmitter-like
    if (typeof listenerModule.on === 'function') {
      log.info('Usando listener real: EventEmitter.on("candidate")');
      listenerModule.on('candidate', (cand) => processCandidate(cand).catch(e => log.err('processCandidate error', e)));
      if (typeof listenerModule.init === 'function') await listenerModule.init();
      return;
    }
    log.err('listener detectado pero sin API conocida. Se usa simulación interna.');
  }

  // 2) Simulación interna si no hay listener válido
  if (DEBUG_MARKET) {
    log.info('Generador de mercado SIM activado (DEBUG_MARKET=1).');
    // flujo continuo de candidatos simulados
    while (true) {
      const cand = makeCandidateSim();
      await processCandidate(cand);
      await sleep(800); // ritmo de candidatos
    }
  } else {
    // Modo pasivo sin DEBUG: generamos con menor frecuencia
    log.info('DEBUG_MARKET=0; generando candidatos simulados a baja frecuencia.');
    while (true) {
      const cand = makeCandidateSim();
      await processCandidate(cand);
      await sleep(3000);
    }
  }
}

start().catch((e) => log.err('Fatal:', e));
