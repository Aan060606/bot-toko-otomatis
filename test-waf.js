const axios = require('axios');
async function test(ua) {
  try {
    const res = await axios.post('https://backend.saweria.co/donations/snap/974c1100-d629-4c27-a290-c474bbbd1bf6', 
      {"agree":true,"notUnderage":true,"message":"-","amount":50000,"payment_type":"qris","vote":"","currency":"IDR","customer_info":{"first_name":"TEST","email":"test@test.com","phone":""}},
      { headers: { 'User-Agent': ua } }
    );
    console.log(`[${ua}] SUCCESS`);
  } catch (e) {
    const html = e.response ? e.response.data.slice(0, 200) : e.message;
    console.log(`[${ua}] FAILED: ${html.includes('Sorry, you have been blocked') ? 'WAF BLOCKED' : html}`);
  }
}
async function run() {
  await test('curl/8.5.0');
  await test('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
  await test('axios/1.6.0');
}
run();
