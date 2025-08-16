/* eslint-disable no-console */
const envNum = (k, d) => {
  const v = process.env[k];
  if (v === undefined || v === null || v === '') return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const envBool = (k, d) => {
  const v = process.env[k];
  if (v === undefined) return d;
  if (v === '1' || v?.toLowerCase() === 'true') return true;
  if (v === '0' || v?.toLowerCase() === 'false') return false;
  return d;
};
const envList = (k) =>
  (process.env[k]?.split(',').map(s => s.trim()).filter(Boolean)) || [];

const MIN_LIQ_USD = envNum('MIN_LIQ_USD', 500);
const MIN_VOL_USD_24H = envNum('MIN_VOL_USD', 1000);
const MIN_VOL_USD_5M = envNum('MIN_VOL_USD_5M', 100);

const EARLY_AGE_SEC = envNum('EARLY_AGE_SEC', 180);
const EARLY_MIN_LIQ_USD = envNum('EARLY_MIN_LIQ_USD', 300);
const EARLY_REQUIRE_VOL = envBool('EARLY_REQUIRE_VOL', false);
const EARLY_FAST_PASS = envBool('EARLY_FAST_PASS', false);

const MAX_TAX_PCT = envNum('MAX_TAX_PCT', 12);
const BAN_FREEZE = envBool('BAN_FREEZE', true);
const BAN_MINT_AUTH = envBool('BAN_MINT_AUTH', true);

const FAST_PATH_NO_ONCHAIN_CHECK = envBool('FAST_PATH_NO_ONCHAIN_CHECK', false);
const ENRICH_RPS = Math.max(1, envNum('ENRICH_RPS', 2));
const BIRDEYE_KEY = process.env.BIRDEYE_KEY || '';
const ENRICH_TTL_MS = envNum('ENRICH_TTL_MS', 30_000);

const ALLOWLIST_MINTS = new Set(envList('ALLOWLIST_MINTS'));
const BLOCKLIST_MINTS = new Set(envList('BLOCKLIST_MINTS'));

// --- reasons ---
const reasonCounts = new Map();
const bumpReason = (r) => reasonCounts.set(r, 1 + (reasonCounts.get(r) || 0));
const getReasonStats = () =>
  Array.from(reasonCounts.entries()).sort((a,b)=>b[1]-a[1])
    .reduce((acc,[k,v]) => (acc[k]=v, acc), {});

// --- token bucket ---
let tokens = ENRICH_RPS;
let lastRefill = Date.now();
const refill = () => {
  const now = Date.now();
  const delta = (now - lastRefill) / 1000;
  const add = Math.floor(delta * ENRICH_RPS);
  if (add > 0) { tokens = Math.min(ENRICH_RPS, tokens + add); lastRefill = now; }
};
const tryConsume = () => { refill(); if (tokens > 0) { tokens -= 1; return true; } return false; };

// --- cache ---
const cache = new Map();
const cacheGet = (key) => {
  const v = cache.get(key);
  if (!v) return null;
  if (Date.now() - v.t > ENRICH_TTL_MS) { cache.delete(key); return null; }
  return v.d;
};
const cacheSet = (key, data) => cache.set(key, { t: Date.now(), d: data });

// --- Birdeye enrichment ---
async function enrichFromBirdeye(mint, logger) {
  if (!BIRDEYE_KEY) return null;
  const key = `be:${mint}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  if (!tryConsume()) return null;

  try {
    const headers = { 'X-API-KEY': BIRDEYE_KEY };
    const volUrl = `https://public-api.birdeye.so/defi/token_overview?address=${mint}`;
    const tokenUrl = `https://public-api.birdeye.so/defi/token_info?address=${mint}`;

    const [volRes, tokRes] = await Promise.allSettled([
      fetch(volUrl, { headers }),
      fetch(tokenUrl, { headers }),
    ]);

    const vol = (volRes.status === 'fulfilled') ? await volRes.value.json() : null;
    const tok = (tokRes.status === 'fulfilled') ? await tokRes.value.json() : null;

    const out = {
      liq_usd: vol?.data?.liquidity_usd ?? null,
      vol_usd_24h: vol?.data?.volume_24h_usd ?? null,
      vol_usd_5m: vol?.data?.volume_5m_usd ?? null,
      buyTax: vol?.data?.buy_tax ?? null,
      sellTax: vol?.data?.sell_tax ?? null,
      freezeAuthority: tok?.data?.freeze_authority ?? null,
      mintAuthority: tok?.data?.mint_authority ?? null,
    };
    cacheSet(key, out);
    return out;
  } catch (e) {
    logger?.debug?.(`[FILTER] Birdeye error para ${mint}: ${e?.message || e}`);
    return null;
  }
}

function isAuthBanned(info) {
  if (!info) return false;
  const none = '11111111111111111111111111111111';
  if (BAN_FREEZE && info.freezeAuthority && info.freezeAuthority !== none) return true;
  if (BAN_MINT_AUTH && info.mintAuthority && info.mintAuthority !== none) return true;
  return false;
}
function taxesOk(bt, st) {
  const b = (bt ?? 0); const s = (st ?? 0);
  return b <= MAX_TAX_PCT && s <= MAX_TAX_PCT;
}

function createFilter({ logger }) {
  async function filterCandidate(candidate) {
    const now = Date.now();
    const { mint, createdAtMs = candidate.ts || now, metrics = {}, tokenInfo = {} } = candidate || {};
    if (!mint) { bumpReason('invalid-candidate'); return { pass:false, reason:'invalid-candidate' }; }
    if (BLOCKLIST_MINTS.has(mint)) { bumpReason('blocklist'); return { pass:false, reason:'blocklist' }; }
    if (ALLOWLIST_MINTS.has(mint)) { bumpReason('allowlist'); return { pass:true, reason:'allowlist' }; }

    const ageSec = Math.max(0, Math.floor((now - createdAtMs) / 1000));
    const isEarly = ageSec <= EARLY_AGE_SEC;

    let {
      liq_usd = null, vol_usd_24h = null, vol_usd_5m = null,
      buyTax = null, sellTax = null,
      freezeAuthority = tokenInfo.freezeAuthority ?? null,
      mintAuthority = tokenInfo.mintAuthority ?? null,
    } = metrics || {};

    const needEnrich =
      (!FAST_PATH_NO_ONCHAIN_CHECK) &&
      (liq_usd == null ||
       (!EARLY_REQUIRE_VOL && isEarly ? false : (vol_usd_24h == null && vol_usd_5m == null)) ||
       (buyTax == null || sellTax == null) ||
       (BAN_FREEZE || BAN_MINT_AUTH) && (freezeAuthority == null || mintAuthority == null));

    if (needEnrich) {
      const be = await enrichFromBirdeye(mint, logger);
      if (be) {
        liq_usd = liq_usd ?? be.liq_usd;
        vol_usd_24h = vol_usd_24h ?? be.vol_usd_24h;
        vol_usd_5m = vol_usd_5m ?? be.vol_usd_5m;
        buyTax = buyTax ?? be.buyTax;
        sellTax = sellTax ?? be.sellTax;
        freezeAuthority = freezeAuthority ?? be.freezeAuthority;
        mintAuthority = mintAuthority ?? be.mintAuthority;
      }
    }

    if (isAuthBanned({ freezeAuthority, mintAuthority })) { bumpReason('auth-banned'); return { pass:false, reason:'auth-banned' }; }
    if ((buyTax != null || sellTax != null) && !taxesOk(buyTax, sellTax)) { bumpReason('tax-too-high'); return { pass:false, reason:'tax-too-high' }; }

    if (isEarly) {
      if (EARLY_FAST_PASS && liq_usd == null) { bumpReason('early-fastpass'); return { pass:true, reason:'early-fastpass' }; }
      if (liq_usd == null) { bumpReason('early-no-liq-metrics'); return { pass:false, reason:'early-no-liq-metrics' }; }
      if (liq_usd < EARLY_MIN_LIQ_USD) { bumpReason('early-liq-too-low'); return { pass:false, reason:'early-liq-too-low' }; }
      if (EARLY_REQUIRE_VOL) {
        const v5 = vol_usd_5m ?? 0; const v24 = vol_usd_24h ?? 0;
        if (v5 < Math.min(50, MIN_VOL_USD_5M) && v24 < Math.min(200, MIN_VOL_USD_24H)) {
          bumpReason('early-vol-too-low'); return { pass:false, reason:'early-vol-too-low' };
        }
      }
      bumpReason('early-pass');
      return { pass:true, reason:'early-pass', metrics: { liq_usd, vol_usd_5m, vol_usd_24h, buyTax, sellTax } };
    } else {
      if (liq_usd == null) { bumpReason('no-liq-metrics'); return { pass:false, reason:'no-liq-metrics' }; }
      if (liq_usd < MIN_LIQ_USD) { bumpReason('liq-too-low'); return { pass:false, reason:'liq-too-low' }; }
      const v5 = vol_usd_5m ?? 0; const v24 = vol_usd_24h ?? 0;
      if (v5 < MIN_VOL_USD_5M && v24 < MIN_VOL_USD_24H) { bumpReason('vol-too-low'); return { pass:false, reason:'vol-too-low' }; }
      bumpReason('pass');
      return { pass:true, reason:'pass', metrics: { liq_usd, vol_usd_5m, vol_usd_24h, buyTax, sellTax } };
    }
  }
  return { filterCandidate, getReasonStats };
}

module.exports = {
  createFilter,
  getReasonStats: () => getReasonStats(),
};
