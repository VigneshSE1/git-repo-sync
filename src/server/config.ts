import fs from 'node:fs';
import path from 'node:path';
import { AppError } from './errors';
import { appConfigSchema, type AppConfig } from './validation';

export function dataDir(): string {
  return process.env.GIT_REPO_SYNC_DATA_DIR || path.join(process.cwd(), '.git-repo-sync');
}

export function ensureDataDir(): string {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const configFile = () => path.join(dataDir(), 'config.json');

export function loadConfig(): AppConfig | null {
  let raw: string;
  try {
    raw = fs.readFileSync(configFile(), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  try {
    return appConfigSchema.parse(JSON.parse(raw));
  } catch (e) {
    throw new AppError('NOT_CONFIGURED', 'The saved configuration is unreadable or invalid.', {
      hint: `Fix or delete ${configFile()} and run the setup wizard again.`,
      cause: e,
    });
  }
}

/** Config holds only non-secret values (URLs, paths, branches, preferences). */
export function saveConfig(config: AppConfig): void {
  ensureDataDir();
  fs.writeFileSync(configFile(), JSON.stringify(config, null, 2), 'utf8');
}

export function requireConfig(): AppConfig {
  const c = loadConfig();
  if (!c) {
    throw new AppError('NOT_CONFIGURED', 'Git Repo Sync is not configured yet.', {
      hint: 'Open the Setup tab and complete the wizard.',
    });
  }
  return c;
}

export type Role = 'org' | 'intern';

/** Tokens are read from the server environment (.env.local) only. */
export function tokenFor(role: Role): string | undefined {
  const specific = role === 'org' ? process.env.GITHUB_TOKEN_ORG : process.env.GITHUB_TOKEN_INTERN;
  return specific?.trim() || process.env.GITHUB_TOKEN?.trim() || undefined;
}

export function authStatus(): Record<Role, { tokenConfigured: boolean; source: string | null }> {
  const one = (role: Role) => {
    const specificKey = role === 'org' ? 'GITHUB_TOKEN_ORG' : 'GITHUB_TOKEN_INTERN';
    if (process.env[specificKey]?.trim()) return { tokenConfigured: true, source: specificKey };
    if (process.env.GITHUB_TOKEN?.trim()) return { tokenConfigured: true, source: 'GITHUB_TOKEN' };
    return { tokenConfigured: false, source: null };
  };
  return { org: one('org'), intern: one('intern') };
}
