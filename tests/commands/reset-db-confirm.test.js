const { createMockCtx } = require('../helpers/mock-ctx');

describe('SEC-07 /reset_db CONFIRM guard', () => {
  test('normal user is rejected even with CONFIRM', async () => {
    const { User } = require('../../database');
    const { handleResetDb } = require('../../index');

    await User.create({ _id: 401, first_name: 'Should Stay' });
    const ctx = createMockCtx({ userId: 222222, text: '/reset_db CONFIRM' });

    await handleResetDb(ctx);

    expect(await User.countDocuments()).toBe(1);
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  test('admin without CONFIRM receives warning and data is preserved', async () => {
    const { User } = require('../../database');
    const { handleResetDb } = require('../../index');

    await User.create({ _id: 402, first_name: 'Should Stay' });
    const ctx = createMockCtx({ userId: 111111, text: '/reset_db' });

    await handleResetDb(ctx);

    expect(await User.countDocuments()).toBe(1);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('/reset_db CONFIRM'), expect.any(Object));
  });
});
