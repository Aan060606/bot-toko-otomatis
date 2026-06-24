describe('STK-06/STK-07 atomic stock fulfillment', () => {
  test('one available stock can only be delivered to one concurrent order', async () => {
    const { Product, Stock, Order, OrderItem } = require('../../database');
    const store = require('../../store');

    await Product.create({ _id: 'PROD-RACE', name: 'Race Product', price: 1000, type: 'AUTO', active: 1 });
    await Stock.create({ product_id: 'PROD-RACE', content: 'SECRET-STOCK-1', status: 'AVAILABLE' });

    await Order.create({ _id: 'ORD-RACE-1', donation_id: 'DON-1', user_id: 101, total_amount: 1000, status: 'PENDING' });
    await Order.create({ _id: 'ORD-RACE-2', donation_id: 'DON-2', user_id: 102, total_amount: 1000, status: 'PENDING' });
    await OrderItem.create({ order_id: 'ORD-RACE-1', product_id: 'PROD-RACE', quantity: 1, price: 1000 });
    await OrderItem.create({ order_id: 'ORD-RACE-2', product_id: 'PROD-RACE', quantity: 1, price: 1000 });

    const results = await Promise.all([
      store.fulfillOrder('ORD-RACE-1'),
      store.fulfillOrder('ORD-RACE-2')
    ]);

    const delivered = results.flat().filter((item) => item.content === 'SECRET-STOCK-1');
    const stock = await Stock.findOne({ product_id: 'PROD-RACE' }).lean();

    expect(delivered).toHaveLength(1);
    expect(stock.status).toMatch(/^(SOLD|USED)$/);
  });
});
