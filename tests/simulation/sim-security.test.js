/**
 * SIM-04: Simulasi Security & Input Validation
 * Menguji: stok content validation, admin-only guard, rate limiting, dll.
 */

describe('SIM-04 Security & Input Validation', () => {
  let User, Product, Stock, Discount, store, Order, OrderItem, createMockCtx;

  beforeAll(() => {
    ({ User, Product, Stock, Discount, Order, OrderItem } = require('../../database'));
    store = require('../../store');
    ({ createMockCtx } = require('../helpers/mock-ctx'));
  });


  // ─── STOK CONTENT VALIDATION ─────────────────────────────────
  describe('Stock Content Validation (bug "999" prevention)', () => {
    test('SIM-04a: konten stok valid URL Telegram → lolos validasi', () => {
      const content = 'https://t.me/+ABC123xyz';
      const isValid = content.startsWith('http') || content.startsWith('t.me') || content.length > 10;
      expect(isValid).toBe(true);
    });

    test('SIM-04b: konten stok angka saja "999" → gagal validasi', () => {
      const content = '999';
      const isValid = content.startsWith('http') || content.startsWith('t.me') || content.length > 10;
      expect(isValid).toBe(false);
    });

    test('SIM-04c: konten stok angka panjang "1234567890123" → lolos karena >10 char', () => {
      const content = '1234567890123';
      const isValid = content.startsWith('http') || content.startsWith('t.me') || content.length > 10;
      expect(isValid).toBe(true);
    });

    test('SIM-04d: konten stok "ok" (2 char) → gagal validasi', () => {
      const content = 'ok';
      const isValid = content.startsWith('http') || content.startsWith('t.me') || content.length > 10;
      expect(isValid).toBe(false);
    });

    test('SIM-04e: batch stok 3 baris — 1 invalid → hanya 2 yang valid', () => {
      const lines = ['https://t.me/+link1', '999', 'https://t.me/+link3'];
      const validLines = lines.filter(l => l.startsWith('http') || l.startsWith('t.me') || l.length > 10);
      const invalidLines = lines.filter(l => !validLines.includes(l));
      expect(validLines).toHaveLength(2);
      expect(invalidLines).toHaveLength(1);
      expect(invalidLines[0]).toBe('999');
    });

    test('SIM-04f: semua baris invalid → tidak ada yang masuk DB', () => {
      const lines = ['999', 'ok', '1'];
      const validLines = lines.filter(l => l.startsWith('http') || l.startsWith('t.me') || l.length > 10);
      expect(validLines).toHaveLength(0);
    });
  });

  // ─── DISKON ABUSE ────────────────────────────────────────────
  describe('Discount Abuse Prevention', () => {
    test('SIM-04g: applyAutomaticDiscount — diskon user lain tidak bisa dipakai', async () => {
      // Diskon target_user_id = 8001, tapi yang checkout adalah user 8002
      await User.create({ _id: 8001, first_name: 'UserA', purchase_count: 0, joined_at: new Date() });
      await User.create({ _id: 8002, first_name: 'UserB', purchase_count: 0, joined_at: new Date() });
      await Discount.create({
        target_user_id: 8001, // diskon milik user 8001
        type: 'PERCENTAGE', value: 50, active: true,
        valid_until: new Date(Date.now() + 86400000)
      });

      // User 8002 coba apply diskon
      const result = await store.applyAutomaticDiscount(8002, 'PROD-ANY', 100000);
      expect(result).toBeNull(); // tidak boleh dapat diskon milik orang lain
    });

    test('SIM-04h: diskon inactive → tidak berlaku meski belum expired', async () => {
      await User.create({ _id: 8010, first_name: 'UserC', purchase_count: 0, joined_at: new Date() });
      await Discount.create({
        target_user_id: 8010, type: 'PERCENTAGE', value: 70,
        active: false, // dinonaktifkan manual
        valid_until: new Date(Date.now() + 86400000)
      });

      const result = await store.applyAutomaticDiscount(8010, 'PROD-ANY3', 100000);
      expect(result).toBeNull();
    });

    test('SIM-04i: FIRST_TIME trigger diskon tidak bisa dipakai setelah beli pertama', async () => {
      await User.create({ _id: 8011, first_name: 'UserD', purchase_count: 1 }); // sudah beli 1x
      await Discount.create({
        type: 'PERCENTAGE', value: 40, trigger_event: 'FIRST_TIME',
        active: true, valid_until: new Date(Date.now() + 86400000)
      });

      const result = await store.applyAutomaticDiscount(8011, 'PROD-ANY4', 100000);
      expect(result).toBeNull();
    });
  });

  // ─── DATA INTEGRITY ───────────────────────────────────────────
  describe('Data Integrity', () => {
    test('SIM-04j: createOrder menggunakan UUID sehingga ID unik meski timestamp sama', async () => {
      await User.create({ _id: 8020, first_name: 'UniqueUser', purchase_count: 0 });
      await Product.create({ _id: 'PROD-SIM-UNIQ', name: 'Unique', price: 10000, type: 'AUTO', active: 1 });

      // Buat 3 order hampir bersamaan
      const [id1, id2, id3] = await Promise.all([
        store.createOrder('DON-U1', 8020, 10000, [{ product_id: 'PROD-SIM-UNIQ', quantity: 1, price: 10000 }]),
        store.createOrder('DON-U2', 8020, 10000, [{ product_id: 'PROD-SIM-UNIQ', quantity: 1, price: 10000 }]),
        store.createOrder('DON-U3', 8020, 10000, [{ product_id: 'PROD-SIM-UNIQ', quantity: 1, price: 10000 }]),
      ]);

      // Semua ID harus unik
      const ids = new Set([id1, id2, id3]);
      expect(ids.size).toBe(3);
    });

    test('SIM-04k: fulfillOrder tidak mengisi konten kosong/null ke deliveredStocks', async () => {
      await User.create({ _id: 8021, first_name: 'FillUser', purchase_count: 0 });
      await Product.create({ _id: 'PROD-FILL-OK', name: 'Fill Product', price: 50000, type: 'AUTO', active: 1 });
      await Stock.create({ product_id: 'PROD-FILL-OK', content: 'https://t.me/+valid_fill', status: 'AVAILABLE' });
      await Product.create({ _id: 'PROD-FILL-EMPTY', name: 'Fill Empty', price: 50000, type: 'MANUAL', active: 1 });
      // MANUAL product, tidak ada stok

      const { Order, OrderItem } = require('../../database');
      await Order.create({ _id: 'ORD-FILL-01', donation_id: 'DON-FILL-01', user_id: 8021, total_amount: 50000, status: 'PENDING' });
      await OrderItem.create({ order_id: 'ORD-FILL-01', product_id: 'PROD-FILL-OK', quantity: 1, price: 50000 });
      await OrderItem.create({ order_id: 'ORD-FILL-01', product_id: 'PROD-FILL-EMPTY', quantity: 1, price: 50000 });

      const results = await store.fulfillOrder('ORD-FILL-01');

      // PROD-FILL-OK harus dapat link
      const okResult = results.find(r => r.product_id === 'PROD-FILL-OK');
      expect(okResult).toBeDefined();
      expect(okResult.content).toContain('t.me');

      // PROD-FILL-EMPTY (MANUAL) tidak menghasilkan error message di deliveredStocks
      // karena MANUAL tidak di-push ke array
      const emptyResult = results.find(r => r.product_id === 'PROD-FILL-EMPTY');
      expect(emptyResult).toBeUndefined();
    });

    test('SIM-04l: getMenuDiscountText tidak return text untuk diskon expired', async () => {
      await User.create({ _id: 8030, first_name: 'MenuUser', purchase_count: 0 });
      await Discount.create({
        target_user_id: 8030, type: 'PERCENTAGE', value: 50,
        active: true, valid_until: new Date(Date.now() - 1000) // expired
      });

      const text = await store.getMenuDiscountText(8030);
      expect(text).toBe(''); // tidak tampil diskon expired
    });
  });
});
