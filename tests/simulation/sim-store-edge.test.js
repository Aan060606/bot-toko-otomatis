/**
 * SIM-01: Simulasi Error Handling — Berbagai kondisi edge di store.js
 * Menguji: stok habis, order ganda, diskon expired, cart kosong, dll.
 */

describe('SIM-01 store.js — Error & Edge Case Handling', () => {
  let User, Product, Stock, Order, OrderItem, Discount, Cart, UserEvent, store;

  beforeAll(() => {
    // Require SETELAH MongoMemoryServer set MONGODB_URI (via jest.setup)
    ({ User, Product, Stock, Order, OrderItem, Discount, Cart, UserEvent } = require('../../database'));
    store = require('../../store');
  });

  // ─── STOK ────────────────────────────────────────────────────
  describe('Stok Edge Cases', () => {
    test('SIM-01a: fulfillOrder saat stok kosong total → kembalikan pesan "Habis"', async () => {
      await User.create({ _id: 5001, first_name: 'SimUser', purchase_count: 0 });
      await Product.create({ _id: 'PROD-SIM-EMPTY', name: 'Produk Habis', price: 50000, type: 'AUTO', active: 1 });
      // Tidak ada Stock yang dibuat — stok benar-benar kosong
      await Order.create({ _id: 'ORD-SIM-EMPTY', donation_id: 'DON-EMPTY', user_id: 5001, total_amount: 50000, status: 'PENDING' });
      await OrderItem.create({ order_id: 'ORD-SIM-EMPTY', product_id: 'PROD-SIM-EMPTY', quantity: 1, price: 50000 });

      const result = await store.fulfillOrder('ORD-SIM-EMPTY');
      expect(result).toHaveLength(1);
      expect(result[0].content).toMatch(/Habis stok/);
    });

    test('SIM-01b: fulfillOrder dengan quantity 2, stok hanya 1 → satu berhasil satu habis', async () => {
      await User.create({ _id: 5002, first_name: 'SimUser2', purchase_count: 0 });
      await Product.create({ _id: 'PROD-SIM-QTY', name: 'Produk Qty', price: 50000, type: 'AUTO', active: 1 });
      await Stock.create({ product_id: 'PROD-SIM-QTY', content: 'https://t.me/+valid_link', status: 'AVAILABLE' });
      await Order.create({ _id: 'ORD-SIM-QTY', donation_id: 'DON-QTY', user_id: 5002, total_amount: 100000, status: 'PENDING' });
      await OrderItem.create({ order_id: 'ORD-SIM-QTY', product_id: 'PROD-SIM-QTY', quantity: 2, price: 50000 });

      const result = await store.fulfillOrder('ORD-SIM-QTY');
      expect(result).toHaveLength(2);
      // Item pertama dapat link, item kedua pesan habis
      const delivered = result.filter(r => r.content.startsWith('https://'));
      const exhausted = result.filter(r => r.content.includes('Habis'));
      expect(delivered.length).toBe(1);
      expect(exhausted.length).toBe(1);
    });

    test('SIM-01c: fulfillOrder dipanggil 2x (idempotency) → stok tidak diklaim ganda', async () => {
      await User.create({ _id: 5003, first_name: 'SimUser3', purchase_count: 0 });
      await Product.create({ _id: 'PROD-SIM-IDEM', name: 'Produk Idem', price: 60000, type: 'AUTO', active: 1 });
      await Stock.create({ product_id: 'PROD-SIM-IDEM', content: 'https://t.me/+idempotent_link', status: 'AVAILABLE' });
      await Order.create({ _id: 'ORD-SIM-IDEM', donation_id: 'DON-IDEM', user_id: 5003, total_amount: 60000, status: 'PENDING' });
      await OrderItem.create({ order_id: 'ORD-SIM-IDEM', product_id: 'PROD-SIM-IDEM', quantity: 1, price: 60000 });

      const result1 = await store.fulfillOrder('ORD-SIM-IDEM');
      const result2 = await store.fulfillOrder('ORD-SIM-IDEM'); // panggil 2x

      // Panggilan ke-2 harus return content yang sama (OrderItem.fulfilled sudah = 1, tapi loop masih jalan)
      // Yang penting: stok SOLD hanya 1, bukan 2
      const soldCount = await Stock.countDocuments({ product_id: 'PROD-SIM-IDEM', status: 'SOLD' });
      expect(soldCount).toBe(1);
    });
  });

  // ─── CART ────────────────────────────────────────────────────
  describe('Cart Edge Cases', () => {
    test('SIM-01d: getCartTotal cart kosong → return 0', async () => {
      await User.create({ _id: 5010, first_name: 'CartUser', purchase_count: 0 });
      const total = await store.getCartTotal(5010);
      expect(total).toBe(0);
    });

    test('SIM-01e: addToCart produk sama 2x → quantity bertambah, bukan duplikat', async () => {
      await User.create({ _id: 5011, first_name: 'CartUser2', purchase_count: 0 });
      await Product.create({ _id: 'PROD-SIM-CART', name: 'Produk Cart', price: 30000, type: 'AUTO', active: 1 });

      await store.addToCart(5011, 'PROD-SIM-CART');
      await store.addToCart(5011, 'PROD-SIM-CART'); // tambah 2x

      const cartItems = await Cart.find({ user_id: 5011 }).lean();
      expect(cartItems).toHaveLength(1); // tetap 1 row, bukan 2
      expect(cartItems[0].quantity).toBe(2); // quantity 2
    });

    test('SIM-01f: clearCart → cart benar-benar kosong setelahnya', async () => {
      await User.create({ _id: 5012, first_name: 'CartUser3', purchase_count: 0 });
      await Product.create({ _id: 'PROD-SIM-CLEAR', name: 'Produk Clear', price: 30000, type: 'AUTO', active: 1 });
      await store.addToCart(5012, 'PROD-SIM-CLEAR');

      await store.clearCart(5012);

      const cartItems = await Cart.find({ user_id: 5012 }).lean();
      expect(cartItems).toHaveLength(0);
    });
  });

  // ─── DISKON ──────────────────────────────────────────────────
  describe('Diskon Edge Cases', () => {
    test('SIM-01g: applyAutomaticDiscount — user tidak ditemukan → null', async () => {
      const result = await store.applyAutomaticDiscount(99999, 'PROD-X', 100000);
      expect(result).toBeNull();
    });

    test('SIM-01h: applyAutomaticDiscount — diskon sudah expired → tidak berlaku', async () => {
      await User.create({ _id: 5020, first_name: 'DiscUser', purchase_count: 0, joined_at: new Date() });
      await Product.create({ _id: 'PROD-SIM-DISC', name: 'Produk Disc', price: 100000, type: 'AUTO', active: 1 });
      await Discount.create({
        target_user_id: 5020, type: 'PERCENTAGE', value: 50,
        active: true,
        valid_until: new Date(Date.now() - 1000) // expired 1 detik lalu
      });

      const result = await store.applyAutomaticDiscount(5020, 'PROD-SIM-DISC', 100000);
      expect(result).toBeNull(); // expired tidak berlaku
    });

    test('SIM-01i: applyAutomaticDiscount — max_uses sudah tercapai → tidak berlaku', async () => {
      await User.create({ _id: 5021, first_name: 'DiscUser2', purchase_count: 0, joined_at: new Date() });
      await Discount.create({
        target_user_id: 5021, type: 'PERCENTAGE', value: 30,
        active: true, max_uses: 1, used_count: 1, // sudah terpakai
        valid_until: new Date(Date.now() + 86400000)
      });

      const result = await store.applyAutomaticDiscount(5021, 'PROD-ANY', 100000);
      expect(result).toBeNull();
    });

    test('SIM-01j: applyAutomaticDiscount — 2 diskon aktif → pilih yang terbesar', async () => {
      await User.create({ _id: 5022, first_name: 'DiscUser3', purchase_count: 0, joined_at: new Date() });
      await Product.create({ _id: 'PROD-SIM-BEST', name: 'Produk Best', price: 100000, type: 'AUTO', active: 1 });
      // Diskon 20%
      await Discount.create({ target_user_id: 5022, type: 'PERCENTAGE', value: 20, active: true, valid_until: new Date(Date.now() + 86400000) });
      // Diskon 50%
      await Discount.create({ target_user_id: 5022, type: 'PERCENTAGE', value: 50, active: true, valid_until: new Date(Date.now() + 86400000) });

      const result = await store.applyAutomaticDiscount(5022, 'PROD-SIM-BEST', 100000);
      expect(result).not.toBeNull();
      expect(result.value).toBe(50); // pilih yang terbesar
      expect(result.deduction).toBe(50000); // 50% dari 100000
    });

    test('SIM-01k: diskon FIRST_TIME tidak berlaku untuk user yang sudah beli', async () => {
      await User.create({ _id: 5023, first_name: 'DiscUser4', purchase_count: 3 }); // sudah beli 3x
      await Discount.create({
        type: 'PERCENTAGE', value: 40, trigger_event: 'FIRST_TIME',
        active: true, valid_until: new Date(Date.now() + 86400000)
      });

      const result = await store.applyAutomaticDiscount(5023, 'PROD-ANY2', 100000);
      expect(result).toBeNull(); // purchase_count > 0, tidak eligible
    });
  });

  // ─── ORDER ────────────────────────────────────────────────────
  describe('Order Edge Cases', () => {
    test('SIM-01l: createOrder cancel order PENDING lama dengan produk yang sama', async () => {
      await User.create({ _id: 5030, first_name: 'OrderUser', purchase_count: 0 });
      await Product.create({ _id: 'PROD-SIM-OLD', name: 'Produk Old', price: 50000, type: 'AUTO', active: 1 });

      // Buat order lama
      await Order.create({ _id: 'ORD-OLD-1', donation_id: 'DON-OLD-1', user_id: 5030, total_amount: 50000, status: 'PENDING' });
      await OrderItem.create({ order_id: 'ORD-OLD-1', product_id: 'PROD-SIM-OLD', quantity: 1, price: 50000 });

      // Buat order baru dengan produk yang sama
      await store.createOrder('DON-NEW-1', 5030, 50000, [{ product_id: 'PROD-SIM-OLD', quantity: 1, price: 50000 }]);

      const oldOrder = await Order.findById('ORD-OLD-1').lean();
      expect(oldOrder.status).toBe('CANCELLED'); // order lama harus di-cancel
    });

    test('SIM-01m: createOrder dengan produk BERBEDA tidak cancel order lama', async () => {
      await User.create({ _id: 5031, first_name: 'OrderUser2', purchase_count: 0 });
      await Product.create({ _id: 'PROD-SIM-A', name: 'Produk A', price: 50000, type: 'AUTO', active: 1 });
      await Product.create({ _id: 'PROD-SIM-B', name: 'Produk B', price: 60000, type: 'AUTO', active: 1 });

      // Order lama untuk produk A
      await Order.create({ _id: 'ORD-DIFF-1', donation_id: 'DON-DIFF-1', user_id: 5031, total_amount: 50000, status: 'PENDING' });
      await OrderItem.create({ order_id: 'ORD-DIFF-1', product_id: 'PROD-SIM-A', quantity: 1, price: 50000 });

      // Order baru untuk produk B (berbeda)
      await store.createOrder('DON-DIFF-2', 5031, 60000, [{ product_id: 'PROD-SIM-B', quantity: 1, price: 60000 }]);

      const oldOrder = await Order.findById('ORD-DIFF-1').lean();
      expect(oldOrder.status).toBe('PENDING'); // tidak di-cancel karena produk berbeda
    });
  });
});
