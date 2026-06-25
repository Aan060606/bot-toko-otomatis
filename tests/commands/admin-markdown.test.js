const { createMockCtx } = require('../helpers/mock-ctx');
const admin = require('../../admin');
const scheduler = require('../../scheduler');

describe('ADM-10 Admin Markdown Resiliency', () => {
  let bot;
  beforeAll(() => {
    bot = require('../../index').bot;
    jest.spyOn(admin, 'isAdmin').mockReturnValue(true);
    jest.spyOn(scheduler, 'setMarketingEnabled').mockImplementation(() => {});
    jest.spyOn(scheduler, 'startCron').mockImplementation(() => {});
    jest.spyOn(scheduler, 'stopDailyCron').mockImplementation(() => {});
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    const mongoose = require('mongoose');
    await mongoose.connection.close();
  });

  test('/set_msg empty args should reply with format help', async () => {
    const ctx = createMockCtx({ userId: 111111, text: '/set_msg' });
    
    // Process update manually by simulating a message
    // Actually we can just run bot.handleUpdate but it's easier to find the route
    // Wait, the bot instance is exported.
    await bot.handleUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        from: { id: 111111 },
        chat: { id: 111111 },
        date: Date.now(),
        text: '/set_msg'
      }
    });

    // To assert, we can't easily spy on ctx.reply since ctx is created internally by bot.handleUpdate.
    // Let's spy on telegram.sendMessage instead!
    jest.spyOn(bot.telegram, 'sendMessage').mockResolvedValue(true);
    bot.telegram.sendMessage.mockClear();

    await bot.handleUpdate({
      update_id: 2,
      message: {
        message_id: 2,
        from: { id: 111111 },
        chat: { id: 111111 },
        date: Date.now(),
        text: '/set_msg'
      }
    });

    expect(bot.telegram.sendMessage).toHaveBeenCalledWith(
      111111,
      expect.stringContaining('Format: /set_msg <segmen> <pesan>')
    );
  });

  test('/marketing_off should not throw an error and should disable cron', async () => {
    jest.spyOn(bot.telegram, 'sendMessage').mockResolvedValue(true);
    bot.telegram.sendMessage.mockClear();

    await bot.handleUpdate({
      update_id: 3,
      message: {
        message_id: 3,
        from: { id: 111111 },
        chat: { id: 111111 },
        date: Date.now(),
        text: '/marketing_off'
      }
    });

    expect(scheduler.setMarketingEnabled).toHaveBeenCalledWith(false);
    expect(bot.telegram.sendMessage).toHaveBeenCalledWith(
      111111,
      expect.stringContaining('Marketing otomatis DIMATIKAN'),
      expect.any(Object)
    );
  });

  test('/marketing_on should restore scheduler safely', async () => {
    jest.spyOn(bot.telegram, 'sendMessage').mockResolvedValue(true);
    bot.telegram.sendMessage.mockClear();

    await bot.handleUpdate({
      update_id: 4,
      message: {
        message_id: 4,
        from: { id: 111111 },
        chat: { id: 111111 },
        date: Date.now(),
        text: '/marketing_on'
      }
    });

    expect(scheduler.setMarketingEnabled).toHaveBeenCalledWith(true);
    expect(bot.telegram.sendMessage).toHaveBeenCalledWith(
      111111,
      expect.stringContaining('Marketing otomatis AKTIF'),
      expect.any(Object)
    );
  });

  test('/broadcast_nonbuyer with DRY_RUN should reply safely', async () => {
    jest.spyOn(bot.telegram, 'sendMessage').mockResolvedValue(true);
    bot.telegram.sendMessage.mockClear();

    await bot.handleUpdate({
      update_id: 5,
      message: {
        message_id: 5,
        from: { id: 111111 },
        chat: { id: 111111 },
        date: Date.now(),
        text: '/broadcast_nonbuyer Halo DRY_RUN'
      }
    });

    expect(bot.telegram.sendMessage).toHaveBeenCalledWith(
      111111,
      expect.stringContaining('[DRY-RUN]'),
      expect.any(Object)
    );
  });
});
