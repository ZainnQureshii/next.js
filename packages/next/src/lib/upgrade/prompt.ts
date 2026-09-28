import { emitKeypressEvents, type Key } from 'readline'
import { bold, cyan } from '../picocolors'

export type UpgradeAction = 'update' | 'skip' | 'dismiss' | 'interrupt'

export async function promptUpgrade(
  message: string,
  signal: AbortSignal,
  canUpdate: boolean = true
): Promise<UpgradeAction> {
  if (signal.aborted) {
    return 'skip'
  }

  const input = process.stdin
  const terminal = process.stdout
  const choices: { action: UpgradeAction; label: string }[] = [
    ...(canUpdate ? [{ action: 'update' as const, label: 'Upgrade now' }] : []),
    { action: 'skip', label: 'Skip' },
    { action: 'dismiss', label: 'Skip until next version' },
  ]
  const wasRaw = input.isRaw ?? false
  const wasFlowing = input.readableFlowing
  let selectedIndex = 0
  let restored = false
  let suspended = false
  let choose!: (action: UpgradeAction) => void
  let fail!: (error: unknown) => void
  const selection = new Promise<UpgradeAction>((resolve, reject) => {
    choose = resolve
    fail = reject
  })

  const restore = () => {
    if (restored) {
      return
    }
    restored = true
    input.removeListener('keypress', onKey)
    signal.removeEventListener('abort', onAbort)
    process.removeListener('exit', restore)
    if (process.platform !== 'win32') {
      process.removeListener('SIGTSTP', onSuspend)
      process.removeListener('SIGCONT', onContinue)
    }
    try {
      input.setRawMode(wasRaw)
    } finally {
      if (wasFlowing !== true) {
        input.pause()
      }
    }
  }

  const finish = (action: UpgradeAction, confirmed: boolean = false) => {
    if (restored) {
      return
    }
    try {
      restore()
      if (confirmed) {
        terminal.write(`\n  ✓ ${choices[selectedIndex].label}\n`)
      }
      choose(action)
    } catch (error) {
      fail(error)
    }
  }

  const onAbort = () => finish('skip')
  const render = () => {
    // Append after any output produced while this process was suspended.
    terminal.write(
      `\n${message}\n\n${choices
        .map((choice, index) =>
          index === selectedIndex
            ? `  ❯ ${cyan(bold(choice.label))}`
            : `    ${choice.label}`
        )
        .join('\n')}\n`
    )
  }
  const onSuspend = () => {
    if (restored || suspended) {
      return
    }
    suspended = true
    try {
      // A direct SIGTSTP bypasses keypress handling. Restore cooked input
      // before stopping so the shell does not inherit our raw mode.
      input.setRawMode(wasRaw)
      if (wasFlowing !== true) {
        input.pause()
      }
      process.kill(process.pid, 'SIGSTOP')
    } catch (error) {
      fail(error)
    }
  }
  const onContinue = () => {
    if (restored || !suspended) {
      return
    }
    try {
      input.setRawMode(true)
      input.resume()
      suspended = false
      render()
    } catch (error) {
      fail(error)
    }
  }
  const onKey = (_text: string, key: Key) => {
    if (key?.ctrl && key.name === 'c') {
      finish('interrupt')
    } else if (key?.name === 'escape' || (key?.ctrl && key.name === 'z')) {
      // Leave raw mode so a subsequent Ctrl+Z uses normal shell job control.
      finish('skip')
    } else if (key?.name === 'up' || key?.name === 'down') {
      selectedIndex =
        (selectedIndex + (key.name === 'down' ? 1 : -1) + choices.length) %
        choices.length
      try {
        // Dev/build can write to this terminal too. Append the selection;
        // cursor movement or clearing rows could erase their output.
        terminal.write(`\n  ❯ ${cyan(bold(choices[selectedIndex].label))}\n`)
      } catch (error) {
        fail(error)
      }
    } else if (key?.name === 'return') {
      finish(choices[selectedIndex].action, true)
    }
  }

  // A synchronous CLI exit still needs to restore the terminal's input mode.
  process.once('exit', restore)
  if (process.platform !== 'win32') {
    process.on('SIGTSTP', onSuspend)
    process.on('SIGCONT', onContinue)
  }
  try {
    emitKeypressEvents(input)
    input.on('keypress', onKey)
    signal.addEventListener('abort', onAbort, { once: true })
    input.setRawMode(true)
    input.resume()
    if (signal.aborted) {
      finish('skip')
    } else {
      // Never switch screens or redraw existing lines: logs printed while the
      // prompt is open must remain visible after Skip.
      render()
    }
    return await selection
  } finally {
    restore()
  }
}
