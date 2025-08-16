// analizar.cjs
const fs = require('fs');
const path = require('path');
const chalk = require('chalk').default || require('chalk');

const LOG_FILE = path.join(__dirname, 'logs.json');

if (!fs.existsSync(LOG_FILE)) {
  console.log(chalk.red(`❌ No existe ${LOG_FILE}`));
  process.exit(1);
}

const logs = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));

let totalEventos = logs.length;
let rechazados = logs.filter(e => e.reason === 'Liquidez insuficiente').length;
let liquidezVals = logs.filter(e => e.liquidity).map(e => parseFloat(e.liquidity));
let compraVals = logs.filter(e => e.priceBuy).map(e => parseFloat(e.priceBuy));
let ventaVals = logs.filter(e => e.priceSell).map(e => parseFloat(e.priceSell));

function media(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

console.log(chalk.bold('\n📊 RESUMEN DE DETECCIONES 📊'));
console.log('─────────────────────────────');
console.log(`Total de eventos: ${totalEventos}`);
console.log(`Rechazados por liquidez: ${rechazados}`);
console.log(`Liquidez media: ${chalk.yellow(media(liquidezVals).toFixed(8))} SOL`);
console.log(`Liquidez máxima: ${chalk.green(Math.max(...liquidezVals).toFixed(2))} SOL`);
console.log(`Liquidez mínima: ${chalk.red(Math.min(...liquidezVals).toFixed(2))} SOL`);
console.log(`Precio medio compra: ${chalk.cyan(media(compraVals).toFixed(8))} SOL`);
console.log(`Precio medio venta: ${chalk.cyan(media(ventaVals).toFixed(8))} SOL\n`);

let ranking = {};
logs.forEach(e => {
  ranking[e.mint] = (ranking[e.mint] || 0) + 1;
});
let topTokens = Object.entries(ranking).sort((a, b) => b[1] - a[1]).slice(0, 10);

console.log(chalk.bold('🏆 TOP 10 TOKENS DETECTADOS:'));
topTokens.forEach(([mint, count], idx) => {
  const color = count > 50 ? chalk.green : count > 10 ? chalk.yellow : chalk.red;
  console.log(`${idx + 1}. ${color(mint)} → ${count} veces`);
});

let topLiquidez = logs
  .filter(e => e.liquidity && e.reason !== 'Liquidez insuficiente')
  .sort((a, b) => parseFloat(b.liquidity) - parseFloat(a.liquidity))
  .slice(0, 5);

console.log(chalk.bold('\n💧 TOP 5 MAYOR LIQUIDEZ:'));
topLiquidez.forEach(e => {
  console.log(`• ${chalk.green(e.mint)} → ${e.liquidity} SOL`);
});

let topPrecios = logs
  .filter(e => e.priceBuy)
  .sort((a, b) => parseFloat(b.priceBuy) - parseFloat(a.priceBuy))
  .slice(0, 5);

console.log(chalk.bold('\n💲 TOP 5 PRECIO DE COMPRA MÁS ALTO:'));
topPrecios.forEach(e => {
  console.log(`• ${chalk.yellow(e.mint)} → ${e.priceBuy} SOL`);
});

console.log();
