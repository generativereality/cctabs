import { Injectable } from '@angular/core'

@Injectable({ providedIn: 'root' })
export class CctabsLogger {
  private prefix = '[cctabs]'

  info (...args: unknown[]): void {
    // eslint-disable-next-line no-console
    console.log(this.prefix, ...args)
  }

  warn (...args: unknown[]): void {
    // eslint-disable-next-line no-console
    console.warn(this.prefix, ...args)
  }

  error (...args: unknown[]): void {
    // eslint-disable-next-line no-console
    console.error(this.prefix, ...args)
  }
}
