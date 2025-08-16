// src/filters.ts
import { Logger } from "./logger";

// Ajusta a tu gusto
const MIN_LIQ_USD = Number(process.env.MIN_LIQ_USD ?? 500);
const MIN_VOL_USD_5M = Number(process.env.MIN_VOL_USD_5M ?? 100);
const MAX_SUPPLY = Number(process.env.MAX_SUPPLY ?? 1_000_000_000_000);
const MIN_DECIMALS = Number(process.env.MIN_DECIMALS ?? 0);
const MAX_DECIMALS = Number(process.env.MAX_DECIMALS ?? 12);

// Stubs: conecta aquí tus funciones reales de RPC/indexer si ya las tienes
async function fetchPoolSnapshot(_sigOrPool: string) {
  // Devuelve datos mínimos para filtro. Sustituye por tu lógica real.
  return {
    liqUsd: 0,               // <-- ahora mismo 0 para forzar rechazo
    vol5mUsd: 0,
    tokenMint: "UNK",
    tokenDecimals: 9,
    tokenSupply: 10_000_000,
    renounced: false,
    freezeAuthority: null as string | null,
  };
}

// Señal clara de “evento de interés” (heurística simple y segura)
export function isLikelyPoolInit(logText: string): boolean {
  const t = logText.toLowerCase();
  // Raydium/Pump suelen tener trazas con "initialize", "create", "pool", "mint"…
  return /(initialize|create).*(pool|amm|cpmm|pair)/.test(t)
      || /(add|seed).*(liquidity)/.test(t)
      || /(create).*mint/.test(t);
}

export type Candidate = {
  source: "raydium-log";
  key: string;          // signature o combinación única
  rawSymbol?: string;
  display: string;
};

export async function hardFilter(candidate: Candidate) {
  // Filtro adicional con datos on-chain
  const snap = await fetchPoolSnapshot(candidate.key);
  if (snap.liqUsd < MIN_LIQ_USD) {
    Logger.debug("FILTER", `Descartado por liqUsd=${snap.liqUsd} < ${MIN_LIQ_USD}`);
    return { ok: false as const, reason: "low_liquidity" };
  }
  if (snap.vol5mUsd < MIN_VOL_USD_5M) {
    Logger.debug("FILTER", `Descartado por vol5mUsd=${snap.vol5mUsd} < ${MIN_VOL_USD_5M}`);
    return { ok: false as const, reason: "low_volume" };
  }
  if (snap.tokenDecimals < MIN_DECIMALS || snap.tokenDecimals > MAX_DECIMALS) {
    return { ok: false as const, reason: "weird_decimals" };
  }
  if (snap.tokenSupply <= 0 || snap.tokenSupply > MAX_SUPPLY) {
    return { ok: false as const, reason: "weird_supply" };
  }
  if (snap.freezeAuthority) {
    return { ok: false as const, reason: "has_freeze_authority" };
  }
  // Si quieres exigir renounce:
  // if (!snap.renounced) return { ok: false as const, reason: "not_renounced" };

  const symbol = (candidate.rawSymbol ?? "UNK").slice(0, 12);
  return {
    ok: true as const,
    enriched: {
      symbol,
      liqUsd: snap.liqUsd,
      vol5mUsd: snap.vol5mUsd,
    }
  };
}
