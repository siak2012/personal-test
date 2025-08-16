const fetch = require('node-fetch');

async function getRaydiumPrice(mint) {
    try {
        const url = `https://api.raydium.io/v2/main/pairs`;
        const res = await fetch(url);
        const data = await res.json();

        // Buscar par que tenga el mint detectado
        const pair = data.find(p =>
            p.baseMint === mint || p.quoteMint === mint
        );

        if (!pair) {
            console.log(`[PRICE] ❌ No se encontró pool en Raydium para ${mint}`);
            return null;
        }

        // Si el token es la base, precio directo; si es la quote, invertimos
        let price = 0;
        if (pair.baseMint === mint) {
            price = parseFloat(pair.price);
        } else {
            price = 1 / parseFloat(pair.price);
        }

        console.log(`[PRICE] ✅ Precio Raydium para ${mint}: $${price.toFixed(6)}`);
        return price;

    } catch (err) {
        console.error(`[PRICE] Error obteniendo precio Raydium:`, err.message);
        return null;
    }
}

module.exports = { getRaydiumPrice };
