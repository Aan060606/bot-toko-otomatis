// Mock puppeteer-extra untuk test environment
// Browser headless tidak boleh diluncurkan saat automated testing
const puppeteerMock = {
  use: jest.fn().mockReturnThis(),
  launch: jest.fn().mockResolvedValue({
    newPage: jest.fn().mockResolvedValue({
      goto: jest.fn().mockResolvedValue({}),
      evaluate: jest.fn().mockResolvedValue({ status: 200, body: '{"data":{"qr_string":"mock-qr","id":"mock-id","amount_raw":10000}}' }),
      setRequestInterception: jest.fn().mockResolvedValue({}),
      on: jest.fn(),
      waitForFunction: jest.fn().mockResolvedValue({}),
      isClosed: jest.fn().mockReturnValue(false),
    }),
    on: jest.fn(),
    process: jest.fn().mockReturnValue({ kill: jest.fn() }),
    close: jest.fn().mockResolvedValue({}),
  }),
};

module.exports = puppeteerMock;
