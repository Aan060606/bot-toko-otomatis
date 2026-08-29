module.exports = {
  testEnvironment: 'node',
  setupFilesAfterEnv: ['<rootDir>/tests/setup/mongo-memory.js'],
  testTimeout: 60000,
  clearMocks: true,
  // Mock puppeteer dependencies — tidak boleh jalan saat automated test
  moduleNameMapper: {
    'puppeteer-extra$': '<rootDir>/tests/__mocks__/puppeteer-extra.js',
    'puppeteer-extra-plugin-stealth': '<rootDir>/tests/__mocks__/puppeteer-stealth.js'
  }
};
