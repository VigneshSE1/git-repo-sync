export type ErrorCode =
  | 'VALIDATION'
  | 'NOT_CONFIGURED'
  | 'REPO_INVALID'
  | 'DIRTY_WORKTREE'
  | 'OPERATION_IN_PROGRESS'
  | 'LOCKED'
  | 'AUTH'
  | 'NETWORK'
  | 'NOT_FOUND'
  | 'REMOTE_REJECTED'
  | 'CONFLICT'
  | 'STALE'
  | 'DUPLICATE_TRANSFER'
  | 'PROVIDER'
  | 'PREVIEW_ONLY'
  | 'CONFIRMATION_REQUIRED'
  | 'PRECONDITION'
  | 'UNSUPPORTED'
  | 'GIT';

const STATUS: Record<ErrorCode, number> = {
  VALIDATION: 400,
  NOT_CONFIGURED: 409,
  REPO_INVALID: 422,
  DIRTY_WORKTREE: 409,
  OPERATION_IN_PROGRESS: 409,
  LOCKED: 423,
  AUTH: 401,
  NETWORK: 502,
  NOT_FOUND: 404,
  REMOTE_REJECTED: 409,
  CONFLICT: 409,
  STALE: 409,
  DUPLICATE_TRANSFER: 409,
  PROVIDER: 502,
  PREVIEW_ONLY: 403,
  CONFIRMATION_REQUIRED: 428,
  PRECONDITION: 412,
  UNSUPPORTED: 501,
  GIT: 500,
};

export interface AppErrorOptions {
  /** Actionable guidance shown to the user. */
  hint?: string;
  /** Structured, non-secret data (e.g. conflicting files). */
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, opts: AppErrorOptions = {}) {
    super(message, opts.cause ? { cause: opts.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.hint = opts.hint;
    this.details = opts.details;
  }

  get status(): number {
    return STATUS[this.code];
  }
}

/** Maps raw git stderr to a categorized AppError with guidance. */
export function classifyGitError(raw: unknown): AppError {
  if (raw instanceof AppError) return raw;
  const message = raw instanceof Error ? raw.message : String(raw);
  const m = message.toLowerCase();

  if (
    m.includes('authentication failed') ||
    m.includes('could not read username') ||
    m.includes('could not read password') ||
    m.includes('permission denied (publickey') ||
    m.includes('terminal prompts disabled') ||
    m.includes('invalid username or password') ||
    m.includes('the requested url returned error: 403') ||
    m.includes('the requested url returned error: 401')
  ) {
    return new AppError('AUTH', 'Git authentication failed.', {
      hint: 'Check your Git credential manager or SSH key (try `git ls-remote <url>` in a terminal) and that your account can access this repository.',
      cause: raw,
    });
  }
  if (
    m.includes('stale info') ||
    m.includes('non-fast-forward') ||
    m.includes('[rejected]') ||
    m.includes('[remote rejected]') ||
    m.includes('pre-receive hook declined') ||
    m.includes('protected branch')
  ) {
    return new AppError('REMOTE_REJECTED', 'The remote rejected the push.', {
      hint: 'The remote may have changed (stale lease), the branch may be protected, or a server hook declined the push. Re-run the preview to refresh, then retry.',
      cause: raw,
    });
  }
  if (
    m.includes('repository not found') ||
    m.includes('does not appear to be a git repository') ||
    m.includes('could not read from remote repository') ||
    m.includes("couldn't find remote ref")
  ) {
    return new AppError('NOT_FOUND', 'Remote repository or ref not found.', {
      hint: 'Verify the repository URL, the branch name, and that you have access.',
      cause: raw,
    });
  }
  if (
    m.includes('could not resolve host') ||
    m.includes('connection timed out') ||
    m.includes('connection refused') ||
    m.includes('network is unreachable') ||
    m.includes('unable to access') ||
    m.includes('timed out') ||
    m.includes('early eof')
  ) {
    return new AppError('NETWORK', 'Network error while contacting the remote.', {
      hint: 'Check your network/VPN/proxy and retry.',
      cause: raw,
    });
  }
  return new AppError('GIT', firstLine(message), { cause: raw });
}

function firstLine(s: string): string {
  return s.split(/\r?\n/).find((l) => l.trim()) ?? 'Git command failed.';
}
