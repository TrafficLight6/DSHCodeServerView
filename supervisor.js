/**
 * code-server process supervision for the DSHCodeServerView Host half.
 *
 * The panel only needs an address that answers HTTP; *who* runs code-server is a
 * separate concern. This module owns that concern and nothing else:
 *
 * - **Attach first.** A probe of the configured address decides everything. A
 *   live instance is adopted rather than duplicated, so a profile that also
 *   starts code-server by hand (or a second plugin instance after a hot reload)
 *   never fights over one data directory or one port.
 * - **Spawn only on request.** `manage` is opt-in. Without it this module reports
 *   `off` and the panel keeps framing whatever is already there.
 * - **Lifetime is a Job Object, not this disposer.** The subprocess service
 *   starts children in a Windows kill-on-close Job and `terminate()` +
 *   `waitForExit()` cover the whole managed range, so a code-server that spawned
 *   its own children still dies cleanly and leaves no orphan. Unloading the
 *   plugin therefore leaves the process alone by default (`stopOnUnload: false`):
 *   a configuration edit hot-replaces the Host half, and killing the IDE on
 *   every save would be hostile. When DSH itself exits, the Job closes and takes
 *   code-server with it.
 *
 * Everything external (clock, fetch, process spawn, file reads) is injected, so
 * the contract test drives the whole state machine without starting anything.
 * @module DSHCodeServerView/supervisor
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Probe timeout while deciding attach vs spawn, in milliseconds. */
const PROBE_TIMEOUT_MS = 2000

/** Backoff between automatic restarts, multiplied by the attempt number. */
const RESTART_BACKOFF_MS = 2000

/** Automatic restarts allowed before the supervisor gives up, per running period. */
const MAX_RESTARTS = 3

/** Where the vendored code-server submodule lives, relative to this module. */
export const VENDORED_ROOT = fileURLToPath(new URL('./vendor/code-server/', import.meta.url))

/**
 * Whether one directory holds a runnable code-server.
 *
 * A release layout runs as `node <root>`, and so does a built source checkout:
 * both resolve `package.json`'s main to the server entry.
 * @param root - the candidate directory.
 * @param exists - the file-existence probe (injected for tests).
 * @returns true when `<root>/out/node/entry.js` exists.
 */
export function isRunnableRoot(root, exists = existsSync) {
  return root.length > 0 && exists(join(root, 'out', 'node', 'entry.js'))
}

/**
 * Describe how to launch code-server from one root directory.
 *
 * The bundled `lib/node` of a release is preferred: the plugin's own runtime is
 * Electron, whose `execPath` is not a Node CLI, so it is only usable as a last
 * resort through `ELECTRON_RUN_AS_NODE`.
 * @param root - a runnable code-server directory.
 * @param options - injected probes and resolvers.
 * @returns the program, its leading arguments, and any environment it requires.
 */
export function launcherFor(root, options = {}) {
  const {
    exists = existsSync,
    platform = process.platform,
    execPath = process.execPath,
    resolveNode,
  } = options
  const bundled = join(root, 'lib', platform === 'win32' ? 'node.exe' : 'node')
  if (exists(bundled)) return { program: bundled, argv: [root], env: {} }
  const system = resolveNode?.()
  if (typeof system === 'string' && system.length > 0) return { program: system, argv: [root], env: {} }
  return { program: execPath, argv: [root], env: { ELECTRON_RUN_AS_NODE: '1' } }
}

/**
 * Read the version a runnable root reports about itself.
 * @param root - the code-server directory.
 * @param read - the file reader (injected for tests).
 * @returns the version string, or undefined when it cannot be read.
 */
export function versionOf(root, read = readFileSync) {
  try {
    const manifest = JSON.parse(read(join(root, 'package.json'), 'utf8'))
    const version = manifest?.version
    return typeof version === 'string' && version !== '0.0.0' ? version : undefined
  } catch {
    return undefined
  }
}

/**
 * Create the supervisor for one plugin instance.
 * @param options - configuration, injected collaborators, and the plugin logger.
 * @returns the supervisor's public face.
 */
export function createSupervisor(options) {
  const {
    config,
    fetchImpl = globalThis.fetch,
    spawnProcess,
    resolveExecutable,
    prepareSpawn,
    log = () => {},
    exists = existsSync,
    read = readFileSync,
    platform = process.platform,
    execPath = process.execPath,
    vendoredRoot = VENDORED_ROOT,
    now = () => Date.now(),
    schedule = (fn, ms) => setTimeout(fn, ms),
    cancelSchedule = (timer) => clearTimeout(timer),
    delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) }),
  } = options

  const base = config.url
  const healthUrl = new URL(String(config.healthPath ?? '/healthz').replace(/^\//u, ''), base)
  const manage = config.manage === true

  /** Supervisor state, published verbatim to the panel. */
  const state = {
    mode: manage ? 'managed' : 'off',
    state: manage ? 'idle' : 'off',
    root: undefined,
    rootSource: undefined,
    version: undefined,
    vendored: undefined,
    pid: undefined,
    exitCode: undefined,
    restarts: 0,
    message: undefined,
    copilot: undefined,
  }

  let handle
  let disposed = false
  let stopping = false
  let restartTimer
  let runningSince

  /**
   * Probe the configured address once.
   * @returns true when code-server answers its health route.
   */
  async function probe() {
    if (typeof fetchImpl !== 'function') return false
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, PROBE_TIMEOUT_MS)
    try {
      const response = await fetchImpl(healthUrl, { signal: controller.signal })
      return response.ok === true
    } catch {
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Choose the code-server root: explicit configuration, then the vendored
   * submodule when it has been built, and nothing else — a machine-specific
   * default would be a lie in every other deployment.
   * @returns the root and where it came from, or undefined.
   */
  function resolveRoot() {
    const configured = typeof config.root === 'string' ? config.root.trim() : ''
    if (configured.length > 0) return { root: configured, source: 'config' }
    if (isRunnableRoot(vendoredRoot, exists)) return { root: vendoredRoot, source: 'submodule' }
    return undefined
  }

  /** Publish the vendored submodule's identity once, without spawning anything. */
  function noteVendored() {
    if (state.vendored !== undefined) return
    const manifest = join(vendoredRoot, 'package.json')
    state.vendored = exists(manifest) ? 'source checkout, not built' : 'absent'
  }

  /** Arguments handed to code-server when the configuration names none. */
  function launcherArgs(dataDir) {
    const configured = Array.isArray(config.args) ? config.args.filter((value) => typeof value === 'string') : []
    const args = [...configured]
    if (args.length === 0) {
      const parsed = new URL(base)
      args.push('--bind-addr', `${parsed.hostname}:${parsed.port.length > 0 ? parsed.port : '8080'}`)
    }
    if (typeof dataDir === 'string' && dataDir.length > 0) args.push('--user-data-dir', dataDir)
    return args
  }

  /**
   * Start code-server and wait until it answers.
   * @returns nothing; the published state reports the outcome.
   */
  async function start() {
    const resolved = resolveRoot()
    if (resolved === undefined) {
      state.state = 'error'
      state.message = 'no runnable code-server found: set config.root, or build the vendored submodule'
      log(`[code-server-view] ${state.message}`)
      return
    }
    state.root = resolved.root
    state.rootSource = resolved.source
    if (!isRunnableRoot(resolved.root, exists)) {
      state.state = 'error'
      state.message = `${resolved.root} does not look like a code-server root (no out/node/entry.js)`
      log(`[code-server-view] ${state.message}`)
      return
    }
    state.version = versionOf(resolved.root, read)
    noteVendored()

    // `resolveExecutable` is asynchronous on the real service; the bundled
    // runtime of a release makes this unnecessary, and the Electron fallback
    // needs `ELECTRON_RUN_AS_NODE`, so the chain is tried in that order.
    let systemNode
    if (typeof resolveExecutable === 'function') {
      try {
        const resolvedNode = await resolveExecutable('node')
        if (typeof resolvedNode === 'string' && resolvedNode.length > 0) systemNode = resolvedNode
      } catch {
        systemNode = undefined
      }
    }
    const launcher = launcherFor(resolved.root, {
      exists,
      platform,
      execPath,
      resolveNode: () => systemNode,
    })
    const password = typeof config.password === 'string' ? config.password : ''
    const env = { ...launcher.env }
    // Passed through the environment, never argv: a process list is public.
    if (password.length > 0) env.PASSWORD = password

    // Preparation runs before the spawn: it may pin the data directory and add
    // arguments (the Copilot guard contributes --builtin-extensions-dir).
    let dataDir = typeof config.dataDir === 'string' ? config.dataDir.trim() : ''
    let preparedArgs = []
    state.copilot = undefined
    if (typeof prepareSpawn === 'function') {
      try {
        const prepared = await prepareSpawn({ root: resolved.root, dataDir, version: state.version })
        if (typeof prepared?.dataDir === 'string' && prepared.dataDir.length > 0) dataDir = prepared.dataDir
        if (Array.isArray(prepared?.args)) preparedArgs = prepared.args
        state.copilot = prepared?.status
      } catch (error) {
        state.copilot = { applied: false, reason: `failed: ${String(error?.message ?? error)}` }
        log(`[code-server-view] spawn preparation failed: ${String(error?.message ?? error)}`)
      }
    }

    state.state = 'starting'
    state.message = undefined
    state.exitCode = undefined
    log(`[code-server-view] starting code-server from ${resolved.root} (${resolved.source})`)

    try {
      handle = spawnProcess({
        argv: [launcher.program, ...launcher.argv, ...launcherArgs(dataDir), ...preparedArgs],
        cwd: typeof config.cwd === 'string' && config.cwd.trim().length > 0 ? config.cwd : resolved.root,
        env,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 32 * 1024 }, stderr: { maxBytes: 32 * 1024 } },
        graceMs: Number(config.graceMs ?? 8000),
      })
    } catch (error) {
      state.state = 'error'
      state.message = `spawn failed: ${String(error?.message ?? error)}`
      log(`[code-server-view] ${state.message}`)
      return
    }

    state.pid = handle.pid
    void handle.done.then((outcome) => { onExit(outcome) }, (error) => {
      state.state = 'error'
      state.message = `code-server failed to run: ${String(error?.message ?? error)}`
      log(`[code-server-view] ${state.message}`)
    })

    const deadline = now() + Number(config.startTimeoutMs ?? 30000)
    for (;;) {
      if (disposed || stopping) return
      if (state.state === 'exited' || state.state === 'error') return
      if (await probe()) break
      if (now() > deadline) {
        state.state = 'error'
        state.message = `code-server did not answer ${healthUrl.href} within ${String(config.startTimeoutMs ?? 30000)}ms`
        const tail = outputTail(handle)
        if (tail.length > 0) state.message += `; last output: ${tail}`
        log(`[code-server-view] ${state.message}`)
        return
      }
      await delay(300)
    }

    state.state = 'running'
    state.restarts = 0
    runningSince = now()
    log(`[code-server-view] code-server is running at ${base} (pid ${String(state.pid ?? '?')})`)
  }

  /**
   * Read the child's collected output tail for diagnostics.
   * @param processHandle - the spawned handle.
   * @returns a single-line excerpt, or an empty string.
   */
  function outputTail(processHandle) {
    try {
      const text = processHandle.collected?.stderr?.readFrom(0)?.text ?? ''
      return text.split('\n').filter((line) => line.trim().length > 0).slice(-3).join(' | ').slice(0, 400)
    } catch {
      return ''
    }
  }

  /**
   * React to the child leaving.
   * @param outcome - exit facts from the subprocess service.
   * @returns nothing.
   */
  function onExit(outcome) {
    const wasStopping = stopping || disposed
    handle = undefined
    state.pid = undefined
    state.exitCode = outcome?.exitCode
    if (wasStopping) {
      if (state.state !== 'off') state.state = 'stopped'
      return
    }
    state.state = 'exited'
    state.message = `code-server exited with code ${String(outcome?.exitCode ?? '?')}`
    log(`[code-server-view] ${state.message}`)
    if (config.restart === 'never' || state.restarts >= MAX_RESTARTS) return
    state.restarts += 1
    const waitMs = RESTART_BACKOFF_MS * state.restarts
    log(`[code-server-view] restarting code-server in ${waitMs}ms (attempt ${state.restarts}/${MAX_RESTARTS})`)
    restartTimer = schedule(() => {
      restartTimer = undefined
      if (disposed || stopping) return
      void start()
    }, waitMs)
  }

  /**
   * Terminate the managed range and wait until it is provably gone.
   * @returns nothing.
   */
  async function stop() {
    if (restartTimer !== undefined) {
      cancelSchedule(restartTimer)
      restartTimer = undefined
    }
    const current = handle
    if (current === undefined) return
    stopping = true
    try {
      current.terminate()
      await current.waitForExit()
      log('[code-server-view] code-server stopped')
    } catch (error) {
      log(`[code-server-view] stopping code-server failed: ${String(error?.message ?? error)}`)
    } finally {
      stopping = false
    }
  }

  return {
    /**
     * Start (or adopt) code-server, once.
     * @returns nothing; the published state reports the outcome.
     */
    async ensureRunning() {
      if (!manage) return
      noteVendored()
      if (handle !== undefined || state.state === 'starting') return
      if (await probe()) {
        state.mode = 'attach'
        state.state = 'attached'
        state.message = undefined
        log(`[code-server-view] adopting the code-server already answering at ${base}`)
        return
      }
      state.mode = 'managed'
      await start()
    },

    /**
     * Stop and start again, whatever the current state.
     * @returns nothing.
     */
    async restart() {
      if (!manage) return
      await stop()
      state.restarts = 0
      if (await probe()) {
        state.mode = 'attach'
        state.state = 'attached'
        return
      }
      state.mode = 'managed'
      await start()
    },

    /**
     * Stop the managed process, if this instance owns one.
     * @returns nothing.
     */
    async stopOwned() {
      await stop()
    },

    /** Release the supervisor; the process survives unless `stopOnUnload`. */
    async dispose() {
      disposed = true
      if (restartTimer !== undefined) {
        cancelSchedule(restartTimer)
        restartTimer = undefined
      }
      if (config.stopOnUnload === true) await stop()
    },

    /**
     * Snapshot for the panel and the routes.
     * @returns a structured-clone-safe status object.
     */
    status() {
      noteVendored()
      return {
        mode: state.mode,
        state: state.state,
        url: base,
        root: state.root,
        rootSource: state.rootSource,
        version: state.version,
        vendored: state.vendored,
        pid: state.pid,
        exitCode: state.exitCode,
        restarts: state.restarts,
        message: state.message,
        copilot: state.copilot,
        uptimeMs: runningSince === undefined || state.state !== 'running' ? undefined : now() - runningSince,
      }
    },
  }
}
