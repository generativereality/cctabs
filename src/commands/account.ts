import { spawnSync } from 'child_process'
import { homedir } from 'os'
import { define } from 'gunshi'
import { consola } from 'consola'
import { isCancel, password } from '@clack/prompts'
import { requireAdapter } from '../core/adapter.js'
import { listBackendSpecs, resolveBackend } from '../core/backends.js'
import { CONFIG_PATH } from '../core/config.js'
import { resolveTabShell, shellQuoteArg, tabLaunchArgv } from '../core/shell.js'
import {
  accountNameProblem,
  defaultAccountConfigDir,
  normaliseToken,
  ownLoginChanged,
  parseAuthStatus,
  writeAccountPreset,
  type AuthStatus,
} from '../core/account.js'

/**
 * `claude auth status` for one environment. CLAUDE_CODE_OAUTH_TOKEN is dropped
 * for the person's own login, so an inherited account token can't answer for it.
 */
function authStatus(env: Record<string, string | undefined>): AuthStatus | null {
  const r = spawnSync('claude', ['auth', 'status', '--json'], { encoding: 'utf-8', env: env as NodeJS.ProcessEnv, timeout: 20000 })
  return r.status === 0 ? parseAuthStatus(r.stdout) : null
}

function ownEnv(): Record<string, string | undefined> {
  const { CLAUDE_CODE_OAUTH_TOKEN: _t, CLAUDE_CONFIG_DIR: _d, CCTABS_ACTIVE_BACKEND: _b, ...rest } = process.env
  return rest
}

/**
 * The sign-in has to be a person at a keyboard (OAuth in a browser), and the
 * agent that asked for it should not be holding the token afterwards. So from
 * an agent's Bash tool, which has no terminal, the command opens a tab and runs
 * itself there, where the person can sign in and paste.
 */
async function openInTab(name: string, configDir: string): Promise<void> {
  const adapter = requireAdapter()
  if (!adapter.openTabDirect) {
    consola.error('`cctabs account add` needs a terminal to sign in from. Run it yourself in a terminal tab.')
    process.exit(1)
  }
  const shell = resolveTabShell()
  const self = [process.execPath, process.argv[1], 'account', 'add', name, '--config-dir', configDir]
  const body = shell.posix ? self.map(shellQuoteArg).join(' ') : self.map((s) => `"${s}"`).join(' ')
  const { tabId } = await adapter.openTabDirect({
    cwd: homedir(),
    title: `account: ${name}`,
    command: shell.command,
    args: tabLaunchArgv(shell, body),
    afterActive: true,
  })
  adapter.closeSocket()
  consola.success(`Opened tab "account: ${name}" [${tabId.slice(0, 8)}]. Sign in as ${name}'s account there; the tab says when the preset is saved.`)
  consola.info(`Then: cctabs new <tab> <dir> -b ${name}`)
}

async function addAccount(name: string, configDir: string): Promise<void> {
  consola.info(`Adding the Claude account "${name}" (its own config dir: ${configDir}).`)
  consola.info(`A browser opens next. Sign in as the account you are adding, not as yourself.`)
  const before = authStatus(ownEnv())

  const mint = spawnSync('claude', ['setup-token'], {
    stdio: 'inherit',
    env: { ...ownEnv(), CLAUDE_CONFIG_DIR: configDir } as NodeJS.ProcessEnv,
  })
  if (mint.status !== 0) {
    consola.error(`\`claude setup-token\` exited ${mint.status ?? 'abnormally'}; nothing was saved.`)
    process.exit(1)
  }

  const pasted = await password({
    message: 'Paste the token it printed (sk-ant-oat…). It is saved to the config file, not shown.',
    validate: (v) => (normaliseToken(v ?? '') ? undefined : "That doesn't look like a setup-token (sk-ant-oat…)."),
  })
  if (isCancel(pasted)) {
    consola.warn('Cancelled; nothing was saved.')
    process.exit(1)
  }
  const token = normaliseToken(pasted)!

  try {
    writeAccountPreset(name, token, configDir)
  } catch (e) {
    consola.error((e as Error).message)
    process.exit(1)
  }
  consola.success(`Saved [backends.${name}] in ${CONFIG_PATH} (owner-only, 0600).`)

  const theirs = authStatus({ ...ownEnv(), CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_OAUTH_TOKEN: token })
  if (theirs?.loggedIn) consola.success(`-b ${name} runs as ${theirs.email ?? 'the new account'}.`)
  else consola.warn(`Couldn't confirm the new token with \`claude auth status\`; try \`cctabs new test ~ -b ${name}\`.`)

  const after = authStatus(ownEnv())
  if (ownLoginChanged(before, after)) {
    consola.warn(`Your own login changed (${before?.email ?? 'you'} → ${after?.loggedIn ? after.email : 'signed out'}). Signing you back in:`)
    spawnSync('claude', ['auth', 'login'], { stdio: 'inherit', env: ownEnv() as NodeJS.ProcessEnv })
  }
  consola.info(`Use it: cctabs new <tab> <dir> -b ${name}`)
}

export const accountCommand = define({
  name: 'account',
  description: 'Add another Claude account (a client\'s, an org\'s) as a backend preset: `cctabs account add <name>` opens a tab where YOU sign in as that account; cctabs stores its token itself (0600). `cctabs account list` shows the accounts. Then `cctabs new <tab> <dir> -b <name>`.',
  args: {
    action: { type: 'positional', description: 'add | list' },
    'config-dir': { type: 'string', description: 'The account\'s Claude config dir (default ~/.claude-<name>)' },
  },
  async run(ctx) {
    const action = ctx.positionals[1]
    const name = ctx.positionals[2]

    if (action === 'list') {
      const accounts = listBackendSpecs().filter(({ spec }) => spec.env.CLAUDE_CODE_OAUTH_TOKEN)
      if (!accounts.length) {
        consola.info('No other Claude accounts yet. Add one: cctabs account add <name>')
        return
      }
      for (const { name: n, spec } of accounts) {
        consola.log(`  ${n.padEnd(22)} ${spec.env.CLAUDE_CONFIG_DIR ?? '(default config dir)'}`)
      }
      return
    }
    if (action !== 'add') {
      consola.error('Usage: cctabs account add <name>  |  cctabs account list')
      process.exit(1)
    }

    const problem = accountNameProblem(name)
    if (problem) { consola.error(problem); process.exit(1) }
    if (resolveBackend(name)) {
      consola.error(`A backend preset "${name}" already exists (\`cctabs backends\`). Pick another name, or remove [backends.${name}] from ${CONFIG_PATH} first.`)
      process.exit(1)
    }

    const configDir = (ctx.values['config-dir'] as string | undefined)?.replace(/^~(?=$|\/)/, homedir()) ?? defaultAccountConfigDir(name)
    if (!process.stdin.isTTY) return openInTab(name, configDir)
    await addAccount(name, configDir)
  },
})
