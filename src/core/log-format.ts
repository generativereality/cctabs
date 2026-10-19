/**
 * Making an error the LAST line a caller sees.
 *
 * consola draws errors and warnings as badges, and pads a badge with a blank
 * line above and below. So the last line cctabs wrote to stderr on failure was
 * always empty, and an agent that kept only the end of the output —
 * `cctabs send … 2>&1 | tail -1` — saw nothing at all: no ✔, no ERROR. The
 * brands-dev tab lost hours to that on 2026-10-17, re-sending into a tab that
 * was refusing every send with an error it never got to read.
 *
 * So the padding goes. The badge itself stays: ` ERROR ` is what people grep.
 */

/** Strip the blank lines consola puts around a badge. Pure. */
export function unpadBadge(formatted: string): string {
  return formatted.replace(/^\n/, '').replace(/\n$/, '')
}

interface ReporterLike { formatLogObj?: (logObj: unknown, opts: unknown) => string }

/** Apply `unpadBadge` to every reporter of a consola instance. */
export function tightenConsola(instance: { options: { reporters: unknown[] } }): void {
  for (const r of instance.options.reporters as ReporterLike[]) {
    const format = r.formatLogObj
    if (typeof format !== 'function') continue
    r.formatLogObj = function (this: unknown, logObj: unknown, opts: unknown) {
      return unpadBadge(format.call(this, logObj, opts))
    }
  }
}
