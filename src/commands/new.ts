import { define } from 'gunshi'
import { consola } from 'consola'
import { writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { openSession } from '../core/open-session.js'

export const newCommand = define({
  name: 'new',
  description: 'Open a new tab and launch claude',
  args: {
    name: { type: 'positional', description: 'Tab name' },
    dir: { type: 'positional', description: 'Working directory / repo root (default: cwd)' },
    workspace: { type: 'string', short: 'w', description: 'Target workspace' },
    worktree: { type: 'boolean', short: 'W', description: 'Launch claude with --worktree <name> for isolated branch work' },
    file: { type: 'string', short: 'f', description: 'Send initial prompt from file once Claude is ready' },
    prompt: { type: 'string', short: 'p', description: 'Send initial prompt text once Claude is ready' },
  },
  async run(ctx) {
    const name = ctx.positionals[1]
    const dir = ctx.positionals[2] ?? process.cwd()
    const workspace = ctx.values.workspace
    const useWorktree = ctx.values.worktree ?? false
    const promptFile = ctx.values.file as string | undefined
    const promptText = ctx.values.prompt as string | undefined
    if (!name) { consola.error('Tab name is required'); process.exit(1) }

    // If prompt text provided, write to temp file so we can pass it via --file
    let initialPromptFile: string | undefined
    if (promptText) {
      initialPromptFile = join(tmpdir(), `herd-prompt-${Date.now()}.txt`)
      writeFileSync(initialPromptFile, promptText)
    } else if (promptFile) {
      initialPromptFile = promptFile
    }

    const claudeCmd = useWorktree ? `claude --worktree ${JSON.stringify(name)}` : 'claude'
    const tabId = await openSession({ tabName: name, dir, claudeCmd, workspaceQuery: workspace, initialPromptFile })
    const suffix = useWorktree ? ` (worktree: .claude/worktrees/${name})` : ''
    consola.success(`Tab "${name}" [${tabId.slice(0, 8)}] → claude at ${dir}${suffix}`)
  },
})
