const { createMockCtx } = require('../helpers/mock-ctx');

describe('ADM-09 /fix_db safety', () => {
  test('normal user is rejected', async () => {
    const { User } = require('../../database');
    const { handleFixDb } = require('../../index');

    await User.create({ _id: 501, first_name: 'Legacy' });
    const ctx = createMockCtx({ userId: 222222, text: '/fix_db' });

    await handleFixDb(ctx);

    expect(ctx.reply).not.toHaveBeenCalled();
    expect(await User.countDocuments()).toBe(1);
  });

  test('admin /fix_db should default to dry-run and avoid immediate mutation', async () => {
    const { User } = require('../../database');
    const { handleFixDb } = require('../../index');

    await User.collection.insertOne({ _id: 502, first_name: 'Legacy' });
    const ctx = createMockCtx({ userId: 111111, text: '/fix_db' });

    await handleFixDb(ctx);

    const user = await User.findById(502).lean();
    expect(user.purchase_count).toBeUndefined();
    expect(user.is_blocked).toBeUndefined();
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringMatching(/dry-run|preview|backup/i), expect.any(Object));
  });

  test('admin /fix_db APPLY CONFIRM should mutate data and save log', async () => {
    const { User } = require('../../database');
    const { handleFixDb } = require('../../index');
    const fs = require('fs');
    const path = require('path');

    await User.collection.insertOne({ _id: 503, first_name: 'ApplyMe' });
    const ctx = createMockCtx({ userId: 111111, text: '/fix_db APPLY CONFIRM' });

    await handleFixDb(ctx);

    const user = await User.findById(503).lean();
    expect(user.purchase_count).toBe(0);
    expect(user.is_blocked).toBe(false);

    const logPath = path.join(__dirname, '../../logs/fix_db.log');
    expect(fs.existsSync(logPath)).toBe(true);
    
    const logContent = fs.readFileSync(logPath, 'utf8');
    expect(logContent).toMatch(/Admin ID: 111111 executed \/fix_db APPLY CONFIRM/);
  });
});
