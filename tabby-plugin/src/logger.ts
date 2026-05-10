import { Injectable } from '@angular/core'
import { appendFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const LOG_PATH = process.env.CCTABS_PLUGIN_LOG
  ?? join(homedir(), 'Library', 'Logs', 'tabby-cctabs.log')

function fmt (level: string, args: unknown[]): string {
  const parts = args.map(a => {
    if (typeof a === 'string') return a
    if (a instanceof Error) return `${a.name}: ${a.message}`
    try { return JSON.stringify(a) } catch { return String(a) }
  })
  return `${new Date().toISOString()} [cctabs] ${level} ${parts.join(' ')}\n`
}

@Injectable({ providedIn: 'root' })
export class CctabsLogger {
  info (...args: unknown[]): void { this.write('INFO', args) }
  warn (...args: unknown[]): void { this.write('WARN', args) }
  error (...args: unknown[]): void { this.write('ERROR', args) }

  private write (level: string, args: unknown[]): void {
    // eslint-disable-next-line no-console
    console.log('[cctabs]', level, ...args)
    try { appendFileSync(LOG_PATH, fmt(level, args)) } catch {}
  }
}
