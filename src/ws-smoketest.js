import 'dotenv/config';
import WebSocket from 'ws';

const WS_URL = process.env.RPC_URL_WS || 'wss://api.mainnet-beta.solana.com';
console.log('🚀 WS smoke test →', WS_URL);

const ws = new WebSocket(WS_URL);
let count = 0;

ws.on('open', () => {
  console.log('✅ WS abierto. Suscríbiendo a TODOS (processed) por 8s…');
  ws.send(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'logsSubscribe',
    params: [ { filter: 'all' }, { commitment: 'processed' } ]
  }));
  setTimeout(() => { console.log('⏹️ cerrando smoke test'); ws.close(); }, 8000);
});

ws.on('message', (m) => {
  const msg = JSON.parse(m);
  if (msg.method === 'logsNotification') {
    count++;
    if (count <= 10) {
      const v = msg.params.result.value;
      console.log('📡', count, v.signature, (v.logs||[]).length, 'logs');
    }
  }
});
ws.on('close', (c) => console.log('⚠️ WS cerrado', c));
ws.on('error', (e) => console.log('❌ WS error', e.message));
