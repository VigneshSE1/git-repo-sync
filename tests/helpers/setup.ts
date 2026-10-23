import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';

// Isolate git from the developer's own configuration and keep state out of the repo.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grs-test-'));
const globalCfg = path.join(root, 'gitconfig');
fs.writeFileSync(
  globalCfg,
  ['[user]', '  name = Test User', '  email = test@example.com', '[init]', '  defaultBranch = develop', '[core]', '  autocrlf = false', '[commit]', '  gpgsign = false', ''].join('\n'),
);
process.env.GIT_CONFIG_GLOBAL = globalCfg;
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_REPO_SYNC_DATA_DIR = path.join(root, 'data');
process.env.GIT_TERMINAL_PROMPT = '0';
delete process.env.GITHUB_TOKEN;
delete process.env.GITHUB_TOKEN_ORG;
delete process.env.GITHUB_TOKEN_INTERN;

afterAll(() => {
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* best effort on Windows */
  }
});
