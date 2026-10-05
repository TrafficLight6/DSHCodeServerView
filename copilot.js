/**
 * Copilot removal for a managed code-server instance.
 *
 * code-server ships GitHub Copilot Chat as a **built-in** extension, so there is
 * nothing to uninstall and `--disable-extension` is not an option (code-server's
 * CLI rejects options it does not own). This module therefore uses three levers
 * that need no fork and never modify the code-server installation:
 *
 * 1. **A filtered built-in extensions directory.** code-server has a first-class
 *    `--builtin-extensions-dir` flag. The guard links every built-in extension
 *    except the excluded ones into its own directory and hands that to
 *    code-server, so Copilot is never loaded at all. Extensions are matched by
 *    their manifest identity (`publisher.name`), not by directory name, so an
 *    upstream rename still matches; a directory whose manifest cannot be read is
 *    always kept.
 * 2. **Settings.** `<data>/User/settings.json` receives the AI-off block
 *    (`chat.disableAIFeatures` and friends). The file is JSONC, so the merge
 *    tolerates comments; an unparsable file is reported and left untouched.
 * 3. **Cache hygiene.** Copilot's `globalStorage` leftovers and the code-server
 *    extension caches are removed, which also stops a stale built-in list from
 *    surviving lever 1.
 *
 * Everything written lives outside the code-server installation: the filtered
 * directory is derived data under `workDir`, and the rest is code-server's own
 * user data directory. An upgrade replaces the installation, which changes the
 * derived fingerprint and makes the guard rebuild itself on the next spawn.
 * @module DSHCodeServerView/copilot
 */
import { createHash } from 'node:crypto'
import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { homedir, platform as osPlatform } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'

/** Extensions excluded by default, matched case-insensitively against the id. */
export const DEFAULT_EXCLUDES = ['GitHub.copilot-chat', 'GitHub.copilot']

/** The settings block that turns code-server's AI surfaces off. */
export const AI_OFF_SETTINGS = {
  'chat.disableAIFeatures': true,
  'chat.commandCenter.enabled': false,
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
  'github.copilot.enable': { '*': false },
  'telemetry.telemetryLevel': 'off',
}

/** Cache files that must not keep an old built-in list alive, relative to the data directory. */
const STALE_CACHES = [
  join('User', 'customBuiltinExtensionsCache.json'),
  join('User', 'systemExtensionsCache.json'),
]

/**
 * code-server's own default user data directory, following the `env-paths`
 * rules its launcher uses (`%LOCALAPPDATA%\code-server\Data` on Windows,
 * `$XDG_DATA_HOME|~/.local/share/code-server` elsewhere, Application Support on
 * macOS). Pinning it with `--user-data-dir` is what lets the guard know where
 * settings and caches live.
 * @param options - injected platform facts.
 * @returns the absolute data directory code-server would use by default.
 */
export function defaultDataDir(options = {}) {
  const { platform = osPlatform(), env = process.env, home = homedir() } = options
  if (platform === 'win32') return join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'code-server', 'Data')
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'code-server')
  return join(env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'code-server')
}

/**
 * A user-scoped cache directory for this plugin's derived data, outside both the
 * plugin checkout and the code-server installation.
 * @param options - injected platform facts and the DSH home, when known.
 * @returns the absolute work directory to use by default.
 */
export function defaultWorkDir(options = {}) {
  const { platform = osPlatform(), env = process.env, home = homedir() } = options
  if (typeof env.DSH_HOME === 'string' && env.DSH_HOME.length > 0) return join(env.DSH_HOME, 'cache', 'code-server-view')
  if (platform === 'win32') return join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'code-server-view')
  if (platform === 'darwin') return join(home, 'Library', 'Caches', 'code-server-view')
  return join(env.XDG_CACHE_HOME ?? join(home, '.cache'), 'code-server-view')
}

/**
 * Whether one path is the other or lives inside it.
 * @param candidate - the path to test.
 * @param parent - the containing directory.
 * @returns true when candidate is inside parent.
 */
export function isInside(candidate, parent) {
  const from = resolve(candidate)
  const to = resolve(parent)
  return from === to || from.startsWith(to.endsWith(sep) ? to : `${to}${sep}`)
}

/**
 * Strip JSONC comments so a settings file written by a human still parses.
 * String literals are respected, so `"a//b"` survives.
 * @param text - the raw file contents.
 * @returns text that `JSON.parse` accepts when the file is otherwise valid.
 */
export function stripJsonComments(text) {
  let out = ''
  let inString = false
  let inLine = false
  let inBlock = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    const next = text[index + 1]
    if (inLine) {
      if (char === '\n') { inLine = false; out += char }
      continue
    }
    if (inBlock) {
      if (char === '*' && next === '/') { inBlock = false; index += 1 }
      continue
    }
    if (inString) {
      out += char
      if (char === '\\') { out += next ?? ''; index += 1; continue }
      if (char === '"') inString = false
      continue
    }
    if (char === '"') { inString = true; out += char; continue }
    if (char === '/' && next === '/') { inLine = true; index += 1; continue }
    if (char === '/' && next === '*') { inBlock = true; index += 1; continue }
    out += char
  }
  return out
}

/**
 * Read one extension directory's identity.
 * @param directory - the extension directory.
 * @param read - the file reader.
 * @returns `{ id, version }`, or undefined when the manifest cannot be read.
 */
function identityOf(directory, read) {
  try {
    const manifest = JSON.parse(read(join(directory, 'package.json'), 'utf8'))
    const publisher = typeof manifest.publisher === 'string' ? manifest.publisher : ''
    const name = typeof manifest.name === 'string' ? manifest.name : ''
    if (publisher.length === 0 || name.length === 0) return undefined
    return {
      id: `${publisher}.${name}`,
      version: typeof manifest.version === 'string' ? manifest.version : '',
    }
  } catch {
    return undefined
  }
}

/**
 * Create the guard for one plugin instance.
 * @param options - configuration, paths, and injected collaborators.
 * @returns the guard's public face.
 */
export function createCopilotGuard(options) {
  const {
    config,
    root,
    pluginDir,
    log = () => {},
    exists = existsSync,
    read = readFileSync,
    readdir = readdirSync,
    stat = statSync,
    write = writeFileSync,
    mkdir = mkdirSync,
    remove = rmSync,
    rename = renameSync,
    link = symlinkSync,
    platform = osPlatform(),
    env = process.env,
    home = homedir(),
  } = options

  const enabled = config.disable === true
  const exclusions = (Array.isArray(config.exclude) ? config.exclude : DEFAULT_EXCLUDES)
    .filter((value) => typeof value === 'string')
    .map((value) => value.toLowerCase())
  const excludedPublishers = (Array.isArray(config.excludePublishers) ? config.excludePublishers : [])
    .filter((value) => typeof value === 'string')
    .map((value) => value.toLowerCase())
  const useBuiltin = config.builtinExtensions !== false
  const useSettings = config.settings !== false
  const settingsPolicy = config.settingsPolicy === 'fill' ? 'fill' : 'enforce'
  const purgeCaches = config.purgeCaches !== false
  const purgeChatModels = config.purgeChatModels === true

  const workDir = typeof config.workDir === 'string' && config.workDir.trim().length > 0
    ? resolve(config.workDir.trim())
    : defaultWorkDir({ platform, env, home })

  /** Result of the last {@link apply} call, published to the panel. */
  const state = {
    disable: enabled,
    applied: false,
    reason: enabled ? undefined : 'disabled',
    workDir,
    settingsPath: undefined,
    settingsWritten: undefined,
    builtinDir: undefined,
    builtinSource: undefined,
    excluded: [],
    included: 0,
    purged: [],
    message: undefined,
  }

  /**
   * Verify the work directory cannot pollute the plugin checkout or the
   * installation, then make sure it exists.
   * @returns an error message, or undefined when the directory is usable.
   */
  function prepareWorkDir() {
    if (pluginDir !== undefined && isInside(workDir, pluginDir)) {
      return `workDir ${workDir} is inside the plugin package; derived files must live outside it`
    }
    if (root !== undefined && isInside(workDir, root)) {
      return `workDir ${workDir} is inside the code-server installation; derived files must live outside it`
    }
    try {
      mkdir(workDir, { recursive: true })
      return undefined
    } catch (error) {
      return `workDir ${workDir} is not usable: ${String(error?.message ?? error)}`
    }
  }

  /**
   * Enumerate the built-in extensions a filtered directory would carry.
   * @param source - the installation's `lib/vscode/extensions` directory.
   * @returns the included and excluded entries.
   */
  function classify(source) {
    const included = []
    const excluded = []
    for (const entry of readdir(source, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      const directory = join(source, entry.name)
      const identity = identityOf(directory, read)
      const id = (identity?.id ?? '').toLowerCase()
      const publisher = id.includes('.') ? id.slice(0, id.indexOf('.')) : ''
      const drop = identity === undefined
        ? false
        : exclusions.includes(id) || excludedPublishers.includes(publisher)
      const record = { dir: entry.name, id: identity?.id ?? entry.name, version: identity?.version ?? '' }
      if (drop) excluded.push(record)
      else included.push(record)
    }
    return { included, excluded }
  }

  /**
   * Build (or reuse) the filtered built-in extensions directory.
   * @param source - the installation's extensions directory.
   * @returns the fingerprint, the filtered directory, and the classification.
   */
  function ensureFilteredDir(source) {
    const { included, excluded } = classify(source)
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ source, entries: included.map((entry) => `${entry.dir}:${entry.id}@${entry.version}`), exclusions, excludedPublishers }))
      .digest('hex')
      .slice(0, 16)
    const parent = join(workDir, 'builtin-extensions')
    const target = join(parent, fingerprint)
    if (!exists(target)) {
      const staging = `${target}.staging`
      remove(staging, { recursive: true, force: true })
      mkdir(staging, { recursive: true })
      for (const entry of included) {
        link(join(source, entry.dir), join(staging, entry.dir), 'junction')
      }
      write(join(staging, 'manifest.json'), JSON.stringify({
        source, fingerprint, included: included.map((entry) => entry.id), excluded: excluded.map((entry) => entry.id),
      }, null, 2))
      rename(staging, target)
      // Derived data: keep only the fingerprint in use.
      for (const entry of readdir(parent, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name !== fingerprint && !entry.name.endsWith('.staging')) {
          remove(join(parent, entry.name), { recursive: true, force: true })
        }
      }
      log(`[code-server-view] built-in extensions filtered: ${included.length} kept, ${excluded.length} removed (${excluded.map((entry) => entry.id).join(', ') || 'none'})`)
    }
    return { fingerprint, target, included, excluded }
  }

  /**
   * Merge the AI-off block into `<data>/User/settings.json`.
   * @param dataDir - the effective code-server user data directory.
   * @returns what happened, for the status payload.
   */
  function mergeSettings(dataDir) {
    const file = join(dataDir, 'User', 'settings.json')
    const record = { path: file, written: false, reason: 'absent' }
    let existing = {}
    let text
    if (exists(file)) {
      try {
        text = read(file, 'utf8')
        existing = JSON.parse(stripJsonComments(text))
        if (existing === null || typeof existing !== 'object' || Array.isArray(existing)) {
          return { ...record, reason: 'not-an-object' }
        }
      } catch {
        return { ...record, reason: 'unparsable' }
      }
    }
    const merged = { ...existing }
    let changed = false
    for (const [key, value] of Object.entries(AI_OFF_SETTINGS)) {
      const present = Object.prototype.hasOwnProperty.call(merged, key)
      if (settingsPolicy === 'fill' && present) continue
      if (present && JSON.stringify(merged[key]) === JSON.stringify(value)) continue
      merged[key] = value
      changed = true
    }
    if (!changed) return { ...record, written: false, reason: 'already' }
    try {
      mkdir(join(dataDir, 'User'), { recursive: true })
      const backup = `${file}.dsh-backup`
      if (text !== undefined && !exists(backup)) write(backup, text)
      const staging = `${file}.dsh-staging`
      write(staging, `${JSON.stringify(merged, null, 2)}\n`)
      rename(staging, file)
      return { ...record, written: true, reason: 'merged' }
    } catch (error) {
      return { ...record, written: false, reason: `failed: ${String(error?.message ?? error)}` }
    }
  }

  /**
   * Remove Copilot's caches and the code-server extension caches.
   * @param dataDir - the effective code-server user data directory.
   * @returns the removed paths, relative to the data directory.
   */
  function purge(dataDir) {
    const removed = []
    const attempt = (target, label) => {
      if (!exists(target)) return
      try {
        remove(target, { recursive: true, force: true })
        removed.push(label)
      } catch (error) {
        log(`[code-server-view] could not remove ${label}: ${String(error?.message ?? error)}`)
      }
    }
    const globalStorage = join(dataDir, 'User', 'globalStorage')
    if (exists(globalStorage)) {
      for (const entry of readdir(globalStorage, { withFileTypes: true })) {
        if (/^github\.copilot(-chat)?$/iu.test(entry.name)) attempt(join(globalStorage, entry.name), `User/globalStorage/${entry.name}`)
      }
    }
    const profiles = join(dataDir, 'CachedProfilesData')
    if (exists(profiles)) {
      for (const entry of readdir(profiles, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        attempt(join(profiles, entry.name, 'extensions.builtin.cache'), `CachedProfilesData/${entry.name}/extensions.builtin.cache`)
      }
    }
    for (const relative of STALE_CACHES) attempt(join(dataDir, relative), relative.replaceAll('\\', '/'))
    if (purgeChatModels) attempt(join(dataDir, 'User', 'chatLanguageModels.json'), 'User/chatLanguageModels.json')
    return removed
  }

  return {
    /**
     * Apply the enabled levers for one spawn.
     * @param request - the resolved root and the effective data directory.
     * @returns the extra `--builtin-extensions-dir` argument (when any) and the data directory to pin.
     */
    async apply(request) {
      state.applied = false
      state.message = undefined
      if (!enabled) return { args: [], dataDir: request.dataDir, status: { ...state } }

      const problem = prepareWorkDir()
      if (problem !== undefined) {
        state.reason = 'unsafe-work-dir'
        state.message = problem
        log(`[code-server-view] copilot guard refused: ${problem}`)
        return { args: [], dataDir: request.dataDir, status: { ...state } }
      }

      const args = []
      const source = join(request.root, 'lib', 'vscode', 'extensions')
      state.builtinSource = source
      if (useBuiltin && exists(source)) {
        const filtered = ensureFilteredDir(source)
        state.builtinDir = filtered.target
        state.excluded = filtered.excluded.map((entry) => entry.id)
        state.included = filtered.included.length
        args.push('--builtin-extensions-dir', filtered.target)
      } else if (useBuiltin) {
        state.message = `no built-in extensions directory at ${source}`
      }

      // Settings and caches need a data directory the guard can name; when the
      // profile does not pin one, the caller pins code-server's own default so
      // both sides agree where the state lives.
      const dataDir = typeof request.dataDir === 'string' && request.dataDir.length > 0
        ? request.dataDir
        : defaultDataDir({ platform, env, home })
      if (useSettings || purgeCaches) {
        try {
          mkdir(dataDir, { recursive: true })
        } catch (error) {
          state.message = `data directory ${dataDir} is not usable: ${String(error?.message ?? error)}`
          return { args, dataDir, status: { ...state } }
        }
      }
      if (useSettings) {
        const outcome = mergeSettings(dataDir)
        state.settingsPath = outcome.path
        state.settingsWritten = outcome.written
        state.reason = outcome.reason
        if (outcome.reason === 'unparsable' || outcome.reason === 'not-an-object') {
          state.message = `${outcome.path} is not parsable JSON/JSONC; left untouched`
          log(`[code-server-view] ${state.message}`)
        }
      }
      if (purgeCaches) state.purged = purge(dataDir)

      state.applied = args.length > 0 || state.settingsWritten === true || state.purged.length > 0
      state.dataDir = dataDir
      return { args, dataDir, status: { ...state } }
    },

    /**
     * Snapshot for the status payload.
     * @returns a structured-clone-safe status object.
     */
    status() {
      return { ...state }
    },
  }
}
