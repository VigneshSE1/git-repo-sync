import path from 'node:path';

const SCP_LIKE = /^(?:[\w.-]+@)?([\w.-]+):(?!\/\/)(.+)$/;

export function isLocalPathRemote(url: string): boolean {
  return /^file:\/\//i.test(url) || path.isAbsolute(url) || /^[a-zA-Z]:[\\/]/.test(url);
}

/** Whitelist of remote forms we allow. Blocks option injection and exotic transports (ext::, fd::). */
export function isAllowedRemote(url: string): boolean {
  if (!url || url.startsWith('-') || /\s/.test(url) || url.includes('\0')) return false;
  if (/^https?:\/\//i.test(url) || /^ssh:\/\//i.test(url) || /^git:\/\//i.test(url)) return true;
  if (isLocalPathRemote(url)) return true;
  if (/^[a-z][a-z0-9+.-]*::/i.test(url)) return false;
  return SCP_LIKE.test(url);
}

/** Embedded `user:password@` or token-looking userinfo must never be stored. */
export function hasEmbeddedCredentials(url: string): boolean {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/@]+)@/i.exec(url);
  if (!m) return false;
  const userinfo = m[1];
  if (userinfo.includes(':')) return true;
  return /^(gh[pousr]_|github_pat_)/.test(userinfo) || userinfo.length > 40;
}

/** Canonical comparable form: host/owner/repo for URLs, resolved path for local remotes. */
export function normalizeRemote(url: string): string {
  const u = url.trim();
  if (isLocalPathRemote(u)) {
    let p = u;
    if (/^file:\/\//i.test(p)) {
      p = decodeURIComponent(p.replace(/^file:\/\/\/?/i, process.platform === 'win32' ? '' : '/'));
    }
    const r = path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').replace(/\.git$/, '');
    return process.platform === 'win32' ? r.toLowerCase() : r;
  }
  let host: string;
  let rest: string;
  const urlForm = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/@]+@)?([^/:]+)(?::\d+)?\/(.*)$/i.exec(u);
  if (urlForm) {
    host = urlForm[1];
    rest = urlForm[2];
  } else {
    const scp = SCP_LIKE.exec(u);
    if (!scp) return u.toLowerCase();
    host = scp[1];
    rest = scp[2];
  }
  rest = rest.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '');
  return `${host}/${rest}`.toLowerCase();
}

export function sameRemote(a: string, b: string): boolean {
  return normalizeRemote(a) === normalizeRemote(b);
}

export interface RepoSlug {
  host: string;
  owner: string;
  repo: string;
}

export function parseSlug(url: string): RepoSlug | null {
  if (isLocalPathRemote(url)) return null;
  const parts = normalizeRemote(url).split('/');
  if (parts.length !== 3) return null;
  return { host: parts[0], owner: parts[1], repo: parts[2] };
}
