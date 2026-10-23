const PATTERNS: Array<[RegExp, string]> = [
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1***@'],
  [/\b(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/g, '***'],
  [/(authorization:\s*(?:bearer|token|basic)\s+)\S+/gi, '$1***'],
  [/\b(access_token|token|password|passwd|secret)=([^&\s]+)/gi, '$1=***'],
];

function secretValuesFromEnv(): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(process.env)) {
    if (v && v.length >= 8 && /(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY)/i.test(k)) out.push(v);
  }
  return out;
}

/** Removes credentials/tokens from text destined for logs or API responses. */
export function redact(text: string): string {
  let out = text;
  for (const secret of secretValuesFromEnv()) out = out.split(secret).join('***');
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}
