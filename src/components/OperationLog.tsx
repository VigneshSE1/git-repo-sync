'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { LogEntry } from '@/lib/types';
import { Badge, Button, Card, cx } from './ui';

export function OperationLog() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [hideReads, setHideReads] = useState(false);
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await api<{ entries: LogEntry[] }>('GET', 'log?limit=300');
        if (alive) setEntries(r.entries);
      } catch {
        /* keep the last good snapshot */
      }
    };
    void load();
    const t = setInterval(load, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const READ = /^git (rev-parse|status|log|rev-list|config|merge-base|diff|show|for-each-ref|cat-file|ls-remote|cherry)\b/;
  const shown = entries.filter((e) => !(hideReads && e.kind === 'git' && READ.test(e.message))).slice().reverse();

  return (
    <Card
      title="Operation log (secrets redacted)"
      actions={
        <>
          <label className="flex items-center gap-1.5 text-xs text-slate-400">
            <input type="checkbox" checked={hideReads} onChange={(e) => setHideReads(e.target.checked)} /> hide read-only commands
          </label>
          <Button
            variant="ghost"
            onClick={async () => {
              await api('POST', 'log/clear', {});
              setEntries([]);
            }}
          >
            Clear
          </Button>
        </>
      }
    >
      {shown.length === 0 ? (
        <p className="text-sm text-slate-500">Nothing has run yet.</p>
      ) : (
        <ul className="divide-y divide-slate-800 font-mono text-xs">
          {shown.map((e) => (
            <li key={e.id} className="py-1.5">
              <button className="flex w-full items-start gap-2 text-left" onClick={() => setOpen(open === e.id ? null : e.id)}>
                <span className="shrink-0 text-slate-600">{new Date(e.ts).toLocaleTimeString()}</span>
                <Badge tone={e.kind === 'git' ? 'neutral' : e.kind === 'api' ? 'info' : e.kind === 'error' ? 'bad' : 'good'}>{e.scope}</Badge>
                <span className={cx('min-w-0 flex-1 break-all', e.ok === false ? 'text-rose-300' : 'text-slate-300')}>{e.message}</span>
                <span className="shrink-0 text-slate-600">{e.durationMs !== undefined ? `${e.durationMs}ms` : ''}</span>
                <span className={cx('shrink-0', e.ok === false ? 'text-rose-400' : e.ok ? 'text-emerald-400' : 'text-slate-600')}>{e.ok === undefined ? '' : e.ok ? 'ok' : 'fail'}</span>
              </button>
              {open === e.id && e.output && <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-slate-950 p-2 text-slate-400">{e.output}</pre>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
