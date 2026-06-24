describe('BOT-08 getActiveProducts', () => {
  test('returns active products and hides inactive products', async () => {
    const { Product } = require('../../database');
    const store = require('../../store');

    await Product.create([
      { _id: 'PROD-ACTIVE', name: 'Active', price: 1000, type: 'AUTO', active: 1 },
      { _id: 'PROD-INACTIVE', name: 'Inactive', price: 1000, type: 'AUTO', active: 0 }
    ]);

    const products = await store.getActiveProducts();

    expect(products.map((product) => product._id)).toEqual(['PROD-ACTIVE']);
  });
});
