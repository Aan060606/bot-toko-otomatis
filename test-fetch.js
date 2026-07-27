const fetch = require('node-fetch'); // node-fetch exists because index.js might use it? Wait, let's use global fetch if Node 18+
fetch('https://backend.saweria.co/donations/snap/974c1100-d629-4c27-a290-c474bbbd1bf6', {
  method: 'POST',
  headers: {
    'Origin': 'https://saweria.co',
    'Referer': 'https://saweria.co/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({"agree":true,"notUnderage":true,"message":"-","amount":50000,"payment_type":"qris","vote":"","currency":"IDR","customer_info":{"first_name":"TEST","email":"test@test.com","phone":""}})
}).then(r => r.text()).then(console.log);
