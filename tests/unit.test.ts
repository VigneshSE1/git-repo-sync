import { describe, expect, it } from 'vitest';
import { AppError, classifyGitError } from '@/server/errors';
import { withRepoLocks } from '@/server/locks';
import { hasEmbeddedCredentials, isAllowedRemote, normalizeRemote, parseSlug, sameRemote } from '@/server/remote';
import { redact } from '@/server/redact';
import { appConfigSchema, branchName, parsePrNumber, remoteUrl, transferPublishRequest } from '@/server/validation';

describe('remote URL handling', () => {
  it('normalizes https, ssh and scp-like forms to the same identity', () => {
    const forms = [
      'https://github.com/Acme/Widgets.git',
      'https://user@github.com/acme/widgets',
      'git@github.com:acme/widgets.git',
      'ssh://git@github.com/acme/widgets.git',
      'https://github.com/acme/widgets/',
    ];
    for (const f of forms) expect(normalizeRemote(f)).toBe('github.com/acme/widgets');
    expect(sameRemote(forms[0], forms[2])).toBe(true);
    expect(sameRemote(forms[0], 'https://github.com/acme/other')).toBe(false);
    expect(parseSlug(forms[2])).toEqual({ host: 'github.com', owner: 'acme', repo: 'widgets' });
  });

  it('rejects option injection, exotic transports and embedded credentials', () => {
    expect(isAllowedRemote('--upload-pack=touch /tmp/x')).toBe(false);
    expect(isAllowedRemote('-oProxyCommand=evil')).toBe(false);
    expect(isAllowedRemote('ext::sh -c "touch /tmp/x"')).toBe(false);
    expect(isAllowedRemote('https://github.com/a/b with space')).toBe(false);
    expect(isAllowedRemote('https://github.com/a/b.git')).toBe(true);
    expect(isAllowedRemote('git@github.com:a/b.git')).toBe(true);
    expect(isAllowedRemote('C:\\repos\\thing.git')).toBe(true);
    expect(hasEmbeddedCredentials('https://user:secret@github.com/a/b')).toBe(true);
    expect(hasEmbeddedCredentials('https://ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/a/b')).toBe(true);
    expect(hasEmbeddedCredentials('https://user@github.com/a/b')).toBe(false);
    expect(remoteUrl.safeParse('https://u:p@github.com/a/b').success).toBe(false);
  });
});

describe('validation', () => {
  it('accepts normal branch names and rejects dangerous ones', () => {
    for (const ok of ['develop', 'feature/x-1', 'release/1.2.3']) expect(branchName.safeParse(ok).success).toBe(true);
    for (const bad of ['', '-rf', '--force', 'a..b', 'a b', 'x;rm -rf', 'a//b', 'trailing/', 'x.lock', '$(whoami)']) {
      expect(branchName.safeParse(bad).success, bad).toBe(false);
    }
  });

  const base = {
    org: { url: 'https://github.com/o/r.git', path: process.platform === 'win32' ? 'C:\\a' : '/a', provider: 'github' },
    intern: { url: 'https://github.com/i/r.git', path: process.platform === 'win32' ? 'C:\\b' : '/b', provider: 'github' },
  };

  it('defaults branches to develop and preview-only to true', () => {
    const cfg = appConfigSchema.parse(base);
    expect(cfg.org.branch).toBe('develop');
    expect(cfg.intern.branch).toBe('develop');
    expect(cfg.preferences.previewOnly).toBe(true);
    expect(cfg.preferences.transferViaPr).toBe(true);
  });

  it('rejects invalid configuration', () => {
    expect(appConfigSchema.safeParse({ ...base, org: { ...base.org, url: '-bad' } }).success).toBe(false);
    expect(appConfigSchema.safeParse({ ...base, org: { ...base.org, path: 'relative/dir' } }).success).toBe(false);
    expect(appConfigSchema.safeParse({ ...base, org: { ...base.org, provider: 'gitlab' } }).success).toBe(false);
    expect(appConfigSchema.safeParse({ ...base, intern: { ...base.intern, path: base.org.path } }).success).toBe(false);
  });

  it('requires literal confirmation for pushes', () => {
    const body = { prNumber: 1, expectTip: 'a'.repeat(40) };
    expect(transferPublishRequest.safeParse({ ...body, confirmPush: true }).success).toBe(true);
    expect(transferPublishRequest.safeParse({ ...body, confirmPush: false }).success).toBe(false);
    expect(transferPublishRequest.safeParse(body).success).toBe(false);
  });

  it('parses PR numbers from URLs and plain numbers', () => {
    expect(parsePrNumber('https://github.com/a/b/pull/42')).toBe(42);
    expect(parsePrNumber('#7')).toBe(7);
    expect(parsePrNumber('nope')).toBeNull();
  });
});

describe('error classification', () => {
  it.each([
    ['fatal: Authentication failed for https://github.com/a/b', 'AUTH'],
    ['fatal: could not read Username for https://github.com: terminal prompts disabled', 'AUTH'],
    ['git@github.com: Permission denied (publickey).', 'AUTH'],
    ['fatal: unable to access x: Could not resolve host: github.com', 'NETWORK'],
    ['fatal: repository not found', 'NOT_FOUND'],
    ['fatal: does not appear to be a git repository', 'NOT_FOUND'],
    ['! [rejected] develop -> develop (stale info)', 'REMOTE_REJECTED'],
    ['! [rejected] develop (non-fast-forward)', 'REMOTE_REJECTED'],
    ['something else entirely', 'GIT'],
  ])('%s -> %s', (msg, code) => {
    expect(classifyGitError(new Error(msg)).code).toBe(code);
  });
});

describe('redaction', () => {
  it('removes credentials and tokens from log text', () => {
    process.env.GITHUB_TOKEN_ORG = 'supersecretvalue1234';
    try {
      const text = [
        'git clone https://user:pa55word@github.com/a/b.git',
        'push to https://ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/a/b',
        'Authorization: Bearer abc.def.ghi',
        'url?access_token=zzz111&x=1',
        'env leak supersecretvalue1234 here',
      ].join('\n');
      const out = redact(text);
      expect(out).not.toMatch(/pa55word|ghp_abc|abc\.def\.ghi|zzz111|supersecretvalue1234/);
      expect(out).toContain('https://***@github.com/a/b.git');
    } finally {
      delete process.env.GITHUB_TOKEN_ORG;
    }
  });
});

describe('repo locks', () => {
  it('rejects a concurrent operation on the same repository and releases afterwards', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = withRepoLocks(['/tmp/repo-a'], 'first', () => gate);
    const err = await withRepoLocks(['/tmp/repo-a'], 'second', async () => 1).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe('LOCKED');
    // different repo is unaffected
    await expect(withRepoLocks(['/tmp/repo-b'], 'other', async () => 'ok')).resolves.toBe('ok');
    release();
    await first;
    await expect(withRepoLocks(['/tmp/repo-a'], 'third', async () => 'free')).resolves.toBe('free');
  });

  it('releases the lock when the operation throws', async () => {
    await expect(withRepoLocks(['/tmp/repo-c'], 'boom', async () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    await expect(withRepoLocks(['/tmp/repo-c'], 'after', async () => 'ok')).resolves.toBe('ok');
  });
});
