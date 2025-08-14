import 'dotenv/config';
import WebSocket from 'ws';

const WS_URL = process.env.RPC_URL_WS;

function pretty(obj) {
  try { return JSON.stringify(obj, null, 2); } catch { return String(obj); }
}

console.log(`🚀 Conectando a WS: ${WS_URL}`);
const ws = new WebSocket(WS_URL);

ws.on('open', () => {
  console.log('✅ WS conectado. Enviando suscripciones de prueba...');

  // 0) Ping periódico para evitar timeouts del nodo
  setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, 15000);

  // 1) Intento A: "todos" los logs (algunos nodos no lo soportan)
  ws.send(JSON.stringify({
    jsonrpc: '2.0', id: 1001, method: 'logsSubscribe',
    params: [ "all", { commitment: 'processed' } ] // <- forma 100% estándar
  }));

  // 2) Intento B: logs con "mentions" del System Program (muy activo)
  ws.send(JSON.stringify({
    jsonrpc: '2.0', id: 1002, method: 'logsSubscribe',
    params: [ { mentions: ["11111111111111111111111111111111"] }, { commitment: 'processed' } ]
  }));

  // 3) Intento C: logs con "mentions" de Raydium + Pump.fun
  const programs = (process.env.RAYDIUM_PROGRAM_IDS || "").split(',').map(s => s.trim()).filter(Boolean);
  const pump = (process.env.PUMPFUN_PROGRAM_ID || "").trim();
  const mentions = [...programs, ...(pump ? [pump] : [])];

  if (mentions.length) {
    ws.send(JSON.stringify({
      jsonrpc: '2.0', id: 1003, method: 'logsSubscribe',
      params: [ { mentions }, { commitment: 'processed' } ]
    }));
  }

  console.log('📨 Suscripciones enviadas: 1001(all), 1002(system), 1003(raydium/pump si procede)');
});

ws.on('message', (raw) => {
  let data;
  try { data = JSON.parse(raw); } catch { console.log('📦 Mensaje no JSON:', raw.toString()); return; }

  // Imprime TODO: confirmaciones, errores, notificaciones
  if (data.method === 'logsNotification') {
    const val = data.params?.result?.value || {};
    console.log('📡 logsNotification:', {
      subId: data.params?.subscription,
      sig: val.signature,
      programId: val.programId,
      logLen: Array.isArray(val.logs) ? val.logs.length : undefined
    });
  } else {
    // Respuestas a las suscripciones o errores
    console.log('🔔 Mensaje WS:', pretty(data));
  }
});

ws.on('error', (err) => {
  console.error('❌ Error en WS:', err);
});

ws.on('close', (code, reason) => {
  console.log('⚠ Conexión WS cerrada.', code, reason?.toString());
});
