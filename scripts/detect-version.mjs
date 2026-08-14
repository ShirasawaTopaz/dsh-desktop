#!/usr/bin/env node
/**
 * Resolve the upstream dsh version to build for the desktop wrapper.
 *
 * Sources, in order:
 *   1. `--version <v>` (manual dispatch);
 *   2. `DSH_VERSION` environment;
 *   3. npm registry dist-tags (`latest` + `next`) of `@deepseek-ai/dsh`;
 *   4. GitHub tags of deepseek-ai/deepseek-harness matching `dsh-v*` (fallback
 *      when npm is unreachable or carries nothing new).
 *
 * Prints `version=<v>` and `prerelease=true|false` on stdout (GITHUB_OUTPUT
 * friendly). Semver comparison is minimal but correct for x.y.z[-pre[.n]]
 * shapes; prerelease ordering follows the npm rules (numeric identifiers
 * compare numerically, otherwise ASCII, fewer parts ranks higher).
 *
 * Usage: node scripts/detect-version.mjs [--version <v>] [--registry <url>]
 */

const NPM_PACKAGE = '@deepseek-ai/dsh'
const UPSTREAM_REPO = 'deepseek-ai/deepseek-harness'

function parseArgs(argv) {
  const args = { version: undefined, registry: 'https://registry.npmjs.org' }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--version') args.version = argv[++i]
    else if (arg === '--registry') args.registry = argv[++i]
    else {
      console.error(`detect-version: unknown argument ${arg}`)
      process.exit(2)
    }
  }
  return args
}

/** Split a version into [major, minor, patch, prereleaseParts[]]. */
function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version)
  if (match === null) return null
  const prerelease = match[4] === undefined ? [] : match[4].split('.')
  return [Number(match[1]), Number(match[2]), Number(match[3]), prerelease]
}

/** npm-style semver comparison; returns <0, 0, >0. */
function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (a === null || b === null) throw new Error(`unparseable version ${left} / ${right}`)
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  const ap = a[3]
  const bp = b[3]
  // A release outranks any prerelease of the same numbers.
  if (ap.length === 0 && bp.length === 0) return 0
  if (ap.length === 0) return 1
  if (bp.length === 0) return -1
  for (let i = 0; i < Math.min(ap.length, bp.length); i += 1) {
    const ai = ap[i]
    const bi = bp[i]
    if (ai === bi) continue
    const aNum = /^\d+$/.test(ai)
    const bNum = /^\d+$/.test(bi)
    if (aNum && bNum) return Number(ai) - Number(bi)
    if (aNum) return -1
    if (bNum) return 1
    return ai < bi ? -1 : 1
  }
  return ap.length - bp.length
}

function highest(candidates) {
  let best = null
  for (const candidate of candidates) {
    if (parseVersion(candidate) === null) continue
    if (best === null || compareVersions(candidate, best) > 0) best = candidate
  }
  return best
}

async function fromNpm(registry) {
  const response = await fetch(`${registry}/${NPM_PACKAGE.replace('/', '%2f')}`)
  if (!response.ok) throw new Error(`npm registry responded ${response.status}`)
  const doc = await response.json()
  const tags = doc['dist-tags'] ?? {}
  const candidates = []
  for (const value of Object.values(tags)) {
    if (typeof value === 'string') candidates.push(value)
  }
  return highest(candidates)
}

async function fromGitHubTags() {
  const response = await fetch(`https://api.github.com/repos/${UPSTREAM_REPO}/tags?per_page=50`)
  if (!response.ok) throw new Error(`github tags responded ${response.status}`)
  const tags = await response.json()
  const candidates = []
  for (const tag of tags) {
    if (typeof tag.name === 'string' && tag.name.startsWith('dsh-v')) {
      candidates.push(tag.name.slice('dsh-v'.length))
    }
  }
  return highest(candidates)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  let version = args.version ?? process.env.DSH_VERSION
  let from = 'argument'
  if (version === undefined) {
    try {
      version = await fromNpm(args.registry)
      from = 'npm dist-tags'
    } catch (error) {
      console.warn(`detect-version: npm lookup failed (${error.message}), falling back to GitHub tags`)
    }
  }
  if (version === undefined) {
    try {
      version = await fromGitHubTags()
      from = 'github tags'
    } catch (error) {
      console.error(`detect-version: no version source succeeded (${error.message})`)
      process.exit(1)
    }
  }
  if (version === undefined || parseVersion(version) === null) {
    console.error('detect-version: no candidate version found')
    process.exit(1)
  }
  const prerelease = parseVersion(version)[3].length > 0
  console.log(`version=${version}`)
  console.log(`prerelease=${prerelease ? 'true' : 'false'}`)
  console.log(`source=${from}`)
}

await main()
