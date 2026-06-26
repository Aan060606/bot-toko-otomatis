const WebSocket = require('ws');
const streamKey = '32c03b468255e6ff6d8926b48d4d4fa8';
const url = `wss://events.saweria.co/stream?streamKey=${streamKey}`;
const ws = new WebSocket(url, {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Origin': 'https://saweria.co'
  }
});
ws.on('open', () => {
  console.log('Connected!');
  process.exit(0);
});
ws.on('error', (err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
