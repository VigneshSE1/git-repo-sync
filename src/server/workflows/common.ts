import { AppError } from '../errors';

export interface RepoTarget {
  path: string;
  url: string;
  branch: string;
}

export function assertWritable(previewOnly: boolean): void {
  if (previewOnly) {
    throw new AppError('PREVIEW_ONLY', 'Preview-only mode is on; write operations are disabled.', {
      hint: 'Turn off "Preview-only mode" in Setup (review screen) to enable applying and pushing.',
    });
  }
}

export function stamp(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

export function short(sha: string): string {
  return sha.slice(0, 8);
}
