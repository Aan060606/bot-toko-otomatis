module.exports = {
  testEnvironment: 'node',
  setupFilesAfterEnv: ['<rootDir>/tests/setup/mongo-memory.js'],
  testTimeout: 60000,
  clearMocks: true
};
