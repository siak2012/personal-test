// report.cjs
const fs = require("fs");

function loadJSON(path) {
  if (fs.existsSync(path)) {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  }
  return null;
}

function getFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith(".json"));
}

function report() {
  const buyFiles = getFiles("./compras");
  const sellFiles = getFiles("./ventas");

  let totalInvertido = 0;   // en SOL
  let totalRecuperado = 0;  // en SOL
  let reportLines = [];

  // Procesar compras
  buyFiles.forEach(file => {
    const mint = file.replace(".json", "");
    const data = loadJSON(`./compras/${file}`);
    if (data?.buyPrice && data?.amountSOL && data?.tokens) {
      totalInvertido += data.amountSOL;
      reportLines.push(
        `🟢 Compra activa: ${mint} | ${data.tokens.toFixed(2)} tokens @ ${data.buyPrice} USD | invertido: ${data.amountSOL} SOL`
      );
    }
  });

  // Procesar ventas
  sellFiles.forEach(file => {
    const mint = file.replace(".json", "");
    const data = loadJSON(`./ventas/${file}`);
    if (data?.buyPrice && data?.sellPrice && data?.tokens) {
      const pnl = (data.sellPrice - data.buyPrice) * data.tokens;
      totalRecuperado += data.amountSOL + pnl; // recupera la inversión inicial + PnL
      const emoji = pnl >= 0 ? "✅" : "❌";
      reportLines.push(
        `${emoji} Venta: ${mint} | ${data.tokens.toFixed(2)} tokens | buy ${data.buyPrice} → sell ${data.sellPrice} | PnL: ${pnl.toFixed(4)} SOL`
      );
    }
  });

  console.log("========= 📊 REPORTE PnL 📊 =========");
  reportLines.forEach(line => console.log(line));
  console.log("====================================");
  console.log(`Total invertido en compras activas: ${totalInvertido.toFixed(4)} SOL`);
  console.log(`Total recuperado en ventas: ${totalRecuperado.toFixed(4)} SOL`);
  console.log(`Balance PnL acumulado: ${(totalRecuperado - totalInvertido).toFixed(4)} SOL`);
}

// Ejecutar
report();
