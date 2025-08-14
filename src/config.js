import 'dotenv/config';
import fs from 'fs';

export const RPC_URL_HTTP = process.env.RPC_URL_HTTP || 'https://api.mainnet-beta.solana.com';
export const RPC_URL_WS   = process.env.RPC_URL_WS   || 'wss://api.mainnet-beta.solana.com';
export const KEYPAIR_PATH = process.env.KEYPAIR_PATH || './keypair.json';
export const SIMULATE = String(process.env.SIMULATE||'true').toLowerCase() === 'true';

export const RAYDIUM_PROGRAM_IDS = (process.env.RAYDIUM_PROGRAM_IDS||'').split(',').map(s=>s.trim()).filter(Boolean);
export const PUMPFUN_PROGRAM_ID = process.env.PUMPFUN_PROGRAM_ID || '';

export const JUPITER_BASE = process.env.JUPITER_BASE || 'https://quote-api.jup.ag';
export const JUPITER_PRIORITY = process.env.JUPITER_PRIORITY || 'auto';
export const SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS || 150);

export const FILTERS = {
  MIN_LIQ_USD: Number(process.env.MIN_LIQ_USD || 8000),
  MAX_FDV_USD: Number(process.env.MAX_FDV_USD || 20000000),
  MIN_TXS_5M: Number(process.env.MIN_TXS_5M || 5),
  MAX_AGE_SEC: Number(process.env.MAX_AGE_SEC || 1800)
};

export function loadKeypair() {
  const raw = fs.readFileSync(KEYPAIR_PATH, 'utf8');
  const arr = JSON.parse(raw);
  return Uint8Array.from(arr);
}
