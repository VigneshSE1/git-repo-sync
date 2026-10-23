export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** Calls the server API. Every Git/provider operation happens on the server; secrets never reach here. */
export async function api<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-GRS': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    throw new ApiError('NETWORK', 'Could not reach the local Git Repo Sync server.', 'Is `npm run dev` still running?');
  }
  const json = (await res.json().catch(() => null)) as
    | { ok: true; data: T }
    | { ok: false; error: { code: string; message: string; hint?: string; details?: Record<string, unknown> } }
    | null;
  if (!json) throw new ApiError('INTERNAL', `Unexpected response (${res.status}).`);
  if (!json.ok) throw new ApiError(json.error.code, json.error.message, json.error.hint, json.error.details);
  return json.data;
}
