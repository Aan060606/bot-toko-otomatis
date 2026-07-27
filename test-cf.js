const axios = require('axios');
async function test() {
  try {
    const res = await axios.post('https://backend.saweria.co/donations/snap/974c1100-d629-4c27-a290-c474bbbd1bf6', 
      {"agree":true,"notUnderage":true,"message":"-","amount":50000,"payment_type":"qris","vote":"","currency":"IDR","customer_info":{"first_name":"TEST","email":"test@test.com","phone":""}},
      {
        headers: {
          'Origin': 'https://saweria.co',
          'Referer': 'https://saweria.co/',
          'User-Agent': 'curl/8.5.0', // Spoofing curl
          'Content-Type': 'application/json'
        }
      }
    );
    console.log("SUCCESS:", res.data.data.qr_string);
  } catch (e) {
    console.log("FAILED:", e.response ? e.response.data.slice(0, 100) : e.message);
  }
}
test();
