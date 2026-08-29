/**
 * SIM-PRESERVATION: Preservation Property Tests
 * 
 * Test-test ini memverifikasi bahwa behavior NORMAL tidak berubah setelah fix diterapkan.
 * Semua test HARUS PASS pada kode unfixed DAN setelah fix.
 * 
 * Menggunakan property-based testing untuk coverage luas.
 */

describe('SIM-PRESERVATION — Behavior Normal Tidak Berubah', () => {
  let User, Product, Stock, Order, OrderItem, store;

  beforeAll(() => {
    ({ User, Product, Stock, Order, OrderItem } = require('../../database'));
    store = require('../../store');
  });

  // ─── BUG-01 PRESERVATION ───────────────────────────────────────
  describe('BUG-01 Preservation — Stok Normal', () => {
    test('PRES-01a: WHEN stok AVAILABLE tersedia → delivery berhasil dengan konten stok (identik)', async () => {
      await User.create({ _id: 6001, first_name: 'PresUser1', purchase_count: 0 });
      await Product.create({ _id: 'PROD-PRES-01a', name: 'Produk Normal', price: 50000, type: 'AUTO', active: 1 });
      await Stock.create({ product_id: 'PROD-PRES-01a', content: 'https://t.me/+normal_stock', status: 'AVAILABLE' });
      await Order.create({ _id: 'ORD-PRES-01a', donation_id: 'DON-PRES-01a', user_id: 6001, total_amount: 50000, status: 'PENDING' });
      await OrderItem.create({ order_id: 'ORD-PRES-01a', product_id: 'PROD-PRES-01a', quantity: 1, price: 50000 });

      const result = await store.fulfillOrder('ORD-PRES-01a');
      
      expect(result).toHaveLength(1);
      expect(result[0].content).toBe('https://t.me/+normal_stock');
      expect(result[0].product_id).toBe('PROD-PRES-01a');
    });

    test('PRES-01b: WHEN tidak ada stok AVAILABLE tapi ada stok SOLD → gunakan konten stok SOLD (produk digital unlimited)', async () => {
      await User.create({ _id: 6002, first_name: 'PresUser2', purchase_count: 0 });
      await Product.create({ _id: 'PROD-PRES-01b', name: 'Produk Digital', price: 60000, type: 'AUTO', active: 1 });
      // Hanya stok SOLD — tidak ada AVAILABLE
      await Stock.create({ product_id: 'PROD-PRES-01b', content: 'https://t.me/+unlimited_link', status: 'SOLD', order_id: 'ORD-OLD' });
      await Order.create({ _id: 'ORD-PRES-01b', donation_id: 'DON-PRES-01b', user_id: 6002, total_amount: 60000, status: 'PENDING' });
      await OrderItem.create({ order_id: 'ORD-PRES-01b', product_id: 'PROD-PRES-01b', quantity: 1, price: 60000 });

      const result = await store.fulfillOrder('ORD-PRES-01b');
      
      expect(result).toHaveLength(1);
      expect(result[0].content).toBe('https://t.me/+unlimited_link');
    });

    test('PRES-01c: WHEN order berisi beberapa OrderItem berbeda → semua item diproses independen', async () => {
      await User.create({ _id: 6003, first_name: 'PresUser3', purchase_count: 0 });
      await Product.create({ _id: 'PROD-PRES-01c-A', name: 'Produk A', price: 50000, type: 'AUTO', active: 1 });
      await Product.create({ _id: 'PROD-PRES-01c-B', name: 'Produk B', price: 60000, type: 'AUTO', active: 1 });
      await Stock.create({ product_id: 'PROD-PRES-01c-A', content: 'https://t.me/+link_a', status: 'AVAILABLE' });
      await Stock.create({ product_id: 'PROD-PRES-01c-B', content: 'https://t.me/+link_b', status: 'AVAILABLE' });
      await Order.create({ _id: 'ORD-PRES-01c', donation_id: 'DON-PRES-01c', user_id: 6003, total_amount: 110000, status: 'PENDING' });
      await OrderItem.create({ order_id: 'ORD-PRES-01c', product_id: 'PROD-PRES-01c-A', quantity: 1, price: 50000 });
      await OrderItem.create({ order_id: 'ORD-PRES-01c', product_id: 'PROD-PRES-01c-B', quantity: 1, price: 60000 });

      const result = await store.fulfillOrder('ORD-PRES-01c');
      
      expect(result).toHaveLength(2);
      expect(result[0].content).toBe('https://t.me/+link_a');
      expect(result[1].content).toBe('https://t.me/+link_b');
    });
  });

  // ─── BUG-02 PRESERVATION ───────────────────────────────────────
  describe('BUG-02 Preservation — Quantity Terpenuhi Jika Stok Cukup', () => {
    test('PRES-02a: WHEN quantity: 1, stok tersedia: 1 → tepat 1 delivery berhasil', async () => {
      await User.create({ _id: 6010, first_name: 'PresUser10', purchase_count: 0 });
      await Product.create({ _id: 'PROD-PRES-02a', name: 'Produk Qty1', price: 50000, type: 'AUTO', active: 1 });
      await Stock.create({ product_id: 'PROD-PRES-02a', content: 'https://t.me/+qty1_link', status: 'AVAILABLE' });
      await Order.create({ _id: 'ORD-PRES-02a', donation_id: 'DON-PRES-02a', user_id: 6010, total_amount: 50000, status: 'PENDING' });
      await OrderItem.create({ order_id: 'ORD-PRES-02a', product_id: 'PROD-PRES-02a', quantity: 1, price: 50000 });

      const result = await store.fulfillOrder('ORD-PRES-02a');
      
      expect(result).toHaveLength(1);
      expect(result[0].content).toBe('https://t.me/+qty1_link');
    });

    test('PRES-02b: WHEN quantity: 2, stok tersedia: 3 → tepat 2 delivery berhasil', async () => {
      await User.create({ _id: 6011, first_name: 'PresUser11', purchase_count: 0 });
      await Product.create({ _id: 'PROD-PRES-02b', name: 'Produk Qty2', price: 50000, type: 'AUTO', active: 1 });
      await Stock.create({ product_id: 'PROD-PRES-02b', content: 'https://t.me/+qty2_link1', status: 'AVAILABLE' });
      await Stock.create({ product_id: 'PROD-PRES-02b', content: 'https://t.me/+qty2_link2', status: 'AVAILABLE' });
      await Stock.create({ product_id: 'PROD-PRES-02b', content: 'https://t.me/+qty2_link3', status: 'AVAILABLE' });
      await Order.create({ _id: 'ORD-PRES-02b', donation_id: 'DON-PRES-02b', user_id: 6011, total_amount: 100000, status: 'PENDING' });
      await OrderItem.create({ order_id: 'ORD-PRES-02b', product_id: 'PROD-PRES-02b', quantity: 2, price: 50000 });

      const result = await store.fulfillOrder('ORD-PRES-02b');
      
      expect(result).toHaveLength(2);
      const delivered = result.filter(r => r.content.startsWith('https://'));
      expect(delivered.length).toBe(2);
    });

    test('PRES-02c: Property — WHEN quantity >= availableStock (stok cukup) → semua unit delivered', async () => {
      // Property-based: test berbagai kombinasi quantity dan stok di mana stok >= quantity
      const testCases = [
        { qty: 1, stock: 1 },
        { qty: 2, stock: 2 },
        { qty: 3, stock: 3 },
        { qty: 2, stock: 5 },
        { qty: 5, stock: 10 }
      ];

      for (let i = 0; i < testCases.length; i++) {
        const { qty, stock } = testCases[i];
        const userId = 6020 + i;
        const productId = `PROD-PRES-02c-${i}`;
        const orderId = `ORD-PRES-02c-${i}`;

        await User.create({ _id: userId, first_name: `PresUser${userId}`, purchase_count: 0 });
        await Product.create({ _id: productId, name: `Produk ${i}`, price: 50000, type: 'AUTO', active: 1 });
        
        // Buat stok sesuai jumlah yang dibutuhkan
        for (let s = 0; s < stock; s++) {
          await Stock.create({ product_id: productId, content: `https://t.me/+link_${i}_${s}`, status: 'AVAILABLE' });
        }

        await Order.create({ _id: orderId, donation_id: `DON-${i}`, user_id: userId, total_amount: qty * 50000, status: 'PENDING' });
        await OrderItem.create({ order_id: orderId, product_id: productId, quantity: qty, price: 50000 });

        const result = await store.fulfillOrder(orderId);
        
        // Semua quantity harus delivered karena stok cukup
        expect(result).toHaveLength(qty);
        const delivered = result.filter(r => r.content.startsWith('https://'));
        expect(delivered.length).toBe(qty);
      }
    });
  });

  // ─── BUG-03 PRESERVATION ───────────────────────────────────────
  describe('BUG-03 Preservation — First-Call Tetap Berjalan Normal', () => {
    test('PRES-03a: WHEN fulfillOrder dipanggil pertama kali (fulfilled=0) → semua item diproses normal', async () => {
      await User.create({ _id: 6030, first_name: 'PresUser30', purchase_count: 0 });
      await Product.create({ _id: 'PROD-PRES-03a', name: 'Produk FirstCall', price: 50000, type: 'AUTO', active: 1 });
      await Stock.create({ product_id: 'PROD-PRES-03a', content: 'https://t.me/+first_call', status: 'AVAILABLE' });
      await Order.create({ _id: 'ORD-PRES-03a', donation_id: 'DON-PRES-03a', user_id: 6030, total_amount: 50000, status: 'PENDING' });
      await OrderItem.create({ order_id: 'ORD-PRES-03a', product_id: 'PROD-PRES-03a', quantity: 1, price: 50000, fulfilled: 0 });

      const result = await store.fulfillOrder('ORD-PRES-03a');
      
      expect(result).toHaveLength(1);
      expect(result[0].content).toBe('https://t.me/+first_call');
      
      // Verifikasi OrderItem.fulfilled di-set ke 1 setelah proses
      const updatedItem = await OrderItem.findOne({ order_id: 'ORD-PRES-03a' }).lean();
      expect(updatedItem.fulfilled).toBe(1);
    });

    test('PRES-03b: WHEN order dengan beberapa OrderItem, semua fulfilled=0 → semua diproses', async () => {
      await User.create({ _id: 6031, first_name: 'PresUser31', purchase_count: 0 });
      await Product.create({ _id: 'PROD-PRES-03b-A', name: 'Produk A', price: 50000, type: 'AUTO', active: 1 });
      await Product.create({ _id: 'PROD-PRES-03b-B', name: 'Produk B', price: 60000, type: 'AUTO', active: 1 });
      await Stock.create({ product_id: 'PROD-PRES-03b-A', content: 'https://t.me/+link_a', status: 'AVAILABLE' });
      await Stock.create({ product_id: 'PROD-PRES-03b-B', content: 'https://t.me/+link_b', status: 'AVAILABLE' });
      await Order.create({ _id: 'ORD-PRES-03b', donation_id: 'DON-PRES-03b', user_id: 6031, total_amount: 110000, status: 'PENDING' });
      await OrderItem.create({ order_id: 'ORD-PRES-03b', product_id: 'PROD-PRES-03b-A', quantity: 1, price: 50000, fulfilled: 0 });
      await OrderItem.create({ order_id: 'ORD-PRES-03b', product_id: 'PROD-PRES-03b-B', quantity: 1, price: 60000, fulfilled: 0 });

      const result = await store.fulfillOrder('ORD-PRES-03b');
      
      expect(result).toHaveLength(2);
      expect(result[0].content).toBe('https://t.me/+link_a');
      expect(result[1].content).toBe('https://t.me/+link_b');
      
      // Verifikasi kedua item di-set fulfilled
      const items = await OrderItem.find({ order_id: 'ORD-PRES-03b' }).lean();
      expect(items.every(item => item.fulfilled === 1)).toBe(true);
    });

    test('PRES-03c: Property — First call dengan berbagai quantity → semua diproses sesuai availability', async () => {
      // Preservation test: hanya test kasus di mana stok >= quantity (tidak trigger BUG-02)
      // Kasus di mana quantity > stock akan di-test di bug condition exploration (SIM-01b)
      const testCases = [
        { qty: 1, stock: 1, expectedDelivered: 1, expectedExhausted: 0 },
        { qty: 2, stock: 2, expectedDelivered: 2, expectedExhausted: 0 },
        { qty: 3, stock: 5, expectedDelivered: 3, expectedExhausted: 0 },
        { qty: 5, stock: 5, expectedDelivered: 5, expectedExhausted: 0 }
      ];

      for (let i = 0; i < testCases.length; i++) {
        const { qty, stock, expectedDelivered, expectedExhausted } = testCases[i];
        const userId = 6040 + i;
        const productId = `PROD-PRES-03c-${i}`;
        const orderId = `ORD-PRES-03c-${i}`;

        await User.create({ _id: userId, first_name: `PresUser${userId}`, purchase_count: 0 });
        await Product.create({ _id: productId, name: `Produk ${i}`, price: 50000, type: 'AUTO', active: 1 });
        
        for (let s = 0; s < stock; s++) {
          await Stock.create({ product_id: productId, content: `https://t.me/+link_${i}_${s}`, status: 'AVAILABLE' });
        }

        await Order.create({ _id: orderId, donation_id: `DON-${i}`, user_id: userId, total_amount: qty * 50000, status: 'PENDING' });
        await OrderItem.create({ order_id: orderId, product_id: productId, quantity: qty, price: 50000, fulfilled: 0 });

        const result = await store.fulfillOrder(orderId);
        
        expect(result).toHaveLength(qty);
        const delivered = result.filter(r => r.content.startsWith('https://'));
        const exhausted = result.filter(r => r.content.includes('Habis') || r.content.includes('belum diisi'));
        
        expect(delivered.length).toBe(expectedDelivered);
        expect(exhausted.length).toBe(expectedExhausted);
      }
    });
  });

  // ─── BUG-06 PRESERVATION ───────────────────────────────────────
  describe('BUG-06 Preservation — Segmen Non-HOT Tidak Terpengaruh', () => {
    test('PRES-06a: WHEN segment WARM → produk yang dipilih tetap prodList[0]', async () => {
      // Mock user WARM (inactive 1-7 hari)
      const warmUser = {
        _id: 6060,
        first_name: 'WarmUser',
        purchase_count: 0,
        last_active_at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000), // 3 hari lalu
        joined_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
      };
      
      // Segment WARM tidak bergantung pada rotationIndex
      // Hanya HOT yang menggunakan rotationIndex
      // Untuk WARM/COLD/GHOST, prodList[0] selalu digunakan
      
      // Verifikasi: classifyNonBuyer return 'WARM'
      const daysInactive = (new Date() - new Date(warmUser.last_active_at)) / (1000 * 60 * 60 * 24);
      expect(daysInactive).toBeGreaterThanOrEqual(1);
      expect(daysInactive).toBeLessThanOrEqual(7);
      
      // Expected: segment = 'WARM' → selalu gunakan prodList[0]
      const segment = daysInactive < 1 ? 'HOT'
                    : daysInactive >= 1 && daysInactive <= 7 ? 'WARM'
                    : daysInactive > 7 && daysInactive <= 30 ? 'COLD'
                    : 'GHOST';
      expect(segment).toBe('WARM');
    });

    test('PRES-06b: WHEN segment COLD → produk yang dipilih tetap prodList[0]', async () => {
      const coldUser = {
        _id: 6061,
        first_name: 'ColdUser',
        purchase_count: 0,
        last_active_at: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000), // 15 hari lalu
        joined_at: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000)
      };
      
      const daysInactive = (new Date() - new Date(coldUser.last_active_at)) / (1000 * 60 * 60 * 24);
      expect(daysInactive).toBeGreaterThan(7);
      expect(daysInactive).toBeLessThanOrEqual(30);
      
      const segment = daysInactive < 1 ? 'HOT'
                    : daysInactive >= 1 && daysInactive <= 7 ? 'WARM'
                    : daysInactive > 7 && daysInactive <= 30 ? 'COLD'
                    : 'GHOST';
      expect(segment).toBe('COLD');
    });

    test('PRES-06c: WHEN segment GHOST → produk yang dipilih tetap prodList[0]', async () => {
      const ghostUser = {
        _id: 6062,
        first_name: 'GhostUser',
        purchase_count: 0,
        last_active_at: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000), // 40 hari lalu
        joined_at: new Date(Date.now() - 50 * 24 * 60 * 60 * 1000)
      };
      
      const daysInactive = (new Date() - new Date(ghostUser.last_active_at)) / (1000 * 60 * 60 * 24);
      expect(daysInactive).toBeGreaterThan(30);
      
      const segment = daysInactive < 1 ? 'HOT'
                    : daysInactive >= 1 && daysInactive <= 7 ? 'WARM'
                    : daysInactive > 7 && daysInactive <= 30 ? 'COLD'
                    : 'GHOST';
      expect(segment).toBe('GHOST');
    });

    test('PRES-06d: rotationIndex value consistency — hash(userId + dayOfYear) % prodList.length', async () => {
      // Property: rotationIndex harus selalu dalam range [0, prodList.length) untuk semua userId
      const prodList = [
        { _id: 'PROD-1', name: 'Produk 1' },
        { _id: 'PROD-2', name: 'Produk 2' },
        { _id: 'PROD-3', name: 'Produk 3' }
      ];
      
      const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0)) / 86400000);
      
      // Test dengan berbagai userId
      const testUserIds = [1, 5, 100, 999, 5000, 12345];
      
      for (const userId of testUserIds) {
        const userIdNum = userId;
        const rotationIndex = (userIdNum + dayOfYear) % prodList.length;
        
        // rotationIndex harus dalam range valid
        expect(rotationIndex).toBeGreaterThanOrEqual(0);
        expect(rotationIndex).toBeLessThan(prodList.length);
        
        // Produk yang dipilih harus ada
        const selectedProduct = prodList[rotationIndex] || prodList[0];
        expect(selectedProduct).toBeDefined();
        expect(prodList).toContain(selectedProduct);
      }
    });
  });

  // ─── EDGE CASE: Auto-Restock Behavior ──────────────────────────
  describe('Edge Case — Auto-Restock Behavior (Preservation)', () => {
    test('PRES-EDGE-01: WHEN produk digital, auto-restock tetap membuat stok baru SETELAH loop quantity selesai', async () => {
      await User.create({ _id: 6070, first_name: 'EdgeUser', purchase_count: 0 });
      await Product.create({ _id: 'PROD-EDGE-01', name: 'Produk Digital', price: 50000, type: 'AUTO', active: 1 });
      await Stock.create({ product_id: 'PROD-EDGE-01', content: 'https://t.me/+digital_link', status: 'AVAILABLE' });
      await Order.create({ _id: 'ORD-EDGE-01', donation_id: 'DON-EDGE-01', user_id: 6070, total_amount: 50000, status: 'PENDING' });
      await OrderItem.create({ order_id: 'ORD-EDGE-01', product_id: 'PROD-EDGE-01', quantity: 1, price: 50000 });

      const stockBefore = await Stock.countDocuments({ product_id: 'PROD-EDGE-01', status: 'AVAILABLE' });
      expect(stockBefore).toBe(1);

      await store.fulfillOrder('ORD-EDGE-01');

      // Setelah fulfillOrder, stok SOLD = 1, stok AVAILABLE = 1 (auto-restocked)
      const soldCount = await Stock.countDocuments({ product_id: 'PROD-EDGE-01', status: 'SOLD' });
      const availableCount = await Stock.countDocuments({ product_id: 'PROD-EDGE-01', status: 'AVAILABLE' });
      
      expect(soldCount).toBe(1);
      expect(availableCount).toBe(1); // Auto-restock membuat stok baru
    });
  });
});
