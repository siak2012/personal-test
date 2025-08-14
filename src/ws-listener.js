import { Connection, PublicKey } from '@solana/web3.js';
import { RPC_URL_HTTP, RPC_URL_WS, RAYDIUM_PROGRAM_IDS, PUMPFUN_PROGRAM_ID, SIMULATE } from './config.js';
import { authorityFilter } from './filters.js';
import { swappableBothWays, simulateRoundTrip } from './jupiter.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const STABLES = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'  // USDT
]);

// === límites desde .env (con valores por defecto sanos) ===
const MAX_RPS = Number(process.env.MAX_RPS || 2);                  // eventos/segundo
const COOLDOWN_ON_429_MS = Number(process.env.COOLDOWN_ON_429_MS || 5000);

async function findNewMintFromTx(conn, signature) {
  const tx = await conn.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  if (!tx || !tx.meta) return null;
  const pre = tx.meta.preTokenBalances || [];
  const post = tx.meta.postTokenBalances || [];
  const preMints = new Set(pre.map(b => b.mint));

  for (const b of post) {
    const mint = b.mint;
    if (!mint) continue;
    if (mint === SOL_MINT) continue;
    if (STABLES.has(mint)) continue;
    if (!preMints.has(mint)) return mint;
  }
  for (const b of post) {
    const mint = b.mint;
    if (mint && mint !== SOL_MINT && !STABLES.has(mint)) return mint;
  }
  return null;
}

const queue = [];
const seen = new Set();
let pausedUntil = 0;

// Trabajador: procesa como mucho MAX_RPS items por segundo
setInterval(async () => {
  if (Date.now() < pausedUntil) return;
  let n = MAX_RPS;
  while (n-- > 0 && queue.length) {
    const job = queue.shift();
    if (!job) break;
    try {
      await processSignature(job);
    } catch (e) {
      // Si es 429, levantamos “pausa” temporal
      if (String(e?.message||'').includes('429')) {
        console.log(`⚠ 429 detectado. Pausa ${COOLDOWN_ON_429_MS}ms`);
        pausedUntil = Date.now() + COOLDOWN_ON_429_MS;
      }
      // otros errores: seguimos
    }
  }
}, 1000);

async function processSignature({ sig, program }) {
  const connHttp = new Connection(RPC_URL_HTTP, 'confirmed');

  const mint = await findNewMintFromTx(connHttp, sig);
  if (!mint) return;

  const auth = await authorityFilter(connHttp, mint);
  if (!auth.ok) return;

  const both = await swappableBothWays(mint, SOL_MINT, 1_000_000); // 0.001 SOL
  if (!both.ok) return;

  const sim = simulateRoundTrip(both);
  console.log('🎯 DEMO válido:', {
    program,
    signature: sig,
    mint,
    pnlSol: sim.pnlSol,
    spentLamports: sim.spentLamports,
    gotBackLamports: sim.gotBackLamports
  });

  if (!SIMULATE) {
    console.log('SIMULATE=false: aquí ejecutaríamos buy/sell reales.');
  }
}

async function main(){
  const connWs = new Connection(RPC_URL_HTTP, { commitment: 'confirmed', wsEndpoint: RPC_URL_WS });
  console.log('HTTP:', RPC_URL_HTTP);
  console.log('WS  :', RPC_URL_WS);

  const programs = [...RAYDIUM_PROGRAM_IDS.filter(Boolean), PUMPFUN_PROGRAM_ID].filter(Boolean);
  if (programs.length === 0) {
    console.log('No hay PROGRAM_IDs configurados en .env'); return;
  }
  console.log('Escuchando programas:', programs);

  for (const pid of programs) {
    try {
      const pk = new PublicKey(pid);
      connWs.onLogs(pk, (logInfo) => {
        const sig = logInfo?.signature;
        if (!sig) return;
        if (seen.has(sig)) return;
        seen.add(sig);
        queue.push({ sig, program: pid });
      }, 'confirmed');
    } catch {
      console.log('Aviso: Program ID inválido, ignorando:', pid);
    }
  }

  // Manejadores de errores WS (muestran pero no cierran)
  connWs._rpcWebSocket.on('error', (e) => {
    console.log('ws error:', e?.message || e);
  });
}

main().catch(e=>{ console.error(e); process.exit(1); });

