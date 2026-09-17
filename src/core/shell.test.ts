import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { resolveTabShell, tabLaunchArgv, envPrefixFor, shellQuoteArg } from './shell.js'

const SAVED = { SHELL: process.env.SHELL, CCTABS_SHELL: process.env.CCTABS_SHELL }

beforeEach(() => {
  delete process.env.CCTABS_SHELL
})
afterEach(() => {
  if (SAVED.SHELL === undefined) delete process.env.SHELL
  else process.env.SHELL = SAVED.SHELL
  if (SAVED.CCTABS_SHELL === undefined) delete process.env.CCTABS_SHELL
  else process.env.CCTABS_SHELL = SAVED.CCTABS_SHELL
})

describe('resolveTabShell', () => {
  it('uses $SHELL on posix, and falls back to zsh', () => {
    process.env.SHELL = '/bin/bash'
    expect(resolveTabShell('darwin')).toEqual({ command: '/bin/bash', posix: true })
    delete process.env.SHELL
    expect(resolveTabShell('linux')).toEqual({ command: '/bin/zsh', posix: true })
  })

  it('does NOT hand a POSIX launch line to PowerShell', () => {
    // Windows OpenSSH exports SHELL as powershell.exe, so the old
    // `process.env.SHELL ?? '/bin/zsh'` produced `powershell -l -i -c
    // '<posix>'`. The tab opened, PowerShell answered "The term '-l' is not
    // recognized", and `cctabs new` still exited 0.
    process.env.SHELL = 'c:\\windows\\system32\\windowspowershell\\v1.0\\powershell.exe'
    const shell = resolveTabShell('win32')
    expect(shell.command.toLowerCase()).not.toContain('powershell')
  })

  it('never falls back to /bin/zsh on win32', () => {
    delete process.env.SHELL
    expect(resolveTabShell('win32').command).not.toBe('/bin/zsh')
  })

  it('honours CCTABS_SHELL, and classifies it by basename', () => {
    process.env.CCTABS_SHELL = 'C:\\Program Files\\Git\\bin\\bash.exe'
    expect(resolveTabShell('win32')).toEqual({
      command: 'C:\\Program Files\\Git\\bin\\bash.exe',
      posix: true,
    })
    process.env.CCTABS_SHELL = 'C:\\Windows\\System32\\cmd.exe'
    expect(resolveTabShell('win32').posix).toBe(false)
  })
})

describe('tabLaunchArgv', () => {
  it('quotes the shell path in the trailing exec', () => {
    // Unquoted, the default Git for Windows path split on its space and the
    // tab showed `bash: exec: C:Program: not found` while the CLI reported
    // success.
    const shell = { command: 'C:\\Program Files\\Git\\bin\\bash.exe', posix: true }
    const argv = tabLaunchArgv(shell, 'claude --name "x"')
    const body = argv[3]!
    expect(body).toContain(`exec ${shellQuoteArg(shell.command)}`)
    expect(body).not.toContain('exec C:\\Program Files')
  })

  it('keeps the posix shape for a posix shell', () => {
    const argv = tabLaunchArgv({ command: '/bin/zsh', posix: true }, 'claude')
    expect(argv.slice(0, 3)).toEqual(['-l', '-i', '-c'])
    expect(argv[3]).toBe("claude; exec '/bin/zsh' -l -i")
  })

  it('uses cmd /k rather than emitting posix syntax into cmd', () => {
    const argv = tabLaunchArgv({ command: 'C:\\Windows\\System32\\cmd.exe', posix: false }, 'claude')
    expect(argv).toEqual(['/k', 'claude'])
    expect(argv.join(' ')).not.toContain('exec')
  })
})

describe('envPrefixFor', () => {
  it('is empty when there is nothing to set', () => {
    expect(envPrefixFor({ command: '/bin/zsh', posix: true }, undefined)).toBe('')
    expect(envPrefixFor({ command: '/bin/zsh', posix: true }, {})).toBe('')
  })

  it('writes a posix prefix for a posix shell', () => {
    expect(envPrefixFor({ command: '/bin/zsh', posix: true }, { A: 'b' })).toBe('A="b" ')
  })

  it('writes cmd `set` statements for cmd, not KEY=value', () => {
    // `A=b claude` is not cmd syntax; cmd would try to run a program called
    // `A=b`.
    const prefix = envPrefixFor({ command: 'cmd.exe', posix: false }, { A: 'b', C: 'd' })
    expect(prefix).toBe('set "A=b" && set "C=d" && ')
  })
})
