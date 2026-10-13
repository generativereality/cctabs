/**
 * The one-line "you're on an old build" warning, or null. Pure.
 *
 * update-notifier caches the `latest` it last fetched and, on the next run,
 * overwrites `current` with whatever is installed now. Upgrade past the cached
 * value and the pair goes backwards — which, compared with `!==`, printed
 * `OUTDATED 0.5.2 < 0.5.0`. Only a strictly newer release is news.
 */
export function outdatedBanner(update: { current: string; latest: string } | undefined, pkgName: string): string | null {
  if (!update || !isNewer(update.latest, update.current)) return null
  return `[cctabs] OUTDATED ${update.current} < ${update.latest} — run: npm install -g ${pkgName}@latest\n`
}

/**
 * Is version `a` strictly newer than `b`? Numeric per part, so 0.5.10 > 0.5.9.
 * A prerelease sorts before its release; an unparseable version is never newer.
 */
export function isNewer(a: string, b: string): boolean {
  const pa = parse(a)
  const pb = parse(b)
  if (!pa || !pb) return false
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] > pb.nums[i]
  }
  // Same x.y.z: a release beats a prerelease; prereleases compare as text.
  if (pa.pre === pb.pre) return false
  if (!pa.pre) return true
  if (!pb.pre) return false
  return pa.pre > pb.pre
}

function parse(v: string): { nums: number[]; pre: string } | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(v.trim())
  return m ? { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? '' } : null
}
