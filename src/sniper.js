import { Connection, Keypair } from '@solana/web3.js';
import { RPC_URL_HTTP } from './config.js';
import { fetchJson } from './utils.js';
import { authorityFilter } from './filters.js';
import { swappableBothWays, simulateRoundTrip } from './jupiter.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

async function getNewPairs() {
  const data = await fetchJson('https://api.dexscreener.com/latest/dex/pairs/solana');
  return (data?.pairs||[]).slice(0,50).map(p=>({
    tokenMint: p?.baseToken?.address || p?.baseToken || p?.base?.address || null,
    baseSymbol: p?.baseToken?.symbol || p?.base?.symbol || '?',
    quoteSymbol: p?.quoteToken?.symbol || p?.quote?.symbol || '?',
    liquidityUsd: p?.liquidity?.usd ?? 0,
    fdv: p?.fdv ?? 0,
    tx5m: (p?.txns?.m5?.buys || 0) + (p?.txns?.m5?.sells || 0),
    pairCreatedAt: p?.pairCreatedAt || null
  }));
}

async function discover() {
  const pairs = await getNewPairs();
  console.table(pairs.map(p=>({mint:p.tokenMint, liq:p.liquidityUsd, fdv:p.fdv, tx5m:p.tx5m})));
}

async function dryrun() {
  const conn = new Connection(RPC_URL_HTTP, 'confirmed');
  const pairs = await getNewPairs();
  for (const p of pairs) {
    if (!p.tokenMint) continue;
    const auth = await authorityFilter(conn, p.tokenMint);
    if (!auth.ok) continue;
    const both = await swappableBothWays(p.tokenMint, SOL_MINT, 1_000_000);
    if (!both.ok) continue;
    const sim = simulateRoundTrip(both);
    console.log({ mint:p.tokenMint, pnlSol: sim.pnlSol });
    break;
  }
}

async function roundtrip(){ await dryrun(); }
async function buy(){ console.log('Usa ws-listener para la parte reactiva.'); }

async function keygen(){
  const kp = Keypair.generate();
  console.log(JSON.stringify(Array.from(kp.secretKey)));
  console.error('PublicKey:', kp.publicKey.toBase58());
}

const cmd = process.argv[2];
if (cmd==='discover') discover()
else if (cmd==='dryrun') dryrun()
else if (cmd==='roundtrip') roundtrip()
else if (cmd==='buy') buy()
else if (cmd==='keygen') keygen()
else console.log('Comandos: listen | discover | dryrun | roundtrip | buy | keygen');
