describe('ORD-01 order id uniqueness', () => {
  test('createOrder does not collide when multiple orders are created in the same millisecond', async () => {
    const { Product } = require('../../database');
    const store = require('../../store');
    const originalNow = Date.now;

    await Product.create({ _id: 'PROD-ORDER-ID', name: 'Order ID Product', price: 1000, type: 'AUTO', active: 1 });
    jest.spyOn(Date, 'now').mockReturnValue(1234567890);

    try {
      const [first, second] = await Promise.all([
        store.createOrder('DON-A', 201, 1000, [{ product_id: 'PROD-ORDER-ID', quantity: 1, price: 1000 }]),
        store.createOrder('DON-B', 202, 1000, [{ product_id: 'PROD-ORDER-ID', quantity: 1, price: 1000 }])
      ]);

      expect(new Set([first, second]).size).toBe(2);
    } finally {
      Date.now = originalNow;
      jest.restoreAllMocks();
    }
  });
});
