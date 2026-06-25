# 🤖 Toko Otomatis Telegram Bot (Saweria QRIS)

> Bot Telegram E-Commerce Otomatis dengan integrasi pembayaran QRIS via Saweria, dilengkapi dengan Marketing Automation, Anti-Spam Rate Limiter, dan Auto-Backup Database ke Telegram.

---

## 📋 Daftar Isi

1. [Fitur Utama](#1-fitur-utama)
2. [Arsitektur Sistem](#2-arsitektur-sistem)
3. [Instalasi & Setup (Step-by-Step)](#3-instalasi--setup-step-by-step)
4. [Konfigurasi Environment Variables](#4-konfigurasi-environment-variables)
5. [Fitur Admin & Manajemen Produk](#5-fitur-admin--manajemen-produk)
6. [Sistem Marketing Automation](#6-sistem-marketing-automation)
7. [Keamanan & Auto-Backup](#7-keamanan--auto-backup)

---

## 1. Fitur Utama

| Fitur | Keterangan |
|-------|-----------|
| 🛒 **E-Commerce Native** | Mendukung produk digital otomatis (langsung kirim file/teks) maupun manual. |
| 💳 **Donasi QRIS Otomatis** | Generate QR Saweria langsung di Telegram dan cek status pembayaran real-time. |
| 🛡️ **Anti-Spam & Rate Limit** | Perlindungan klik massal (cooldown 3 detik) untuk mencegah server *crash* atau *ban*. |
| 🤖 **Marketing Automation** | Sistem CRM otomatis (Cart Abandonment, Cross-Sell, Drip Funnel 3 Stage). |
| ☁️ **Cloudflare Bypass** | Menggunakan Puppeteer Stealth Plugin untuk bypass proteksi Cloudflare Saweria. |
| 🗄️ **Auto-Backup Telegram** | Auto-backup database MongoDB ke format `.json.gz` dikirim via Telegram setiap jam 02:00 WIB. |

---

## 2. Arsitektur Sistem

Sistem ini terdiri dari 5 modul utama:
1. `index.js`: Pusat routing command (User & Admin), integrasi Telegram, dan polling pembayaran.
2. `store.js`: Logika keranjang belanja, checkout, dan pengiriman produk.
3. `scheduler.js`: Mesin *Cron Job* untuk Automasi Marketing dan Backup Database.
4. `database.js`: Skema database menggunakan Mongoose (MongoDB).
5. `admin.js`: User Interface (Inline Keyboard) untuk panel Admin dan statistik CRM.

---

## 3. Instalasi & Setup (Step-by-Step)

### Prasyarat
- Node.js versi 18 atau ke atas.
- Database MongoDB (bisa menggunakan MongoDB Atlas atau instalasi lokal).
- Akun Saweria yang sudah aktif fitur QRIS-nya.

### Langkah Instalasi

```bash
# 1. Clone repository ini
git clone https://github.com/Aan060606/bot-toko-otomatis.git
cd bot-toko-otomatis

# 2. Install dependencies
npm install

# 3. Buat file .env dari template
cp .env.example .env

# 4. Buka file .env dan isi konfigurasi yang dibutuhkan (Lihat bagian 4)
nano .env

# 5. Jalankan migrasi database pertama (Opsional, jika database pernah dipakai)
node migrations/drop-old-driplog-ttl.js

# 6. Jalankan Bot
npm start

# Atau gunakan PM2 untuk production agar bot tetap hidup
npm install -g pm2
pm2 start index.js --name saweria-bot
```

---

## 4. Konfigurasi Environment Variables

Buat file `.env` di root folder dengan isi berikut:

```env
# === WAJIB ===
BOT_TOKEN=Token_Bot_Dari_BotFather
MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/namadatabase

# === SAWERIA ===
SAWERIA_USERNAME=username_saweria_kamu_tanpa_at
SAWERIA_USER_ID=uuid-saweria-kamu

# === ADMIN ===
ADMIN_CHAT_ID=Chat_ID_Telegram_Admin
DEBUG=false
```

> **Cara Mendapatkan SAWERIA_USER_ID:**
> 1. Buka `https://saweria.co/username_kamu` di browser.
> 2. Tekan `F12` (Developer Tools) -> Tab **Network**.
> 3. Refresh halaman, filter dengan kata `snap`.
> 4. URL yang muncul akan berformat `/donations/snap/XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX`. Angka XXXXX tersebut adalah User ID Anda.

---

## 5. Fitur Admin & Manajemen Produk

Hanya user dengan ID yang terdaftar di `ADMIN_CHAT_ID` yang bisa mengakses menu ini.

- `/admin` — Membuka panel kontrol admin.
- `/broadcast_buyer <pesan>` — Mengirim pesan massal HANYA kepada user yang sudah pernah membeli.
- `/broadcast_nonbuyer <pesan>` — Mengirim pesan massal HANYA kepada user yang belum pernah membeli.
- `/broadcast_all <pesan>` — Mengirim pesan ke seluruh user database.
- `/creatediscount <KODE> <FIXED/PERCENTAGE> <NILAI> <TRIGGER>` — Membuat diskon otomatis (Misal: `/creatediscount PROMO FIXED 5000 FIRST_TIME`).
- `/user <user_id>` — Melihat statistik komprehensif dari pelanggan tertentu.

---

## 6. Sistem Marketing Automation

Bot ini dilengkapi dengan *CRM (Customer Relationship Management)* otomatis yang berjalan di *background* setiap jam:

1. **Cart Abandonment Recovery:** Jika user memencet tombol "Beli" namun tidak menyelesaikan pembayaran dalam 15 menit, bot akan mem-*follow-up* setelah 1 jam.
2. **Win-back Inactive Users:** Menyapa kembali user yang tidak membuka bot lebih dari 7 hari.
3. **Smart Cross-Selling:** Setelah user sukses membeli Produk A, sistem akan merekomendasikan Produk B keesokan harinya (tanpa spam).
4. **Drip Funnel 3 Stage:** Calon pembeli yang masih ragu akan diberikan edukasi berjenjang, diakhiri dengan pemberian diskon otomatis untuk mendorong konversi.

---

## 7. Keamanan & Auto-Backup

### Anti-Spam (Rate Limiting)
Sistem memiliki *cooldown* 3 detik untuk setiap tombol aksi (Callback Query). Jika user melakukan klik massal untuk membanjiri server, perintah akan ditolak secara otomatis untuk mencegah `Out Of Memory` dan pemblokiran API oleh Saweria.

### Auto-Expire Database PENDING
Transaksi yang tidak dibayar dalam 15 menit akan langsung diubah statusnya menjadi `EXPIRED` di database untuk mencegah penumpukan data.

### Auto-Backup Telegram
Anda **tidak perlu** menyewa AWS S3 atau Google Drive untuk mencadangkan database. 
Setiap hari pada pukul **02:00 WIB**, sistem akan:
1. Mengekspor seluruh database MongoDB ke dalam format JSON.
2. Mengompresi file menjadi `backup_saweria_YYYY-MM-DD.json.gz`.
3. Mengirimkan file tersebut secara rahasia sebagai lampiran dokumen ke *Private Chat* Admin di Telegram.
4. Menghapus file lokal seketika untuk menghemat memori *server/container*.
