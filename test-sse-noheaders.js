const WebSocket = require('ws');
const streamKey = '32c03b468255e6ff6d8926b48d4d4fa8';
const url = `wss://events.saweria.co/stream?streamKey=${streamKey}`;
const ws = new WebSocket(url);
ws.on('open', () => {
  console.log('Connected no headers!');
  process.exit(0);
});
ws.on('error', (err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
