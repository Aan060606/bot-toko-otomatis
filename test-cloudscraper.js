const cloudscraper = require('cloudscraper');

async function testSaweria() {
  const url = 'https://backend.saweria.co/donations/AdminJsub/calculate_pg_amount';
  const payload = {
    agree: true,
    notUnderage: true,
    message: "test",
    amount: 10000,
    payment_type: "qris",
    vote: "",
    currency: "IDR",
    customer_info: {
      first_name: "bot",
      email: "bot@bot.com",
      phone: ""
    }
  };

  console.log("Testing with cloudscraper...");
  try {
    const res = await cloudscraper.post({
      uri: url,
      json: payload,
      headers: {
        "Origin": "https://saweria.co",
        "Referer": "https://saweria.co/",
      }
    });
    console.log("SUCCESS:", res);
  } catch (err) {
    console.error("FAILED:", err.message);
    if (err.response) {
       console.error("Status:", err.response.statusCode);
       console.error("Body:", err.response.body.substring(0, 500));
    }
  }
}

testSaweria();
