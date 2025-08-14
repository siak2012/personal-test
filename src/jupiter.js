import { fetchJson } from './utils.js';
import { JUPITER_BASE, SLIPPAGE_BPS } from './config.js';

export async function jupQuote({ inputMint, outputMint, amount, slippageBps=SLIPPAGE_BPS }) {
  const url = new URL(JUPITER_BASE + '/v6/quote');
  url.searchParams.set('inputMint', inputMint);
  url.searchParams.set('outputMint', outputMint);
  url.searchParams.set('amount', String(amount));
  url.searchParams.set('slippageBps', String(slippageBps));
  url.searchParams.set('onlyDirectRoutes', 'true');
  return await fetchJson(url.toString());
}

export async function swappableBothWays(mint, solMint='So11111111111111111111111111111111111111112', amountInLamports=1_000_000) {
  try {
    const inQuote = await jupQuote({ inputMint: solMint, outputMint: mint, amount: amountInLamports });
    const outQuote = await jupQuote({ inputMint: mint, outputMint: solMint, amount: inQuote?.outAmount || 1 });
    const ok = Boolean(inQuote?.outAmount && outQuote?.outAmount);
    return { ok, inQuote, outQuote };
  } catch (e) {
    return { ok:false, reason: e.message };
  }
}

export function simulateRoundTrip({ inQuote, outQuote }) {
  const buyOut = Number(inQuote?.outAmount || 0);
  const sellBack = Number(outQuote?.outAmount || 0);
  const spent = Number(inQuote?.inAmount || 0);
  const pnlLamports = sellBack - spent;
  return {
    spentLamports: spent,
    gotTokens: buyOut,
    gotBackLamports: sellBack,
    pnlLamports,
    pnlSol: pnlLamports / 1_000_000_000
  };
}
