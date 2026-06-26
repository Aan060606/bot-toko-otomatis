require('dotenv').config();
const { EventSource } = require('eventsource');

const streamKey = "32c03b468255e6ff6d8926b48d4d4fa8";
if (!streamKey) {
  console.log("Error: SAWERIA_STREAM_KEY kosong di .env");
  process.exit(1);
}

const url = `https://backend.saweria.co/stream?streamKey=${streamKey}`;
console.log("Mencoba konek ke:", url);

const es = new EventSource(url);

es.onopen = () => {
  console.log("✅ BERHASIL TERHUBUNG KE SAWERIA!");
  console.log("Silakan pencet tombol 'Munculkan notifikasi' di web Saweria sekarang...");
};

es.addEventListener('donations', (event) => {
  console.log("📥 EVENT DONATIONS DITERIMA:");
  console.log(event.data);
});

es.addEventListener('message', (event) => {
  console.log("📥 EVENT MESSAGE DITERIMA:");
  console.log(event.data);
});

setTimeout(() => {
  console.log("Waktu test habis (60s). Keluar.");
  process.exit(0);
}, 60000);
