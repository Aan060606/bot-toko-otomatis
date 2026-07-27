const process = require('process');
const body = '{"type":"test","data":{"id":"123","message":"test"}}';
const payload = JSON.parse(body);
console.log("[WEBHOOK] Raw Payload:", body);

let items = [];
if (payload.data && Array.isArray(payload.data)) items = payload.data;
else if (payload.data) items = [payload.data];
else items = [payload];

if (items.length > 0) {
  for (const item of items) {
    const amount = parseInt(item.amount);
    const donator = item.donator_name || item.donator || "Seseorang";
    const msg = item.message || "";
    console.log(`Donator: ${donator}, Amount: ${amount}, Msg: ${msg}`);
  }
}
