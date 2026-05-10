/** Strip ANSI escape sequences and split into lines. Optional last-N. */
export function bufferLines (text: string, lastN?: number): string[] {
  const stripped = text
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '') // OSC sequences
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')       // CSI sequences
    .replace(/\x1b[()][AB012]/g, '')               // charset designators
    .replace(/\r/g, '')

  const lines = stripped.split('\n')
  if (lastN && lines.length > lastN) return lines.slice(-lastN)
  return lines
}
