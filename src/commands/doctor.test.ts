import { describe, expect, it } from 'bun:test'
import { agentBashResult, AGENT_BASH_CHECK, disabledPlugins, installedPluginVersion, lastLine, skillVersionResult } from './doctor.js'

describe('agentBashResult', () => {
  it('passes when bash is already on PATH', () => {
    const r = agentBashResult('C:\\Program Files\\Git\\bin\\bash.exe', undefined)
    expect(r.status).toBe('ok')
    expect(r.name).toBe(AGENT_BASH_CHECK)
    expect(r.hint).toBeUndefined()
  })

  // The whole point of the check: cctabs works, Claude Code quietly does not,
  // so the hint has to name the consequence AND the exact directory to add.
  it('names the directory to add when Git Bash exists but is not on PATH', () => {
    const r = agentBashResult(undefined, 'C:\\Program Files\\Git\\bin\\bash.exe')
    expect(r.status).toBe('warn')
    expect(r.detail).toContain('not on PATH')
    expect(r.hint).toContain('C:\\Program Files\\Git\\bin')
    expect(r.hint).toContain('setx PATH')
    expect(r.hint).toContain('Bash allowlist')
  })

  it('tells you to install Git when there is no bash at all', () => {
    const r = agentBashResult(undefined, undefined)
    expect(r.status).toBe('warn')
    expect(r.hint).toContain('Install Git for Windows')
    expect(r.hint).not.toContain('setx')
  })

  it('never reports failure — cctabs itself is unaffected', () => {
    for (const r of [
      agentBashResult(undefined, undefined),
      agentBashResult(undefined, 'C:\\Git\\bin\\bash.exe'),
    ]) expect(r.status).not.toBe('fail')
  })
})

describe('lastLine', () => {
  // Seen on macOS Terminal: the login shell's banner arrived first and the
  // check reported "Restored session: …" as where claude lives.
  it('skips a banner the login shell printed before the answer', () => {
    expect(lastLine('Restored session: Wed 23 Sep 2026\n/Users/x/.local/bin/claude\n'))
      .toBe('/Users/x/.local/bin/claude')
  })

  it('handles CRLF and a bare answer', () => {
    expect(lastLine('C:\\Git\\bin\\bash.exe\r\n')).toBe('C:\\Git\\bin\\bash.exe')
  })
})

describe('skillVersionResult', () => {
  // The case the check exists for: Claude reads a skill releases behind the CLI.
  it('warns when the skill is older than the CLI, and says how to update', () => {
    const r = skillVersionResult('0.5.0', '0.7.2')
    expect(r.status).toBe('warn')
    expect(r.detail).toContain('0.5.0')
    expect(r.hint).toContain('Update generativereality')
  })

  it('passes when they match, or the skill is ahead', () => {
    expect(skillVersionResult('0.7.2', '0.7.2').status).toBe('ok')
    expect(skillVersionResult('0.7.3', '0.7.2').status).toBe('ok')
  })

  it('compares numerically, not as text', () => {
    expect(skillVersionResult('0.5.9', '0.5.10').status).toBe('warn')
  })

  it('skips without failing when the plugin is not installed', () => {
    expect(skillVersionResult(undefined, '0.7.2').status).toBe('skip')
  })
})

describe('disabledPlugins', () => {
  it('lists the plugins set to false, and nothing for a broken file', () => {
    expect([...disabledPlugins(JSON.stringify({ enabledPlugins: { 'a@x': false, 'b@x': true } }))]).toEqual(['a@x'])
    expect(disabledPlugins('{').size).toBe(0)
  })
})

describe('installedPluginVersion', () => {
  it('reads the cctabs entry from installed_plugins.json', () => {
    const json = JSON.stringify({
      version: 2,
      plugins: {
        'other@x': [{ version: '9.9.9' }],
        'cctabs@generativereality': [{ scope: 'user', version: '0.7.1' }, { scope: 'project', version: '0.6.0' }],
      },
    })
    expect(installedPluginVersion(json)).toBe('0.7.1')
  })

  // A disabled plugin stays installed; Claude does not read its skill.
  it('skips a plugin that settings.json disables', () => {
    const json = JSON.stringify({
      plugins: {
        'cctabs@generativereality': [{ version: '0.7.2' }],
        'acme-tools-cctabs@acme': [{ version: '1.2.2' }],
      },
    })
    const disabled = disabledPlugins(JSON.stringify({ enabledPlugins: { 'cctabs@generativereality': false, 'acme-tools-cctabs@acme': true } }))
    expect(installedPluginVersion(json, disabled)).toBe('1.2.2')
    expect(installedPluginVersion(json, disabledPlugins(JSON.stringify({ enabledPlugins: { 'acme-tools-cctabs@acme': false } })))).toBe('0.7.2')
  })

  it("reads a repackaged per-tool plugin named <prefix>-cctabs", () => {
    const json = JSON.stringify({ plugins: { 'acme-tools@acme': [{ version: '0.1.4' }], 'acme-tools-cctabs@acme': [{ version: '1.2.2' }] } })
    expect(installedPluginVersion(json)).toBe('1.2.2')
  })

  it('is undefined for no install or a broken file', () => {
    expect(installedPluginVersion('{"plugins":{}}')).toBeUndefined()
    expect(installedPluginVersion('nope')).toBeUndefined()
  })
})
