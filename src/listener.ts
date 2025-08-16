// src/listener.ts
import { Logger } from "./logger";
import { Deduper } from "./utils/dedupe";
import { RateLimiter, AsyncQueue } from "./utils/queue";
import { isLikelyPoolInit, hardFilter, Candidate } from "./filters";

// ENV ajustables
const DEDUP_TTL_MS = Number(process.env.DEDUP_TTL_MS ?? 60_000);
const MAX_HITS_PER_SEC = Number(process.env.MAX_HITS_PER_SEC ?? 2);
const PRICE_TICK_MS = Number(process.env.PRICE_TICK_MS ?? 2000);

const dedup = new Deduper(DEDUP_TTL_MS);
const rl = new RateLimiter(MAX_HITS_PER_SEC, MAX_HITS_PER_SEC);
const queue = new AsyncQueue(1);

// Estado para resumen
let hitsThisMinute = 0;
let droppedThisMinute = 0;
setInterval(() => {
  Logger.info("SNIPER", `Resumen último minuto → hits=${hitsThisMinute}, descartes=${droppedThisMinute}`);
  hitsThisMinute = 0; droppedThisMinute = 0;
}, 60_000);

// Simulador de precio (menos spam)
let lastPrice = 0.01;
setInterval(() => {
  // Random walk suave
  const drift = (Math.random() - 0.5) * 0.0008;
  lastPrice = Math.max(0.0001, lastPrice + drift);
  Logger.debug("SNIPER", `Precio simulado=${lastPrice.toFixed(6)}`);
}, PRICE_TICK_MS);

// —— Conecta tu WS/logs aquí ——
// Llama a esta función por cada log entrante relevante
export async function onProgramLog(entry: {signature: string; text: string;}) {
  // 1) Pre-filtro por contenido
  if (!isLikelyPoolInit(entry.text)) {
    droppedThisMinute++;
    return;
  }

  // 2) Dedup por signature
  const key = `sig:${entry.signature}`;
  if (dedup.has(key)) {
    droppedThisMinute++;
    return;
  }
  dedup.add(key);

  // 3) Rate limit
  if (!rl.allow()) {
    droppedThisMinute++;
    return;
  }

  // 4) Construir candidato prudente
  const candidate: Candidate = {
    source: "raydium-log",
    key: entry.signature,
    rawSymbol: extractSymbol(entry.text), // heurística simple
    display: extractDisplay(entry.text),
  };

  // 5) Filtro on-chain “duro”
  const res = await hardFilter(candidate);
  if (!res.ok) {
    droppedThisMinute++;
    return;
  }

  // 6) Encolar la simulación (concurrencia 1)
  queue.push(async () => {
    hitsThisMinute++;
    const sym = res.enriched.symbol;
    const liq = res.enriched.liqUsd.toFixed(0);
    const vol = res.enriched.vol5mUsd.toFixed(0);
    Logger.info("SNIPER", `[HIT] ✅ PASA filtros: ${sym} | liq=$${liq} | vol5m=$${vol}`);
    const usd = 50;
    const qty = Math.floor((usd / lastPrice) * 1000) / 1000;
    Logger.info("SNIPER", `[SIM] 🧪 Compra simulada ${usd} USD en ${sym} @ ${lastPrice.toFixed(6)} → qty=${qty}`);
    // Aquí puedes disparar tu TP/SL simulado, pero evita logs en cada tick
  });
}

// Heurísticas básicas para no inventar “UNK...”
function extractSymbol(text: string): string {
  const m = text.match(/[A-Z0-9]{2,8}/);
  return m ? m[0] : "NEW";
}

function extractDisplay(text: string): string {
  return (text.slice(0, 60) + (text.length > 60 ? "…" : "")).replace(/\s+/g, " ");
}

// —— Ejemplo de arranque ——
// Llama a start() desde tu index.ts con el provider WS real
export async function start({ onCandidate }: { onCandidate?: (x:any)=>void } = {}) {
  Logger.info("SNIPER", "Usando listener con filtros duros, dedupe y rate-limit");
  // Aquí enganchas tu conexión WS y, por cada log:
  // ws.on("logs", (log) => onProgramLog({ signature: log.signature, text: log.text.join("\n") }));
  // Para demo local: nada más.
  if (onCandidate) onCandidate({ ready: true });
}
