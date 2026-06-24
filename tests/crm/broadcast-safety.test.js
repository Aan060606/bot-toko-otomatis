const fs = require('fs');
const path = require('path');

describe('CRM-01..CRM-08 broadcast safety source checks', () => {
  const indexSource = fs.readFileSync(path.resolve(__dirname, '../../index.js'), 'utf8');
  const schedulerSource = fs.readFileSync(path.resolve(__dirname, '../../scheduler.js'), 'utf8');

  test('manual broadcast skips blocked users and has Telegram throttling delay', () => {
    expect(indexSource).toMatch(/is_blocked:\s*false/);
    expect(indexSource).toMatch(/setTimeout\(res,\s*1000\)/);
  });

  test('manual broadcast should support dry-run before sending real messages', () => {
    expect(indexSource).toMatch(/dry[-_ ]?run|preview/i);
  });

  test('scheduler avoids converted drip logs and marks blocked users', () => {
    expect(schedulerSource).toMatch(/converted:\s*false/);
    expect(schedulerSource).toMatch(/is_blocked/);
  });
});
