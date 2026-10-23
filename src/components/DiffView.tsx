'use client';
import { useMemo, useState } from 'react';
import { cx } from './ui';

interface FileDiff {
  name: string;
  lines: string[];
  added: number;
  removed: number;
}

function split(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let cur: FileDiff | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      cur = { name: m ? m[2] : line, lines: [], added: 0, removed: 0 };
      files.push(cur);
    }
    if (!cur) continue;
    cur.lines.push(line);
    if (line.startsWith('+') && !line.startsWith('+++')) cur.added++;
    else if (line.startsWith('-') && !line.startsWith('---')) cur.removed++;
  }
  return files;
}

export function DiffView({ text, truncated }: { text: string; truncated?: boolean }) {
  const files = useMemo(() => split(text), [text]);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  if (!text.trim()) return <p className="text-sm text-slate-500">No differences.</p>;
  return (
    <div className="space-y-2">
      {files.map((f) => {
        const isOpen = open[f.name] ?? files.length <= 3;
        return (
          <div key={f.name} className="overflow-hidden rounded-md border border-slate-800">
            <button
              className="flex w-full items-center justify-between bg-slate-900 px-3 py-1.5 text-left text-xs hover:bg-slate-800"
              onClick={() => setOpen((o) => ({ ...o, [f.name]: !isOpen }))}
            >
              <span className="font-mono text-slate-200">{f.name}</span>
              <span className="font-mono">
                <span className="text-emerald-400">+{f.added}</span> <span className="text-rose-400">-{f.removed}</span>
              </span>
            </button>
            {isOpen && (
              <pre className="max-h-96 overflow-auto bg-slate-950 p-2 text-xs leading-5">
                {f.lines.map((l, i) => (
                  <div
                    key={i}
                    className={cx(
                      'whitespace-pre px-1',
                      l.startsWith('+') && !l.startsWith('+++') && 'bg-emerald-500/10 text-emerald-300',
                      l.startsWith('-') && !l.startsWith('---') && 'bg-rose-500/10 text-rose-300',
                      l.startsWith('@@') && 'text-sky-400',
                      (l.startsWith('diff ') || l.startsWith('index ') || l.startsWith('---') || l.startsWith('+++')) && 'text-slate-500',
                    )}
                  >
                    {l || ' '}
                  </div>
                ))}
              </pre>
            )}
          </div>
        );
      })}
      {truncated && <p className="text-xs text-amber-300">Diff truncated for display. Use git locally for the full diff.</p>}
    </div>
  );
}
