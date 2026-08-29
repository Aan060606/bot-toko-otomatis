/**
 * SIM-02: Simulasi Payment & Webhook Error Handling
 * Menguji: onPaymentSuccess idempotency, webhook tanpa order, order expired, dll.
 */

describe('SIM-02 Payment & Webhook Error Handling', () => {
  let User, Product, Stock, Order, OrderItem, Discount, createMockCtx, onPaymentSuccess;

  beforeAll(() => {
    ({ User, Product, Stock, Order, OrderItem, Discount } = require('../../database'));
    ({ createMockCtx } = require('../helpers/mock-ctx'));
    ({ onPaymentSuccess } = require('../../index'));
  });


  // ─── IDEMPOTENCY ─────────────────────────────────────────────
  describe('Idempotency Guard', () => {
    test('SIM-02a: onPaymentSuccess 3x untuk order yang sama → hanya proses 1x', async () => {
      await User.create({ _id: 6001, first_name: 'PayUser', purchase_count: 0 });
      await Product.create({ _id: 'PROD-PAY-01', name: 'Pay Product', price: 50000, type: 'AUTO', active: 1 });
      await Stock.create({ product_id: 'PROD-PAY-01', content: 'https://t.me/+pay_link', status: 'AVAILABLE' });
      await Order.create({ _id: 'ORD-PAY-01', donation_id: 'DON-PAY-01', user_id: 6001, total_amount: 50000, status: 'PENDING' });
      await OrderItem.create({ order_id: 'ORD-PAY-01', product_id: 'PROD-PAY-01', quantity: 1, price: 50000 });

      const ctx = createMockCtx({ userId: 6001, chatId: 6001 });

      await onPaymentSuccess(ctx, 6001, 9999, 'DON-PAY-01', 'ORD-PAY-01');
      await onPaymentSuccess(ctx, 6001, 9999, 'DON-PAY-01', 'ORD-PAY-01');
      await onPaymentSuccess(ctx, 6001, 9999, 'DON-PAY-01', 'ORD-PAY-01');

      // Order hanya SUCCESS 1x
      const order = await Order.findById('ORD-PAY-01').lean();
      expect(order.status).toBe('SUCCESS');
      // User stats hanya naik 1x
      const user = await User.findById(6001).lean();
      expect(user.purchase_count).toBe(1);
      expect(user.total_spent).toBe(50000);
      // Stok hanya di-SOLD 1x
      const soldStocks = await Stock.countDocuments({ product_id: 'PROD-PAY-01', status: 'SOLD' });
      expect(soldStocks).toBe(1);
    });

    test('SIM-02b: onPaymentSuccess untuk order EXPIRED → tidak diproses, user stats tidak berubah', async () => {
      await User.create({ _id: 6002, first_name: 'PayUser2', purchase_count: 0 });
      await Product.create({ _id: 'PROD-PAY-02', name: 'Pay Product 2', price: 50000, type: 'AUTO', active: 1 });
      await Stock.create({ product_id: 'PROD-PAY-02', content: 'https://t.me/+pay_link_2', status: 'AVAILABLE' });
      await Order.create({ _id: 'ORD-PAY-02', donation_id: 'DON-PAY-02', user_id: 6002, total_amount: 50000, status: 'EXPIRED' }); // Sudah EXPIRED
      await OrderItem.create({ order_id: 'ORD-PAY-02', product_id: 'PROD-PAY-02', quantity: 1, price: 50000 });

      const ctx = createMockCtx({ userId: 6002, chatId: 6002 });
      await onPaymentSuccess(ctx, 6002, 9998, 'DON-PAY-02', 'ORD-PAY-02');

      const user = await User.findById(6002).lean();
      expect(user.purchase_count).toBe(0); // tidak berubah
      expect(user.total_spent).toBe(0);

      const stokSold = await Stock.countDocuments({ product_id: 'PROD-PAY-02', status: 'SOLD' });
      expect(stokSold).toBe(0); // stok tidak diklaim
    });

    test('SIM-02c: onPaymentSuccess → discount used_count naik tepat 1x meski dipanggil 3x', async () => {
      await User.create({ _id: 6003, first_name: 'PayDisc', purchase_count: 0 });
      await Product.create({ _id: 'PROD-PAY-03', name: 'Pay Disc Product', price: 100000, type: 'AUTO', active: 1 });
      await Stock.create({ product_id: 'PROD-PAY-03', content: 'https://t.me/+disc_link', status: 'AVAILABLE' });
      const disc = await Discount.create({ type: 'PERCENTAGE', value: 20, active: true, used_count: 0, max_uses: 1 });
      await Order.create({ _id: 'ORD-PAY-03', donation_id: 'DON-PAY-03', user_id: 6003, total_amount: 80000, status: 'PENDING', discount_id: disc._id });
      await OrderItem.create({ order_id: 'ORD-PAY-03', product_id: 'PROD-PAY-03', quantity: 1, price: 100000 });

      const ctx = createMockCtx({ userId: 6003, chatId: 6003 });
      await onPaymentSuccess(ctx, 6003, 9997, 'DON-PAY-03', 'ORD-PAY-03');
      await onPaymentSuccess(ctx, 6003, 9997, 'DON-PAY-03', 'ORD-PAY-03');
      await onPaymentSuccess(ctx, 6003, 9997, 'DON-PAY-03', 'ORD-PAY-03');

      const discAfter = await Discount.findById(disc._id).lean();
      expect(discAfter.used_count).toBe(1); // hanya naik 1x
    });
  });

  // ─── CONCURRENT PAYMENT ──────────────────────────────────────
  describe('Concurrent Payment Simulation', () => {
    test('SIM-02d: 5 webhook webhook masuk bersamaan untuk order yang sama → hanya 1 yang proses', async () => {
      await User.create({ _id: 6010, first_name: 'ConcUser', purchase_count: 0 });
      await Product.create({ _id: 'PROD-CONC-01', name: 'Concurrent Product', price: 50000, type: 'AUTO', active: 1 });
      await Stock.create({ product_id: 'PROD-CONC-01', content: 'https://t.me/+conc_link', status: 'AVAILABLE' });
      await Order.create({ _id: 'ORD-CONC-01', donation_id: 'DON-CONC-01', user_id: 6010, total_amount: 50000, status: 'PENDING' });
      await OrderItem.create({ order_id: 'ORD-CONC-01', product_id: 'PROD-CONC-01', quantity: 1, price: 50000 });

      const ctx = createMockCtx({ userId: 6010, chatId: 6010 });

      // 5 concurrent calls
      await Promise.all([
        onPaymentSuccess(ctx, 6010, 8888, 'DON-CONC-01', 'ORD-CONC-01'),
        onPaymentSuccess(ctx, 6010, 8888, 'DON-CONC-01', 'ORD-CONC-01'),
        onPaymentSuccess(ctx, 6010, 8888, 'DON-CONC-01', 'ORD-CONC-01'),
        onPaymentSuccess(ctx, 6010, 8888, 'DON-CONC-01', 'ORD-CONC-01'),
        onPaymentSuccess(ctx, 6010, 8888, 'DON-CONC-01', 'ORD-CONC-01'),
      ]);

      const user = await User.findById(6010).lean();
      expect(user.purchase_count).toBe(1); // hanya 1x, bukan 5x
      expect(user.total_spent).toBe(50000);

      const soldStocks = await Stock.countDocuments({ product_id: 'PROD-CONC-01', status: 'SOLD' });
      expect(soldStocks).toBe(1); // hanya 1 stok diklaim
    });
  });

  // ─── ORDER TIDAK ADA ─────────────────────────────────────────
  describe('Missing Order Handling', () => {
    test('SIM-02e: onPaymentSuccess dengan orderId yang tidak ada di DB → tidak crash', async () => {
      await User.create({ _id: 6020, first_name: 'GhostUser', purchase_count: 0 });
      const ctx = createMockCtx({ userId: 6020, chatId: 6020 });

      // Tidak boleh throw exception
      await expect(
        onPaymentSuccess(ctx, 6020, 7777, 'DON-GHOST', 'ORD-NOT-EXIST-EVER')
      ).resolves.not.toThrow();

      const user = await User.findById(6020).lean();
      expect(user.purchase_count).toBe(0); // tidak berubah
    });
  });
});
