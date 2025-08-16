// trade-sim.cjs
module.exports.simulateTrade = function (mint, entryPrice, tpPct, slPct, holdTimeSec) {
    console.log(`[TRADE] 🛒 Compra simulada de ${mint} a $${entryPrice.toFixed(4)}`);
    console.log(`[TRADE] Objetivo TP: $${(entryPrice * (1 + tpPct / 100)).toFixed(4)} (+${tpPct}%)`);
    console.log(`[TRADE] Objetivo SL: $${(entryPrice * (1 - slPct / 100)).toFixed(4)} (-${slPct}%)`);

    let elapsed = 0;
    let currentPrice = entryPrice;

    const interval = setInterval(() => {
        elapsed += 2;
        // Simulación aleatoria de precio
        currentPrice *= (1 + (Math.random() - 0.5) / 50);

        console.log(`[TRADE] ${mint} | Tiempo: ${elapsed}s | Precio: $${currentPrice.toFixed(4)}`);

        // Check Take Profit
        if (currentPrice >= entryPrice * (1 + tpPct / 100)) {
            console.log(`[TRADE] 🎯 TP alcanzado (+${tpPct}%) | Ganancia simulada: +${tpPct}%`);
            clearInterval(interval);
            return;
        }

        // Check Stop Loss
        if (currentPrice <= entryPrice * (1 - slPct / 100)) {
            console.log(`[TRADE] 🛑 SL alcanzado (-${slPct}%) | Pérdida simulada: -${slPct}%`);
            clearInterval(interval);
            return;
        }

        // Cierre por tiempo máximo
        if (elapsed >= holdTimeSec) {
            console.log(`[TRADE] ⏳ Tiempo máximo (${holdTimeSec}s) alcanzado | Precio final: $${currentPrice.toFixed(4)}`);
            clearInterval(interval);
        }

    }, 2000);
};
