import 'dotenv/config';
import WebSocket from 'ws';

const WS_URL = process.env.RPC_URL_WS;

console.log(`🚀 Conectando a WS: ${WS_URL}`);
const ws = new WebSocket(WS_URL);

ws.on('open', () => {
  console.log('✅ WS conectado. Escuchando TODOS los logs (modo debug)...');

  // Suscripción para recibir absolutamente todos los logs
  ws.send(JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'logsSubscribe',
  params: [
    { filter: { programId: "11111111111111111111111111111111" } }, // System Program
    { commitment: 'processed' }
  ]
}));


  // Mantener la conexión viva
  setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  }, 15000);
});

ws.on('message', (msg) => {
  const data = JSON.parse(msg);
  if (data.method === 'logsNotification') {
    console.log('📡 Evento recibido:', {
      signature: data.params.result.value.signature,
      programId: data.params.result.value.programId
    });
  }
});

ws.on('error', (err) => {
  console.error('❌ Error en WS:', err);
});

ws.on('close', () => {
  console.log('⚠ Conexión WS cerrada.');
});
