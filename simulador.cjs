// simulador.cjs
const fs = require('fs');
const path = require('path');

const PORTFOLIO_FILE = path.join(__dirname, 'portfolio.json');
const BALANCE_FILE = path.join(__dirname, 'balance.json');

function loadJSON(file, def) {
  if (fs.existsSync(file)) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return def;
    }
  }
  return def;
}

function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// Inicializamos balance virtual
let balance = loadJSON(BALANCE_FILE, { sol: 10 }); // 10 SOL iniciales
let portfolio = loadJSON(PORTFOLIO_FILE, []);

// Función para simular compra
function buyToken(mint, price, amountSOL) {
  if (balance.sol < amountSOL) {
    console.log(`[SIMULADOR] ❌ Saldo insuficiente para comprar ${mint}`);
    return;
  }

  const tokensBought = amountSOL / price;
  balance.sol -= amountSOL;

  portfolio.push({
    mint,
    entryPrice: price,
    amountSOL,
    tokens: tokensBought,
    targetPrice: price * 1.2, // objetivo +20%
    time: new Date().toISOString()
  });

  console.log(`[SIMULADOR] ✅ Compra: ${amountSOL} SOL en ${mint} @ ${price.toFixed(8)} → ${tokensBought.toFixed(2)} tokens`);
  saveJSON(BALANCE_FILE, balance);
  saveJSON(PORTFOLIO_FILE, portfolio);
}

// Función para simular venta (cuando alcanza target)
function sellToken(mint, currentPrice) {
  const posIndex = portfolio.findIndex(p => p.mint === mint);
  if (posIndex === -1) {
    console.log(`[SIMULADOR] ❌ No tienes ${mint} en cartera`);
    return;
  }

  const pos = portfolio[posIndex];
  if (currentPrice < pos.targetPrice) {
    console.log(`[SIMULADOR] ⏳ Aún no se alcanzó target de venta en ${mint} (${currentPrice.toFixed(8)} < ${pos.targetPrice.toFixed(8)})`);
    return;
  }

  const value = pos.tokens * currentPrice;
  balance.sol += value;

  console.log(`[SIMULADOR] 💰 Venta realizada: ${pos.tokens.toFixed(2)} ${mint} @ ${currentPrice.toFixed(8)} → +${value.toFixed(4)} SOL`);

  portfolio.splice(posIndex, 1);
  saveJSON(BALANCE_FILE, balance);
  saveJSON(PORTFOLIO_FILE, portfolio);
}

// Mostrar estado actual
function status() {
  console.log(`\n📊 ESTADO DE SIMULACIÓN 📊`);
  console.log(`Saldo virtual: ${balance.sol.toFixed(4)} SOL`);
  console.log(`Cartera: ${portfolio.length} posiciones`);
  portfolio.forEach(p => {
    console.log(`• ${p.mint} → ${p.tokens.toFixed(2)} tokens (Entry: ${p.entryPrice.toFixed(8)}, Target: ${p.targetPrice.toFixed(8)})`);
  });
}

// CLI simple
const [,, cmd, mint, price, amount] = process.argv;

if (cmd === 'buy') {
  if (!mint || !price || !amount) {
    console.log('Uso: node simulador.cjs buy <MINT> <PRECIO> <CANTIDAD_SOL>');
    process.exit(1);
  }
  buyToken(mint, parseFloat(price), parseFloat(amount));
} else if (cmd === 'sell') {
  if (!mint || !price) {
    console.log('Uso: node simulador.cjs sell <MINT> <PRECIO_ACTUAL>');
    process.exit(1);
  }
  sellToken(mint, parseFloat(price));
} else if (cmd === 'status') {
  status();
} else {
  console.log('Comandos disponibles: buy, sell, status');
}
