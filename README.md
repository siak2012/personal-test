# Solana Sniper MVP — Listener WS "PRECISO" (sin heurística)
- Extrae el **mint** a partir del **detalle de la transacción** (postTokenBalances), no de patrones en el texto del log.
- Configura **RPC HTTP/WS** por separado para asegurar compatibilidad.
- `SLIPPAGE_BPS` configurable desde `.env`.
- `SIMULATE=true` por defecto (no envía dinero real).

## Pasos (DEMO)
```bash
npm i
cp .env.example .env
node src/sniper.js keygen > keypair.json
npm run listen
```
Si quieres usar un RPC rápido, pon en `.env`:
```
RPC_URL_HTTP=<tu RPC HTTP de Helius/QuickNode/Triton/Jito>
RPC_URL_WS=<tu RPC WS de Helius/QuickNode/Triton/Jito>
```
