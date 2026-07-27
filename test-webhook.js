const fetch = require('node-fetch');
fetch('http://localhost:8080/webhook/8a442491b6f7a32acceec895457dbf33', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    type: 'donation',
    data: {
      donator_name: 'Test',
      amount: 10000,
      message: 'Test message'
    }
  })
}).then(res => res.text()).then(console.log).catch(console.error);
