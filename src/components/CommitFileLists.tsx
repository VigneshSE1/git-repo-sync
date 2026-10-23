'use client';
import { Badge, Sha } from './ui';

interface CommitLike {
  sha: string;
  subject: string;
  author: string;
}

export function CommitList({ commits, empty = 'No commits.' }: { commits: CommitLike[]; empty?: string }) {
  if (commits.length === 0) return <p className="text-sm text-slate-500">{empty}</p>;
  return (
    <ul className="max-h-64 divide-y divide-slate-800 overflow-auto text-sm">
      {commits.map((c) => (
        <li key={c.sha} className="flex items-center gap-3 py-1.5">
          <Sha sha={c.sha} />
          <span className="min-w-0 flex-1 truncate">{c.subject}</span>
          <span className="shrink-0 text-xs text-slate-500">{c.author}</span>
        </li>
      ))}
    </ul>
  );
}

const STATUS_TONE: Record<string, 'good' | 'warn' | 'bad' | 'info'> = {
  A: 'good',
  M: 'info',
  D: 'bad',
  R: 'warn',
  C: 'warn',
  added: 'good',
  modified: 'info',
  removed: 'bad',
  renamed: 'warn',
};

export function FileList({
  files,
}: {
  files: Array<{ status: string; path: string; oldPath?: string; additions?: number; deletions?: number }>;
}) {
  if (files.length === 0) return <p className="text-sm text-slate-500">No changed files.</p>;
  return (
    <ul className="max-h-64 divide-y divide-slate-800 overflow-auto text-sm">
      {files.map((f) => (
        <li key={`${f.status}-${f.path}`} className="flex items-center gap-3 py-1">
          <Badge tone={STATUS_TONE[f.status] ?? 'neutral'}>{f.status}</Badge>
          <span className="min-w-0 flex-1 truncate font-mono text-xs">
            {f.oldPath ? `${f.oldPath} → ` : ''}
            {f.path}
          </span>
          {f.additions !== undefined && (
            <span className="font-mono text-xs">
              <span className="text-emerald-400">+{f.additions}</span> <span className="text-rose-400">-{f.deletions}</span>
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
