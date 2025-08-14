import { PublicKey } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';

/** Rechaza tokens con mintAuthority o freezeAuthority activas */
export async function authorityFilter(conn, mintStr) {
  try {
    const mintPk = new PublicKey(mintStr);
    const mint = await getMint(conn, mintPk);
    const mintAuthOk = mint.mintAuthority === null;
    const freezeAuthOk = mint.freezeAuthority === null;
    return { ok: (mintAuthOk && freezeAuthOk), details: { mintAuthority: mint.mintAuthority, freezeAuthority: mint.freezeAuthority } };
  } catch (e) {
    return { ok:false, reason:'mint read error: '+e.message };
  }
}
