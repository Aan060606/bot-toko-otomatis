const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');

function runGit(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

describe('SEC-00..SEC-03 security cleanup', () => {
  test('sensitive files are not tracked by git', () => {
    const tracked = runGit(['ls-files']);
    const forbidden = tracked.filter((file) => (
      file === '.env' ||
      file.startsWith('.env.') ||
      file === 'store.db' ||
      file.startsWith('store.db-') ||
      file === 'node_modules' ||
      file.startsWith('node_modules/') ||
      file.endsWith('.log') ||
      file.startsWith('coverage/')
    ));

    expect(forbidden).toEqual([]);
  });

  test('.gitignore blocks local secrets, DB files, dependencies, logs, and coverage', () => {
    const ignored = runGit(['check-ignore', '.env', 'store.db', 'store.db-wal', 'store.db-shm', 'node_modules', 'logs/app.log', 'coverage/lcov.info']);
    expect(ignored).toEqual(expect.arrayContaining([
      '.env',
      'store.db',
      'store.db-wal',
      'store.db-shm',
      'node_modules'
    ]));
    expect(ignored).toEqual(expect.arrayContaining(['logs/app.log', 'coverage/lcov.info']));
  });

  test('strict local scan can be enabled for release packaging', () => {
    if (process.env.QA_STRICT_LOCAL_SCAN !== '1') return;

    const forbiddenNames = new Set(['.env', 'store.db', 'store.db-wal', 'store.db-shm', 'node_modules']);
    const found = fs.readdirSync(root).filter((name) => forbiddenNames.has(name));

    expect(found).toEqual([]);
  });
});
