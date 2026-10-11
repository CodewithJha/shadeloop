import * as Sentry from '@sentry/node';

/** A Sentry span (no-op without SENTRY_DSN). Attributes carry counts and names only: no prompts, notes or coordinates. */
export const span = <T>(op: string, name: string, attributes: Record<string, string | number | boolean>, fn: (s: Sentry.Span) => Promise<T>) =>
  Sentry.startSpan({ op, name, attributes }, fn);

export const tool = <T>(name: string, fn: () => Promise<T>) =>
  span('gen_ai.execute_tool', `execute_tool ${name}`, { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': name }, fn);

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
