import { define } from 'gunshi'
import { consola } from 'consola'
import { writeFileSync, existsSync } from 'fs'
import { tmpdir, homedir } from 'os'
import { join, resolve } from 'path'
import { openSession } from '../core/open-session.js'
import { resolveBackend, listBackends } from '../core/backends.js'
import { expandSessionId, pathToProjectSlug } from '../core/session.js'
import { setupWorktree } from '../core/worktree.js'

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
    resume: { type: 'string', short: 'r', description: 'Resume an existing Claude session ID (passes --resume <id> to claude). Mutually exclusive with --prompt/--file.' },
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
    const resumeId = ctx.values.resume as string | undefined
    const backendName = ctx.values.backend as string | undefined
    const modelOverride = ctx.values.model as string | undefined
    if (!name) { consola.error('Tab name is required'); process.exit(1) }

    if (resumeId && (promptText || promptFile)) {
      consola.error('--resume cannot be combined with --prompt or --file (you cannot send an initial prompt to a resumed session via this path).')
      process.exit(1)
    }

    let resolvedSessionId: string | undefined
    if (resumeId) {
      const absDir = resolve(dir.replace(/^~/, homedir()))
      const expanded = expandSessionId(resumeId, absDir) ?? expandSessionId(resumeId)
      if (expanded) {
        resolvedSessionId = expanded
      } else {
        const slug = pathToProjectSlug(absDir)
        const expected = join(homedir(), '.claude', 'projects', slug, `${resumeId}.jsonl`)
        if (existsSync(expected)) {
          resolvedSessionId = resumeId
        } else {
          consola.warn(`Session ID "${resumeId}" not found in ~/.claude/projects/ — proceeding anyway (claude will error if invalid).`)
          resolvedSessionId = resumeId
        }
      }
    }

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

    // When --worktree is requested, create the worktree explicitly here so it's
    // anchored to the target repo's current HEAD. Delegating to `claude --worktree`
    // can branch from the upstream tracking ref (or other unexpected commit) when
    // local commits aren't pushed — silently producing a stale-base worktree.
    let sessionDir = dir
    let worktreeInfo: { worktreePath: string; baseSha: string } | undefined
    if (useWorktree) {
      try {
        const wt = setupWorktree(dir, name)
        sessionDir = wt.worktreePath
        worktreeInfo = wt
        if (wt.created) {
          const branchNote = wt.reusedBranch ? ` (reused existing branch ${wt.branchName})` : ''
          consola.info(`Worktree created at ${wt.worktreePath} (base ${wt.baseSha.slice(0, 8)})${branchNote}`)
          if (wt.baseSha !== wt.parentHeadSha) {
            consola.warn(`Worktree base ${wt.baseSha.slice(0, 8)} differs from ${dir} HEAD ${wt.parentHeadSha.slice(0, 8)} — branch '${wt.branchName}' already existed and was checked out at its prior tip.`)
          }
        } else {
          consola.info(`Worktree already present at ${wt.worktreePath} (base ${wt.baseSha.slice(0, 8)}) — reusing`)
        }
      } catch (e: any) {
        consola.error(e?.message ?? String(e))
        process.exit(1)
      }
    }

    let claudeCmd: string
    if (resolvedSessionId) {
      claudeCmd = `claude --resume ${resolvedSessionId} --name ${JSON.stringify(name)}`
    } else {
      claudeCmd = 'claude'
    }

    const tabId = await openSession({
      tabName: name,
      dir: sessionDir,
      claudeCmd,
      workspaceQuery: workspace,
      initialPromptFile,
      envVars,
      modelOverride: resolvedModel,
      afterActive: true,
    })
    const wt = worktreeInfo ? ` (worktree: .claude/worktrees/${name} @ ${worktreeInfo.baseSha.slice(0, 8)})` : ''
    const be = backendName ? ` [backend: ${backendName}${resolvedModel ? ` → ${resolvedModel}` : ''}]` : ''
    const rs = resolvedSessionId ? ` --resume ${resolvedSessionId.slice(0, 8)}…` : ''
    consola.success(`Tab "${name}" [${tabId.slice(0, 8)}] → claude${rs} at ${dir}${wt}${be}`)
  },
})
