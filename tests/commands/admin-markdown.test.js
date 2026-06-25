describe('ADM-10 Admin Markdown Resiliency', () => {
  let bot;
  let admin;
  let scheduler;
  let callApiSpy;

  beforeAll(() => {
    const { Telegram } = require('telegraf');
    callApiSpy = jest.spyOn(Telegram.prototype, 'callApi').mockResolvedValue(true);
    admin = require('../../admin');
    scheduler = require('../../scheduler');
    bot = require('../../index').bot;
    bot.botInfo = { id: 123456, is_bot: true, first_name: 'Test Bot', username: 'test_bot' };
    jest.spyOn(admin, 'isAdmin').mockReturnValue(true);
    jest.spyOn(scheduler, 'setMarketingEnabled').mockImplementation(() => {});
    jest.spyOn(scheduler, 'startCron').mockImplementation(() => {});
    jest.spyOn(scheduler, 'stopDailyCron').mockImplementation(() => {});
    jest.spyOn(bot.telegram, 'sendMessage').mockResolvedValue(true);
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    const mongoose = require('mongoose');
    await mongoose.connection.close();
  });

  function commandUpdate(updateId, text) {
    const command = text.split(/\s+/)[0];
    return {
      update_id: updateId,
      message: {
        message_id: updateId,
        from: { id: 111111, is_bot: false },
        chat: { id: 111111, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text,
        entities: [{ offset: 0, length: command.length, type: 'bot_command' }]
      }
    };
  }

  test('/set_msg empty args should reply with format help', async () => {
    bot.telegram.sendMessage.mockClear();
    callApiSpy.mockClear();

    await bot.handleUpdate(commandUpdate(2, '/set_msg'));

    expect(callApiSpy).toHaveBeenCalledWith(
      'sendMessage',
      expect.objectContaining({
        chat_id: 111111,
        text: expect.stringContaining('Format: /set_msg <segmen> <pesan>')
      })
    );
  });

  test('/marketing_off should not throw an error and should disable cron', async () => {
    bot.telegram.sendMessage.mockClear();
    callApiSpy.mockClear();

    await bot.handleUpdate(commandUpdate(3, '/marketing_off'));

    expect(scheduler.setMarketingEnabled).toHaveBeenCalledWith(false);
    expect(callApiSpy).toHaveBeenCalledWith(
      'sendMessage',
      expect.objectContaining({
        chat_id: 111111,
        text: expect.stringContaining('Marketing otomatis DIMATIKAN')
      })
    );
  });

  test('/marketing_on should restore scheduler safely', async () => {
    bot.telegram.sendMessage.mockClear();
    callApiSpy.mockClear();

    await bot.handleUpdate(commandUpdate(4, '/marketing_on'));

    expect(scheduler.setMarketingEnabled).toHaveBeenCalledWith(true);
    expect(callApiSpy).toHaveBeenCalledWith(
      'sendMessage',
      expect.objectContaining({
        chat_id: 111111,
        text: expect.stringContaining('Marketing otomatis AKTIF')
      })
    );
  });

  test('/broadcast_nonbuyer with DRY_RUN should reply safely', async () => {
    bot.telegram.sendMessage.mockClear();
    callApiSpy.mockClear();
    const { User } = require('../../database');
    await User.create({ _id: 222222, first_name: 'QA User', purchase_count: 0 });

    await bot.handleUpdate(commandUpdate(5, '/broadcast_nonbuyer Halo DRY_RUN'));

    expect(callApiSpy).toHaveBeenCalledWith(
      'sendMessage',
      expect.objectContaining({
        chat_id: 111111,
        text: expect.stringContaining('[DRY-RUN]')
      })
    );
  });
});
