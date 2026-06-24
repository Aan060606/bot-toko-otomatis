const { createMockCtx } = require('../helpers/mock-ctx');

describe('PAY-09 discount timing', () => {
  test('creating a discounted order does not increment used_count before payment success', async () => {
    const { User, Product, Discount } = require('../../database');
    const store = require('../../store');

    await User.create({ _id: 301, first_name: 'Buyer', purchase_count: 0 });
    await Product.create({ _id: 'PROD-DISC', name: 'Discount Product', price: 10000, type: 'AUTO', active: 1 });
    const discount = await Discount.create({
      code: 'NEWUSER',
      type: 'FIXED',
      value: 1000,
      trigger_event: 'FIRST_TIME',
      max_uses: 1,
      used_count: 0,
      active: true
    });

    const applied = await store.applyAutomaticDiscount(301, 'PROD-DISC', 10000);
    await store.createOrder('DON-DISC', 301, 9000, [{ product_id: 'PROD-DISC', quantity: 1, price: 10000 }], applied._id);

    const afterPending = await Discount.findById(discount._id).lean();
    expect(afterPending.used_count).toBe(0);
  });

  test('payment success increments discount used_count at most once for the same order', async () => {
    const { User, Product, Stock, Order, OrderItem, Discount } = require('../../database');
    const { onPaymentSuccess } = require('../../index');

    await User.create({ _id: 302, first_name: 'Buyer', purchase_count: 0 });
    await Product.create({ _id: 'PROD-DISC-SUCCESS', name: 'Discount Success Product', price: 10000, type: 'AUTO', active: 1 });
    await Stock.create({ product_id: 'PROD-DISC-SUCCESS', content: 'DISC-STOCK', status: 'AVAILABLE' });
    const discount = await Discount.create({
      code: 'ONCE',
      type: 'FIXED',
      value: 1000,
      trigger_event: 'ALL',
      max_uses: 1,
      used_count: 0,
      active: true
    });
    await Order.create({ _id: 'ORD-DISC-SUCCESS', donation_id: 'DON-DISC-SUCCESS', user_id: 302, total_amount: 9000, status: 'PENDING', discount_id: discount._id });
    await OrderItem.create({ order_id: 'ORD-DISC-SUCCESS', product_id: 'PROD-DISC-SUCCESS', quantity: 1, price: 10000 });

    const ctx = createMockCtx({ userId: 302, chatId: 302 });
    await onPaymentSuccess(ctx, 302, 123, 'DON-DISC-SUCCESS', 'ORD-DISC-SUCCESS');
    await onPaymentSuccess(ctx, 302, 123, 'DON-DISC-SUCCESS', 'ORD-DISC-SUCCESS');

    const afterSuccess = await Discount.findById(discount._id).lean();
    expect(afterSuccess.used_count).toBe(1);
  });
});
