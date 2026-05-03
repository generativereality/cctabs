import { define } from 'gunshi'
import { consola } from 'consola'
import { writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { openSession } from '../core/open-session.js'
import { resolveBackend, listBackends } from '../core/backends.js'

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
    backend: { type: 'string', short: 'b', description: 'Backend preset (e.g. kimi, qwen-cloud, qwen-next-local, gpt-oss). Run `cctabs backends` to list.' },
    model: { type: 'string', short: 'm', description: 'Override the model name (passed as --model to claude). Useful with --backend ollama-local.' },
  },
  async run(ctx) {
    const name = ctx.positionals[1]
    const dir = ctx.positionals[2] ?? process.cwd()
    const workspace = ctx.values.workspace
    const useWorktree = ctx.values.worktree ?? false
    const promptFile = ctx.values.file as string | undefined
    const promptText = ctx.values.prompt as string | undefined
    const backendName = ctx.values.backend as string | undefined
    const modelOverride = ctx.values.model as string | undefined
    if (!name) { consola.error('Tab name is required'); process.exit(1) }

    let envVars: Record<string, string> | undefined
    let resolvedModel = modelOverride
    if (backendName) {
      const backend = resolveBackend(backendName)
      if (!backend) {
        consola.error(`Unknown backend "${backendName}". Available:`)
        for (const b of listBackends()) consola.log(`  ${b.name.padEnd(22)} ${b.description}`)
        process.exit(1)
      }
      envVars = backend.env
      resolvedModel ??= backend.model || undefined
    }

    // If prompt text provided, write to temp file so we can pass it via --file
    let initialPromptFile: string | undefined
    if (promptText) {
      initialPromptFile = join(tmpdir(), `cctabs-prompt-${Date.now()}.txt`)
      writeFileSync(initialPromptFile, promptText)
    } else if (promptFile) {
      initialPromptFile = promptFile
    }

    const claudeCmd = useWorktree ? `claude --worktree ${JSON.stringify(name)}` : 'claude'
    const tabId = await openSession({
      tabName: name,
      dir,
      claudeCmd,
      workspaceQuery: workspace,
      initialPromptFile,
      envVars,
      modelOverride: resolvedModel,
    })
    const wt = useWorktree ? ` (worktree: .claude/worktrees/${name})` : ''
    const be = backendName ? ` [backend: ${backendName}${resolvedModel ? ` → ${resolvedModel}` : ''}]` : ''
    consola.success(`Tab "${name}" [${tabId.slice(0, 8)}] → claude at ${dir}${wt}${be}`)
  },
})
