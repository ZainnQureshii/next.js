import { PassThrough } from 'stream'
import { promptUpgrade } from 'next/dist/lib/upgrade/prompt'

describe('upgrade menu', () => {
  const stdin = Object.getOwnPropertyDescriptor(process, 'stdin')!
  let input: PassThrough & { isRaw: boolean; setRawMode: jest.Mock }
  let output: string

  beforeEach(() => {
    input = Object.assign(new PassThrough(), {
      isRaw: false,
      setRawMode: jest.fn(),
    })
    input.pause()
    Object.defineProperty(process, 'stdin', {
      configurable: true,
      value: input,
    })
    output = ''
    jest.spyOn(process.stdout, 'write').mockImplementation((data: any) => {
      output += data.toString()
      return true
    })
  })

  afterEach(() => {
    input.destroy()
    Object.defineProperty(process, 'stdin', stdin)
    jest.restoreAllMocks()
  })

  it('keeps build output visible after Skip', async () => {
    const exits = process.listenerCount('exit')
    const pending = promptUpgrade(
      'Shared recommendation',
      new AbortController().signal
    )

    expect(output).toContain('Shared recommendation')
    expect(output).toContain('Upgrade now')
    expect(output).toContain('Skip until next version')

    // A build warning arrives while the menu is awaiting the user's choice.
    process.stdout.write('BUILD_WARNING\n')
    input.emit('keypress', '', { name: 'down' })
    input.emit('keypress', '', { name: 'return' })

    await expect(pending).resolves.toBe('skip')
    expect(output).toContain('BUILD_WARNING\n')
    expect(output.indexOf('BUILD_WARNING')).toBeLessThan(
      output.lastIndexOf('✓ Skip')
    )
    // The menu never switches screens or clears a line containing a log.
    expect(output).not.toContain('\x1b[?1049')
    expect(output).not.toContain('\x1b[2J')
    expect(output).not.toContain('\x1b[2K')
    expect(output).not.toContain('\x1b[H')
    expect(input.setRawMode.mock.calls).toEqual([[true], [false]])
    expect(input.isPaused()).toBe(true)
    expect(input.listenerCount('keypress')).toBe(0)
    expect(process.listenerCount('exit')).toBe(exits)
  })

  it('returns Upgrade now and offers Skip without it', async () => {
    const upgrade = promptUpgrade('Reminder', new AbortController().signal)
    input.emit('keypress', '', { name: 'return' })
    await expect(upgrade).resolves.toBe('update')

    output = ''
    input.isRaw = true
    input.resume()
    const noUpgrade = promptUpgrade(
      'No eligible target',
      new AbortController().signal,
      false
    )
    expect(output).not.toContain('Upgrade now')
    input.emit('keypress', '', { name: 'down' })
    input.emit('keypress', '', { name: 'return' })
    await expect(noUpgrade).resolves.toBe('dismiss')
    expect(input.setRawMode).toHaveBeenLastCalledWith(true)
    expect(input.isPaused()).toBe(false)
  })

  it('keeps the choice on resize without redrawing logs', async () => {
    const pending = promptUpgrade('Reminder', new AbortController().signal)
    input.emit('keypress', '', { name: 'down' })
    const beforeResize = output
    process.stdout.emit('resize')
    expect(output).toBe(beforeResize)
    input.emit('keypress', '', { name: 'return' })
    await expect(pending).resolves.toBe('skip')
  })

  if (process.platform !== 'win32') {
    it('restores input before direct suspension and redraws on continue', async () => {
      const stop = jest.spyOn(process, 'kill').mockImplementation(() => true)
      const register = jest.spyOn(process, 'on')
      const unregister = jest.spyOn(process, 'removeListener')
      const pending = promptUpgrade('Reminder', new AbortController().signal)
      const suspend = register.mock.calls.find(
        ([event]) => event === 'SIGTSTP'
      )?.[1] as () => void
      const resume = register.mock.calls.find(
        ([event]) => event === 'SIGCONT'
      )?.[1] as () => void

      // Jest does not deliver process signals, so invoke the installed
      // listeners while keeping SIGSTOP from suspending the test runner.
      input.emit('keypress', '', { name: 'down' })
      suspend()

      expect(input.setRawMode).toHaveBeenLastCalledWith(false)
      expect(input.isPaused()).toBe(true)
      expect(stop).toHaveBeenCalledWith(process.pid, 'SIGSTOP')

      resume()

      expect(input.setRawMode).toHaveBeenLastCalledWith(true)
      expect(output.match(/Reminder/g)).toHaveLength(2)
      expect(output.slice(output.lastIndexOf('Reminder'))).toMatch(/❯.*Skip/)

      input.emit('keypress', '', { name: 'return' })
      await expect(pending).resolves.toBe('skip')
      expect(unregister).toHaveBeenCalledWith('SIGTSTP', suspend)
      expect(unregister).toHaveBeenCalledWith('SIGCONT', resume)
    })
  }

  it('restores input on abort and interruption', async () => {
    const controller = new AbortController()
    const aborted = promptUpgrade('Reminder', controller.signal)
    controller.abort()
    await expect(aborted).resolves.toBe('skip')
    expect(input.setRawMode).toHaveBeenLastCalledWith(false)

    const interrupted = promptUpgrade('Reminder', new AbortController().signal)
    input.emit('keypress', '', { name: 'c', ctrl: true })
    await expect(interrupted).resolves.toBe('interrupt')
    expect(input.setRawMode).toHaveBeenLastCalledWith(false)

    const suspended = promptUpgrade('Reminder', new AbortController().signal)
    input.emit('keypress', '', { name: 'z', ctrl: true })
    await expect(suspended).resolves.toBe('skip')
    expect(input.setRawMode).toHaveBeenLastCalledWith(false)

    const escaped = promptUpgrade('Reminder', new AbortController().signal)
    input.emit('keypress', '', { name: 'escape' })
    await expect(escaped).resolves.toBe('skip')
    expect(input.setRawMode).toHaveBeenLastCalledWith(false)
  })

  it('restores the original input state if rendering fails', async () => {
    input.isRaw = true
    input.resume()
    jest.spyOn(process.stdout, 'write').mockImplementation(() => {
      throw new Error('Rendering failed')
    })

    await expect(
      promptUpgrade('Reminder', new AbortController().signal)
    ).rejects.toThrow('Rendering failed')
    expect(input.setRawMode.mock.calls).toEqual([[true], [true]])
    expect(input.isPaused()).toBe(false)
    expect(input.listenerCount('keypress')).toBe(0)
  })
})
