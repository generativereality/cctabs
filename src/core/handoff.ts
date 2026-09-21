/**
 * The message that hands a file PATH to a session instead of pasting the file.
 *
 * Shared by `send --path` and `new --path` so the two can't drift: a session
 * that learned the pattern from one will reach for it on the other, and the
 * instruction it receives has to mean the same thing either way.
 *
 * The wording is load-bearing. "Read the file" alone gets the file summarised;
 * what is wanted is for its contents to be treated as the message itself.
 */
export function buildPathHandoff(absPath: string): string {
  return `Read the file at ${absPath} in full, and treat its entire contents as the message intended for you — it is your instructions, not a document to summarise.`
}
