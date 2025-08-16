// bot.cjs
const WebSocket = require("ws");
const fetch = require("node-fetch");
const { spawn } = require("child_process");
const fs = require("fs");

// =================== CONFIG ===================
const HELIUS_WSS = `wss://mainnet.helius-rpc.com/?api-key=84d82b21-17f1-430b-ba5a-84fdcb2c9826`;
const PROGRAMS = [
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", // pump.fun
  "675kPX9MHTjS2Y8gY7PzYkJvq1zYqSV1K3LQu8jq5FZ"  // Raydium
];
const BUY_AMOUNT_SOL = 0.5;   // cantidad fija por compra
const TAKE_PROFIT = 1.2;      // vender con +20%

// =================== ESTADO ===================
let cartera = new Set(); // guarda los mints ya comprados

// =================== FUNCIONES ===================

// Ejecutar simulador (buy o sell)
function runSimulador(action, mint, price, amount) {
  return new Promise((resolve) => {
    let args;
    if (action === "buy") {
      args = ["buy", mint, price.toString(), amount.toString()];
    } else if (action === "sell") {
      args = ["sell", mint, price.toString()];
    } else {
      return resolve(null);
    }

    const proc = spawn("node", ["simulador.cjs", ...args]);

    proc.stdout.on("data", (data) => {
      console.log(data.toString().trim());
    });

    proc.stderr.on("data", (data) => {
      console.error(data.toString().trim());
    });

    proc.on("close", () => resolve(true));
  });
}

// Consultar DexScreener
async function getDexData(mint) {
  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = await res.json();
    if (json.pairs && json.pairs.length > 0) {
      return json.pairs[0]; // tomamos la primera pool
    }
    return null;
  } catch (err) {
    console.error("[DEX] Error:", err.message);
    return null;
  }
}

// Auto venta: revisa precios y ejecuta venta si cumple take profit
async function autoCheckSells() {
  for (let mint of cartera) {
    const data = await getDexData(mint);
    if (!data || !data.priceUsd) continue;

    const price = parseFloat(data.priceUsd);
    const buyFile = `./compras/${mint}.json`;

    if (fs.existsSync(buyFile)) {
      const info = JSON.parse(fs.readFileSync(buyFile, "utf8"));
      const buyPrice = parseFloat(info.buyPrice);

      if (price >= buyPrice * TAKE_PROFIT) {
        console.log(`[AUTOSELL] 🚀 Vendiendo ${mint} (precio actual ${price}, compra en ${buyPrice})`);
        await runSimulador("sell", mint, price);
        cartera.delete(mint);
        fs.unlinkSync(buyFile);
      }
    }
  }
}

// =================== WS BOT ===================
function startBot() {
  const ws = new WebSocket(HELIUS_WSS);

  ws.on("open", () => {
    console.log(`[MEME-BOT] Conectando a WS ${HELIUS_WSS}...`);
    console.log("[MEME-BOT] Conexión WS abierta ✅");

    // Suscribirse a programas
    PROGRAMS.forEach((program) => {
      const sub = {
        jsonrpc: "2.0",
        id: program,
        method: "logsSubscribe",
        params: [
          {
            mentions: [program],
          },
          { commitment: "confirmed" },
        ],
      };
      ws.send(JSON.stringify(sub));
      console.log(`[MEME-BOT] Suscripción a logs de programa: ${program}`);
    });
  });

  ws.on("message", async (msg) => {
    try {
      const data = JSON.parse(msg.toString());

      if (data?.params?.result?.value?.signature) {
        const sig = data.params.result.value.signature;
        const mint = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"; // TODO: parse real mint del log

        if (cartera.has(mint)) {
          console.log(`[MEME-BOT] ⏩ Ya tengo posición en ${mint}, no vuelvo a comprar`);
          return;
        }

        console.log(`[MEME-BOT] 🎯 NUEVO MINT DETECTADO! ${mint}`);
        console.log("[MEME-BOT] 💸 Ejecutando compra simulada en simulador...");

        const dexData = await getDexData(mint);
        let price = dexData?.priceUsd ? parseFloat(dexData.priceUsd) : Math.random() * 0.15;

        const amountSOL = BUY_AMOUNT_SOL;
        const tokens = amountSOL / price;

        await runSimulador("buy", mint, price, amountSOL);

        cartera.add(mint);

        // Guardar datos de compra
        if (!fs.existsSync("./compras")) fs.mkdirSync("./compras");
        fs.writeFileSync(
          `./compras/${mint}.json`,
          JSON.stringify({ buyPrice: price, amountSOL, tokens }, null, 2)
        );
      }
    } catch (err) {
      console.error("[MEME-BOT] Error procesando mensaje:", err.message);
    }
  });

  // Revisión periódica de ventas
  setInterval(autoCheckSells, 15000);
}

startBot();
