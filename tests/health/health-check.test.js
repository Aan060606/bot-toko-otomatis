const fs = require('fs');
const path = require('path');

describe('OPS-01 health check', () => {
  test('bot exposes an admin-only /health command with DB/env/memory/scheduler status', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../index.js'), 'utf8');

    expect(source).toMatch(/bot\.command\(["']health["']/);
    expect(source).toMatch(/admin\.isAdmin\(ctx\)/);
    expect(source).toMatch(/mongoose\.connection|readyState|Mongo/i);
    expect(source).toMatch(/memoryUsage/);
    expect(source).toMatch(/scheduler/);
    expect(source).not.toMatch(/BOT_TOKEN.*ctx\.reply|MONGODB_URI.*ctx\.reply|SAWERIA.*ctx\.reply/);
  });
});
