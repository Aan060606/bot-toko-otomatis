# QA Automation

Automation ini dibuat untuk menguji area P0/P1 tanpa payment asli, tanpa Telegram real, dan tanpa database production.

## Prinsip Aman

- Test memakai `mongodb-memory-server`, bukan `MONGODB_URI` production.
- `NODE_ENV=test` mencegah `index.js` menjalankan `bot.launch()` dan HTTP server.
- Telegram context dimock di `tests/helpers/mock-ctx.js`.
- Saweria tidak dipanggil oleh test automation ini.
- Broadcast real tidak dijalankan; test CRM memakai source/static check sampai broadcast engine dipisah menjadi service yang bisa dimock penuh.

## Command

```bash
npm install
npm test
npm run test:security
npm run test:unit
npm run test:commands
npm run test:crm
npm run test:health
npm run qa:smoke
```

Strict release packaging scan:

```bash
QA_STRICT_LOCAL_SCAN=1 npm run test:security
```

Secret scan tambahan jika `gitleaks` tersedia:

```bash
npx gitleaks detect --source . --no-git
```

## Expected Saat Ini

Beberapa test diperkirakan FAIL sampai bug production diperbaiki:

- `STK-06/STK-07`: `fulfillOrder` belum atomic claim stock dan belum update stock menjadi `SOLD/USED`.
- `PAY-09`: `onPaymentSuccess` belum idempotent jika callback success terpanggil lebih dari sekali.
- `ORD-01`: order ID masih `ORD-` + `Date.now()`.
- `ADM-09`: `/fix_db` belum punya dry-run/backup/log.
- `CRM-02`: broadcast manual belum punya dry-run.
- `OPS-01`: command `/health` belum ada di source.

Fail di atas adalah evidence QA, bukan error test framework.
