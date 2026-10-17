import type { ArgSpecLike } from './unknown-options.js'

/** args-tokens mistakes '--' ANYWHERE in a separate value for an option.
 * Inline declared value options before gunshi sees them; leave raw process.argv
 * intact for send's positional recovery and unknown-option diagnostics.
 */
export function inlineValueOptions(argv: string[], schema: Record<string, ArgSpecLike>): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === '--') { out.push(...argv.slice(i)); break }
    const entry = Object.entries(schema).find(([name, spec]) => token === '--' + name || (spec.short && token === '-' + spec.short))
    const value = argv[i + 1]
    if (entry && ['string', 'number'].includes(entry[1].type) && value !== undefined && (!value.startsWith('-') || (entry[1].type === 'number' && /^-\d/.test(value)))) {
      out.push(`--${entry[0]}=${value}`); i++
    } else out.push(token)
  }
  return out
}
