export type IntegrationStatus = 'NOT_CONFIGURED' | 'IMPLEMENTED' | 'CONFIGURED' | 'VERIFIED' | 'DEGRADED' | 'DISABLED';

interface LastCall {
  ok: boolean;
  at: string;
  detail: string;
}

const lastCalls = new Map<string, LastCall>();

/** Record the outcome of a real call to an external dependency. Detail must not contain secrets or user data. */
export function recordCall(name: string, ok: boolean, detail: string) {
  lastCalls.set(name, { ok, at: new Date().toISOString(), detail: detail.slice(0, 200) });
}

export const lastCall = (name: string) => lastCalls.get(name) ?? null;

/** Status from configuration plus the last live call. A configured key alone never yields VERIFIED. */
export function statusFrom(opts: { enabled: boolean; configured: boolean; needsConfig: boolean; name: string }): IntegrationStatus {
  if (!opts.enabled) return 'DISABLED';
  if (opts.needsConfig && !opts.configured) return 'NOT_CONFIGURED';
  const last = lastCalls.get(opts.name);
  if (!last) return opts.needsConfig ? 'CONFIGURED' : 'IMPLEMENTED';
  return last.ok ? 'VERIFIED' : 'DEGRADED';
}
