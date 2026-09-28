import { fork } from 'child_process'
import { constants } from 'os'
import { getProjectDir } from '../get-project-dir'
import {
  formatDebugAddress,
  formatNodeOptions,
  getNodeDebugType,
  getParsedDebugAddress,
  getParsedNodeOptions,
} from '../../server/lib/utils'
import { shouldPromptForUpgrade, runUpgrade, type NudgeKind } from './nudge'

/**
 * Keep a build stoppable while its own config load decides whether to prompt.
 * The child inherits the real terminal; no config preflight or output capture
 * runs in this parent. Dev already has this parent/worker split.
 */
export async function runBuildWithUpgradePrompt(
  directory: string
): Promise<boolean> {
  if (
    process.env.NEXT_PRIVATE_UPGRADE_BUILD_CHILD === '1' ||
    !(await shouldPromptForUpgrade())
  ) {
    return false
  }
  const dir = getProjectDir(directory)
  const nodeOptions = getParsedNodeOptions()
  const debugType = getNodeDebugType(nodeOptions)
  // Keep inspected builds eligible for the menu without making the child
  // compete with its parent for the same debugger port.
  if (debugType) {
    const address = getParsedDebugAddress(nodeOptions[debugType])
    address.port = address.port === 0 ? 0 : address.port + 1
    nodeOptions[debugType] = formatDebugAddress(address)
  }
  const debugOptions = debugType ? formatNodeOptions(nodeOptions) : null
  const child = fork(process.argv[1], process.argv.slice(2), {
    stdio: 'inherit',
    ...(debugOptions ? { execArgv: debugOptions.execArgv } : undefined),
    env: {
      ...process.env,
      ...(debugOptions
        ? { NODE_OPTIONS: debugOptions.nodeOptions }
        : undefined),
      NEXT_PRIVATE_UPGRADE_BUILD_CHILD: '1',
    },
  })
  let upgrade: Promise<number | string> | undefined
  let interrupted = false

  child.on('message', (message: unknown) => {
    if (typeof message !== 'object' || message === null) {
      return
    }
    const action = Reflect.get(message, 'upgradePromptAction')
    if (action === 'interrupt') {
      interrupted = true
      child.kill('SIGINT')
      return
    }
    const policy = Reflect.get(message, 'policy')
    if (
      action === 'update' &&
      !upgrade &&
      (policy === 'security' || policy === 'latest' || policy === 'future')
    ) {
      child.kill('SIGTERM')
      // Do not wait for build shutdown before the upgrade starts.
      stopForwardingSignals()
      upgrade = runUpgrade(dir, policy as NudgeKind)
    }
  })

  const onSignal = (signal: NodeJS.Signals) => {
    interrupted = true
    child.kill(signal)
  }
  const onInterrupt = () => onSignal('SIGINT')
  const onTerminate = () => onSignal('SIGTERM')
  const onHangup = () => onSignal('SIGHUP')
  process.on('SIGINT', onInterrupt)
  process.on('SIGTERM', onTerminate)
  process.on('SIGHUP', onHangup)

  function stopForwardingSignals() {
    process.off('SIGINT', onInterrupt)
    process.off('SIGTERM', onTerminate)
    process.off('SIGHUP', onHangup)
  }

  try {
    const exit = await new Promise<{
      code: number | null
      signal: NodeJS.Signals | null
    }>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => resolve({ code, signal }))
    })
    if (upgrade) {
      process.exitCode = await upgrade
    } else if (interrupted) {
      process.exitCode = exit.signal
        ? 128 + constants.signals[exit.signal]
        : (exit.code ?? 130)
    } else {
      process.exitCode = exit.signal
        ? 128 + constants.signals[exit.signal]
        : (exit.code ?? 1)
    }
  } finally {
    stopForwardingSignals()
  }
  return true
}
