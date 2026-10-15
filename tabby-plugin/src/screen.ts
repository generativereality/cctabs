/**
 * The visible screen of a terminal tab, read from its xterm. Generic — nothing
 * here knows about Claude.
 *
 * The output ring buffer (`/buffer`) is the PTY stream with escapes stripped,
 * which is not a screen: a TUI redraws by diffs, so a typed character arrives
 * as itself with the cursor moves around it gone, and a backspace leaves no
 * trace. "What is in the input box right now" can only be read off the grid.
 *
 * Only a tab whose frontend has attached has an xterm (Tabby attaches on first
 * focus), so `attached: false` is a real answer: nobody has typed into such a
 * tab in Tabby, but nothing can be read from it either.
 */

/** The slice of xterm's buffer API this reads. */
interface XCell { getChars (): string, getWidth (): number, isDim (): number }
interface XLine { length: number, getCell (x: number): XCell | undefined, translateToString (trimRight?: boolean): string }
interface XBuffer { viewportY: number, baseY: number, cursorY: number, getLine (y: number): XLine | undefined }
export interface XTermLike { rows: number, buffer: { active: XBuffer } }

export interface ScreenRow {
  text: string
  /** [start, end) column ranges of dim text, in `text`'s character offsets. */
  dim: Array<[number, number]>
}

export interface Screen {
  attached: boolean
  rows: ScreenRow[]
  /** Cursor row within `rows`, when the cursor is on screen. */
  cursorRow?: number
}

export function readScreen (xterm: XTermLike | undefined | null): Screen {
  if (!xterm?.buffer?.active) return { attached: false, rows: [] }
  const buf = xterm.buffer.active
  const rows: ScreenRow[] = []
  for (let r = 0; r < xterm.rows; r++) {
    const line = buf.getLine(buf.viewportY + r)
    if (!line) { rows.push({ text: '', dim: [] }); continue }
    let text = ''
    const dim: Array<[number, number]> = []
    let dimStart = -1
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x)
      if (!cell || cell.getWidth() === 0) continue // the right half of a wide char
      const chars = cell.getChars() || ' '
      const isDim = !!cell.isDim()
      if (isDim && dimStart < 0) dimStart = text.length
      if (!isDim && dimStart >= 0) { dim.push([dimStart, text.length]); dimStart = -1 }
      text += chars
    }
    if (dimStart >= 0) dim.push([dimStart, text.length])
    const trimmed = text.replace(/\s+$/, '')
    rows.push({
      text: trimmed,
      dim: dim.map(([s, e]) => [s, Math.min(e, trimmed.length)] as [number, number]).filter(([s, e]) => e > s),
    })
  }
  // The cursor is relative to the bottom page (baseY); the viewport may be
  // scrolled up, in which case it is not on screen.
  const cursorRow = buf.baseY + buf.cursorY - buf.viewportY
  return {
    attached: true,
    rows,
    ...(cursorRow >= 0 && cursorRow < xterm.rows ? { cursorRow } : {}),
  }
}
