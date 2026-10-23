'use client';
import { useEffect, useState } from 'react';
import type { ApiError } from '@/lib/api';

export function cx(...c: Array<string | false | null | undefined>) {
  return c.filter(Boolean).join(' ');
}

type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'info';
const tones: Record<Tone, string> = {
  neutral: 'bg-slate-800 text-slate-300',
  good: 'bg-emerald-500/15 text-emerald-300',
  warn: 'bg-amber-500/15 text-amber-300',
  bad: 'bg-rose-500/15 text-rose-300',
  info: 'bg-sky-500/15 text-sky-300',
};

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: React.ReactNode }) {
  return <span className={cx('inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium', tones[tone])}>{children}</span>;
}

export function Button({
  variant = 'default',
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'danger' | 'ghost' }) {
  const v = {
    default: 'border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-100',
    primary: 'bg-sky-600 hover:bg-sky-500 text-white',
    danger: 'bg-rose-600 hover:bg-rose-500 text-white',
    ghost: 'text-slate-300 hover:bg-slate-800',
  }[variant];
  return (
    <button
      {...props}
      className={cx('rounded-md px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-40', v, className)}
    />
  );
}

export function Card({
  title,
  actions,
  children,
  className,
}: {
  title?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cx('rounded-lg border border-slate-800 bg-slate-900/60', className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-slate-800 px-4 py-2.5">
          <h3 className="text-sm font-semibold text-slate-100">{title}</h3>
          <div className="flex items-center gap-2">{actions}</div>
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Alert({ tone = 'info', title, children }: { tone?: Tone; title?: string; children?: React.ReactNode }) {
  const border = {
    neutral: 'border-slate-700',
    good: 'border-emerald-500/40',
    warn: 'border-amber-500/40',
    bad: 'border-rose-500/40',
    info: 'border-sky-500/40',
  }[tone];
  return (
    <div className={cx('rounded-md border px-3 py-2 text-sm', border, tones[tone])}>
      {title && <div className="font-semibold">{title}</div>}
      {children && <div className="mt-0.5 space-y-1 text-slate-200">{children}</div>}
    </div>
  );
}

export function ErrorBox({ error }: { error: ApiError | null }) {
  if (!error) return null;
  const files = Array.isArray(error.details?.files) ? (error.details.files as string[]) : null;
  return (
    <Alert tone="bad" title={`${error.code}: ${error.message}`}>
      {error.hint && <p>{error.hint}</p>}
      {files && <p className="font-mono text-xs">{files.join(', ')}</p>}
    </Alert>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm text-slate-400">
      <span className="h-3 w-3 animate-spin rounded-full border-2 border-slate-600 border-t-sky-400" />
      {label}…
    </span>
  );
}

export function Sha({ sha }: { sha?: string | null }) {
  return <code className="rounded bg-slate-800 px-1 py-0.5 font-mono text-xs text-sky-300">{sha ? sha.slice(0, 8) : '--------'}</code>;
}

export function Stepper({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      {steps.map((s, i) => (
        <li key={s} className="flex items-center gap-2">
          <span
            className={cx(
              'flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-semibold',
              i < current ? 'bg-emerald-500 text-slate-950' : i === current ? 'bg-sky-500 text-slate-950' : 'bg-slate-800 text-slate-500',
            )}
          >
            {i < current ? '✓' : i + 1}
          </span>
          <span className={cx(i === current ? 'text-slate-100' : 'text-slate-500')}>{s}</span>
          {i < steps.length - 1 && <span className="mx-1 h-px w-6 bg-slate-700" />}
        </li>
      ))}
    </ol>
  );
}

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  danger,
  requirePhrase,
  busy,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children: React.ReactNode;
  confirmLabel: string;
  danger?: boolean;
  requirePhrase?: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState('');
  useEffect(() => {
    if (!open) setTyped('');
  }, [open]);
  if (!open) return null;
  const ok = !requirePhrase || typed === requirePhrase;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-lg rounded-lg border border-slate-700 bg-slate-900 p-5 shadow-xl">
        <h3 className={cx('text-base font-semibold', danger ? 'text-rose-300' : 'text-slate-100')}>{title}</h3>
        <div className="mt-2 space-y-2 text-sm text-slate-300">{children}</div>
        {requirePhrase && (
          <div className="mt-3">
            <label className="text-xs text-slate-400">
              Type <code className="text-rose-300">{requirePhrase}</code> to confirm
            </label>
            <input type="text" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} disabled={!ok || busy}>
            {busy ? 'Working…' : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
