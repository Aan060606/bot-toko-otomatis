const WebSocket = require('ws');
const ws = new WebSocket('wss://events.saweria.co/stream?streamKey=32c03b468255e6ff6d8926b48d4d4fa8');

ws.on('open', () => console.log('Connected to Saweria WS'));
ws.on('message', (data) => console.log('Received:', data.toString()));
ws.on('error', (err) => console.error('Error:', err.message));
ws.on('close', () => console.log('Connection closed'));
