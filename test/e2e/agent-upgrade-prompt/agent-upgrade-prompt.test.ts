import { existsSync, rmSync, writeFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { createRequire } from 'module'
import { join } from 'path'
import resolveFrom from 'resolve-from'
import { isNextDev, nextTestSetup } from 'e2e-utils'
import { findPort, retry } from 'next-test-utils'

describe('agent upgrade prompt', () => {
  const { next } = nextTestSetup({
    files: __dirname,
    skipStart: true,
    skipDeployment: true,
  })

  describe('next dev', () => {
    if (!isNextDev) {
      it.skip('runs only in dev mode', () => {})
      return
    }

    // The test harness supplies a terminal so it can choose menu items.
    // Next itself now runs directly, without another PTY or config preflight.
    async function startDev(
      mode: 'normal' | 'prompt' = 'prompt',
      waitForShutdown: boolean = false
    ) {
      const nextBin = process.env.NEXT_SKIP_ISOLATE
        ? join(process.cwd(), 'packages/next/dist/bin/next')
        : resolveFrom(next.testDir, 'next/dist/bin/next')
      // The PTY is a test harness dependency, not part of installed Next.
      const pty = createRequire(
        join(process.cwd(), 'packages/next/package.json')
      )('node-pty')
      const port = await findPort()
      const env = { ...process.env }

      if (mode === 'normal') {
        delete env.__NEXT_AGENTIC_AUTO_UPGRADE
      } else {
        env.__NEXT_AGENTIC_AUTO_UPGRADE = 'future'
      }

      if (waitForShutdown) {
        // Normally next dev SIGKILLs its worker after 100 ms. Disable that
        // timeout so the fixture's pending after() stays alive long enough to
        // observe upgrade startup, then release it explicitly in the test.
        env.__NEXT_DEV_WAIT_FOR_TURBOPACK_SHUTDOWN = '1'
      }

      // This test simulates a human terminal even when CI runs inside an agent.
      delete env.AI_AGENT
      delete env.CODEX_SANDBOX
      delete env.CODEX_CI
      delete env.CODEX_THREAD_ID
      delete env.CI
      delete env.GITHUB_ACTIONS

      const terminal = pty.spawn(
        process.execPath,
        [nextBin, 'dev', '-p', String(port), '-H', '127.0.0.1'],
        {
          cwd: next.testDir,
          env,
          name: 'xterm-256color',
          cols: 100,
          rows: 30,
        }
      )
      let output = ''
      let exited = false
      let exitCode: number | undefined
      terminal.onData((data: string) => {
        output += data
      })
      terminal.onExit(({ exitCode: code }) => {
        exited = true
        exitCode = code
      })

      return {
        port,
        terminal,
        get output() {
          return output
        },
        get exited() {
          return exited
        },
        get exitCode() {
          return exitCode
        },
        async stop(skipPrompt: boolean = true) {
          if (!exited) {
            try {
              // Wait for the selected choice to be printed after raw mode is
              // restored. Ctrl+C sent with Enter could still go to the menu.
              if (
                mode === 'prompt' &&
                skipPrompt &&
                !output.includes('✓ Skip')
              ) {
                terminal.write('\x1b[B\r')
                await retry(async () => {
                  expect(output).toContain('✓ Skip')
                })
              }
              terminal.write('\x03')
              await retry(async () => {
                expect(exited).toBe(true)
              })
            } finally {
              if (!exited) {
                terminal.kill()
              }
            }
          }
        },
      }
    }

    it('serves requests while the prompt is open', async () => {
      await next.patchFile(
        'next.config.js',
        'module.exports = {}\n',
        async () => {
          const normal = await startDev('normal')
          try {
            // Without a policy, the real dev CLI prints its startup log directly.
            await retry(async () => {
              expect(normal.output).toContain('Ready in')
            }, 10_000)
            expect(normal.output).not.toContain('Upgrade now')
          } finally {
            await normal.stop()
          }
        }
      )

      // Start the same fixture with the prompt enabled to compare terminal output.
      const dev = await startDev()

      try {
        // The requested upgrade ensures an offer even without a newer release.
        // The real dev server must serve while the terminal menu remains open.
        await retry(async () => {
          expect(dev.output).toContain('Upgrade now')
        }, 10_000)

        // A successful request proves dev continues working beneath the menu.
        const response = await retry(
          () => fetch(`http://127.0.0.1:${dev.port}/`),
          10_000
        )
        expect(response.status).toBe(200)
        expect(await response.text()).toContain('hello world')
        // Dev output remains visible beside the append-only menu.
        await retry(async () => {
          expect(dev.output).toContain('UPGRADE_REQUEST_LOG')
        })
        expect(dev.output).not.toContain('\x1b[?1049h')
      } finally {
        await dev.stop()
      }
    })

    it('stops dev and its worker on Ctrl+C', async () => {
      const dev = await startDev()
      let serverPid = 0
      let devPid = 0
      try {
        await retry(async () => {
          expect(dev.output).toContain('Upgrade now')
        }, 10_000)

        const response = await retry(
          () => fetch(`http://127.0.0.1:${dev.port}/`),
          10_000
        )
        const body = await response.text()
        serverPid = Number(body.match(/data-server-pid="(\d+)"/)?.[1])
        devPid = Number(body.match(/data-dev-pid="(\d+)"/)?.[1])
        expect(serverPid).toBeGreaterThan(0)
        expect(devPid).toBeGreaterThan(0)

        // Ctrl+C goes through the prompt's terminal input path.
        dev.terminal.write('\x03')
        await retry(async () => {
          expect(dev.exited).toBe(true)
          expect(() => process.kill(devPid, 0)).toThrow()
          expect(() => process.kill(serverPid, 0)).toThrow()
        }, 10_000)
        expect(dev.exitCode).toBe(130)
      } finally {
        await dev.stop(false)
        // If an assertion fails, do not leave either process running.
        for (const pid of [devPid, serverPid]) {
          if (pid) {
            try {
              process.kill(pid, 'SIGKILL')
            } catch (error) {
              // The process may already have exited; any other failure is real.
              if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
                throw error
              }
            }
          }
        }
      }
    })

    if (process.platform !== 'win32') {
      it('ends the dev session if its worker dies during the prompt', async () => {
        const dev = await startDev()
        let devPid = 0
        try {
          await retry(async () => {
            expect(dev.output).toContain('Upgrade now')
          }, 10_000)

          // Find the dev worker without requesting a page, which would start
          // a separate render worker that a direct SIGKILL could orphan.
          devPid = Number(
            execFileSync('pgrep', ['-P', String(dev.terminal.pid)], {
              encoding: 'utf8',
            })
              .trim()
              .split('\n')[0]
          )
          expect(devPid).toBeGreaterThan(0)

          process.kill(devPid, 'SIGKILL')
          await retry(async () => {
            expect(dev.exited).toBe(true)
          }, 10_000)
          expect(dev.exitCode).toBe(137)
        } finally {
          await dev.stop(false)
          if (devPid) {
            try {
              process.kill(devPid, 'SIGKILL')
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
                throw error
              }
            }
          }
        }
      })

      it('starts Upgrade now when the dev worker cannot process messages', async () => {
        const dev = await startDev()
        let devPid = 0
        try {
          await retry(async () => {
            expect(dev.output).toContain('Upgrade now')
          }, 10_000)

          // Pause the actual dev worker after it opens the menu. The parent
          // still receives input, but the worker cannot echo an Upgrade action.
          devPid = Number(
            execFileSync('pgrep', ['-P', String(dev.terminal.pid)], {
              encoding: 'utf8',
            })
              .trim()
              .split('\n')[0]
          )
          expect(devPid).toBeGreaterThan(0)
          process.kill(devPid, 'SIGSTOP')

          dev.terminal.write('\r')
          // The real upgrade command starts before the paused worker resumes.
          await retry(async () => {
            expect(dev.output).toContain('Preparing upgrade...')
          }, 10_000)
          await retry(async () => {
            expect(() => process.kill(devPid, 0)).toThrow()
          }, 10_000)
        } finally {
          if (devPid) {
            try {
              process.kill(devPid, 'SIGCONT')
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
                throw error
              }
            }
          }
          // Stop upgrade preparation before it can launch an agent.
          await dev.stop(false)
        }
      })

      it('stops the dev worker on SIGHUP while the prompt is open', async () => {
        const dev = await startDev()
        let devPid = 0
        try {
          await retry(async () => {
            expect(dev.output).toContain('Upgrade now')
          }, 10_000)

          // No page request is needed; find the dev worker directly.
          devPid = Number(
            execFileSync('pgrep', ['-P', String(dev.terminal.pid)], {
              encoding: 'utf8',
            })
              .trim()
              .split('\n')[0]
          )
          expect(devPid).toBeGreaterThan(0)

          process.kill(dev.terminal.pid, 'SIGHUP')
          await retry(async () => {
            expect(dev.exited).toBe(true)
            expect(() => process.kill(devPid, 0)).toThrow()
          }, 10_000)
          expect(dev.exitCode).toBe(129)
        } finally {
          await dev.stop(false)
          if (devPid) {
            try {
              process.kill(devPid, 'SIGKILL')
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
                throw error
              }
            }
          }
        }
      })
    }

    it('stops dev and its worker on SIGTERM', async () => {
      const dev = await startDev()
      let serverPid = 0
      let devPid = 0
      try {
        await retry(async () => {
          expect(dev.output).toContain('Upgrade now')
        }, 10_000)

        const response = await retry(
          () => fetch(`http://127.0.0.1:${dev.port}/`),
          10_000
        )
        const body = await response.text()
        serverPid = Number(body.match(/data-server-pid="(\d+)"/)?.[1])
        devPid = Number(body.match(/data-dev-pid="(\d+)"/)?.[1])
        expect(serverPid).toBeGreaterThan(0)
        expect(devPid).toBeGreaterThan(0)

        // Task runners can signal the outer CLI directly, bypassing terminal input.
        process.kill(dev.terminal.pid, 'SIGTERM')
        await retry(async () => {
          expect(dev.exited).toBe(true)
          expect(() => process.kill(devPid, 0)).toThrow()
          expect(() => process.kill(serverPid, 0)).toThrow()
        }, 10_000)
        expect(dev.exitCode).toBe(143)
      } finally {
        await dev.stop(false)
        // If an assertion fails, do not leave either process running.
        for (const pid of [devPid, serverPid]) {
          if (pid) {
            try {
              process.kill(pid, 'SIGKILL')
            } catch (error) {
              // The process may already have exited; any other failure is real.
              if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
                throw error
              }
            }
          }
        }
      }
    })

    it('keeps the human prompt when app env declares an agent', async () => {
      await next.patchFile('.env', 'AI_AGENT=codex\n', async () => {
        const dev = await startDev()
        try {
          // Agent detection must use the CLI environment before app env loads.
          await retry(async () => {
            expect(dev.output).toContain('Upgrade now')
          }, 10_000)
        } finally {
          await dev.stop()
        }
      })
    })

    it('keeps dev running after Skip', async () => {
      const dev = await startDev()
      try {
        await retry(async () => {
          expect(dev.output).toContain('Upgrade now')
        }, 10_000)
        // Generate a server log while the menu owns the terminal.
        const firstResponse = await retry(
          () => fetch(`http://127.0.0.1:${dev.port}/`),
          10_000
        )
        expect(firstResponse.status).toBe(200)
        // There is no capture or replay; the first request already logged.
        await retry(async () => {
          expect(dev.output).toContain('UPGRADE_REQUEST_LOG')
        })

        // Skip leaves the menu and future requests keep reaching the server.
        dev.terminal.write('\x1b[B\r')
        await retry(async () => {
          expect(dev.output).toContain('✓ Skip')
        })
        expect(dev.output.match(/UPGRADE_REQUEST_LOG/g)).toHaveLength(1)
        expect(dev.output).not.toContain('\x1b[?1049h')

        const afterSkip = dev.output.length
        const response = await fetch(`http://127.0.0.1:${dev.port}/`)
        expect(response.status).toBe(200)
        await retry(async () => {
          expect(dev.output.slice(afterSkip)).toContain('UPGRADE_REQUEST_LOG')
        })
        expect(dev.output.match(/UPGRADE_REQUEST_LOG/g)).toHaveLength(2)
      } finally {
        await dev.stop()
      }
    })

    it('starts Upgrade now before shutdown finishes, then stops dev and its worker', async () => {
      // Keep the worker alive until the test releases its pending after().
      const dev = await startDev('prompt', true)
      let releasePath = ''
      let readyPath = ''

      try {
        // Wait until the menu is visible before making the request that will
        // hold the server worker open during shutdown.
        await retry(async () => {
          expect(dev.output).toContain('Upgrade now')
        }, 10_000)

        let serverPid = 0
        let devPid = 0

        // The fixture holds graceful shutdown until we create its release file.
        // Its response exposes the parent and server PIDs for the exit checks.
        const response = await retry(
          () => fetch(`http://127.0.0.1:${dev.port}/?hold=1`),
          10_000
        )
        expect(response.status).toBe(200)

        // The page exposes its own PID and its parent dev PID in HTML attributes.
        // We need both to verify that shutdown eventually stops both processes.
        const body = await response.text()
        serverPid = Number(body.match(/data-server-pid="(\d+)"/)?.[1])
        devPid = Number(body.match(/data-dev-pid="(\d+)"/)?.[1])
        expect(serverPid).toBeGreaterThan(0)
        expect(devPid).toBeGreaterThan(0)

        readyPath = join(next.testDir, `upgrade-ready-${serverPid}`)
        releasePath = join(next.testDir, `upgrade-release-${serverPid}`)

        // The ready file means after() is waiting for the release file.
        await retry(async () => {
          expect(existsSync(readyPath)).toBe(true)
        }, 5_000)

        // Enter selects Upgrade now, which starts the real next upgrade --ai.
        dev.terminal.write('\r')

        // The real upgrade command prints this before looking up its target.
        // Seeing it while the server is alive proves the parent did not wait
        // for graceful shutdown to finish.
        await retry(async () => {
          expect(dev.output).toContain('Preparing upgrade...')
        }, 10_000)

        expect(process.kill(serverPid, 0)).toBe(true)

        // Stop upgrade preparation, release after(), and verify both Next
        // processes eventually exit without launching an agent.
        if (!dev.exited) {
          dev.terminal.write('\x03')
        }
        writeFileSync(releasePath, '')

        await retry(async () => {
          expect(dev.exited).toBe(true)
          expect(() => process.kill(serverPid, 0)).toThrow()
          expect(() => process.kill(devPid, 0)).toThrow()
        }, 15_000)
      } finally {
        // Always unblock shutdown, including when an earlier assertion fails.
        if (releasePath) {
          writeFileSync(releasePath, '')
        }

        // The upgrade menu is gone, so do not send a Skip selection here.
        await dev.stop(false)

        if (readyPath) {
          rmSync(readyPath, { force: true })
          rmSync(releasePath, { force: true })
        }
      }
    })
  })
})
