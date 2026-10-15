/**
 * Sync requests to the Tabby plugin, and what a failed one means. The policy
 * here is pure; tabby.ts runs curl.
 *
 * The rule this file exists for: **a request that failed is not an empty
 * answer.** `blocksList` used to turn any curl failure into `[]`, so on an
 * overloaded machine (load ~360–575, where `/api/tabs` took 3.5–6s against a
 * 5s cap, 2026-10-15) a timed-out read was "no tabs open". `manifest` then
 * wrote a manifest of 0 entries and printed ✔; `close <id>` said no such tab;
 * and `waitForTabExit` — which treats "not in the list" as "closed" — would
 * have reported a live tab gone, which is what `profile-copy` waits on before
 * moving a transcript.
 */

/** Seconds one plugin request may take: `CCTABS_TABBY_TIMEOUT`, default 30. */
export function pluginTimeoutSec(env: Record<string, string | undefined> = process.env): number {
  const v = Number(env.CCTABS_TABBY_TIMEOUT)
  return Number.isFinite(v) && v > 0 ? v : 30
}

/** curl exit codes worth one retry: 28 = timed out, 7 = couldn't connect, 52/56 = connection dropped. */
export function isTransientCurlExit(code: number | null): boolean {
  return code === 28 || code === 7 || code === 52 || code === 56
}

export class TabbyPluginRequestError extends Error {
  constructor(public what: string, public reason: string, public timedOut: boolean) {
    super(
      timedOut
        ? `${what}: the Tabby plugin did not answer within ${pluginTimeoutSec()}s (tried twice). ` +
          'Tabby is probably overloaded — check `uptime` and its CPU. cctabs stopped rather than read a timeout as "nothing there". ' +
          'Raise the limit with CCTABS_TABBY_TIMEOUT=<seconds>.'
        : `${what}: ${reason}`,
    )
    this.name = 'TabbyPluginRequestError'
  }
}

/**
 * Split curl's `-w '\n%{http_code}'` output into the body and the status.
 * Returns null when the trailer is missing (curl died before writing it).
 */
export function splitCurlOutput(stdout: string): { status: number; body: string } | null {
  const nl = stdout.lastIndexOf('\n')
  if (nl < 0) return null
  const status = Number(stdout.slice(nl + 1).trim())
  if (!Number.isInteger(status) || status <= 0) return null
  return { status, body: stdout.slice(0, nl) }
}
