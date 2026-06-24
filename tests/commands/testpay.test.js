const { createMockCtx } = require('../helpers/mock-ctx');

describe('ADM-07/ADM-08 /testpay safety', () => {
  test('normal user is rejected', async () => {
    const { handleTestPay } = require('../../index');
    const ctx = createMockCtx({ userId: 222222, text: '/testpay ORD-NOPE' });

    await handleTestPay(ctx);

    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Akses ditolak'), expect.any(Object));
  });

  test('admin can mark pending order success and repeated /testpay does not fulfill twice', async () => {
    const { User, Product, Stock, Order, OrderItem } = require('../../database');
    const { handleTestPay } = require('../../index');

    await User.create({ _id: 111111, first_name: 'Admin' });
    await Product.create({ _id: 'PROD-TESTPAY', name: 'Testpay Product', price: 1000, type: 'AUTO', active: 1 });
    await Stock.create({ product_id: 'PROD-TESTPAY', content: 'TESTPAY-STOCK', status: 'AVAILABLE' });
    await Order.create({ _id: 'ORD-TESTPAY', donation_id: 'DON-TESTPAY', user_id: 111111, total_amount: 1000, status: 'PENDING' });
    await OrderItem.create({ order_id: 'ORD-TESTPAY', product_id: 'PROD-TESTPAY', quantity: 1, price: 1000 });

    const firstCtx = createMockCtx({ userId: 111111, text: '/testpay ORD-TESTPAY' });
    await handleTestPay(firstCtx);

    const secondCtx = createMockCtx({ userId: 111111, text: '/testpay ORD-TESTPAY' });
    await handleTestPay(secondCtx);

    const order = await Order.findById('ORD-TESTPAY').lean();
    const item = await OrderItem.findOne({ order_id: 'ORD-TESTPAY' }).lean();

    expect(order.status).toBe('SUCCESS');
    expect(item.fulfilled).toBe(1);
    expect(secondCtx.reply).toHaveBeenCalledWith(expect.stringContaining('sudah berstatus SUCCESS'));
  });
});
