/**
 * Host half of the DSHCodeServerView bundle.
 *
 * The panel itself lives in the browser half (`./client`, declared through
 * `dsh.client` in package.json); this half owns everything that must not reach
 * the page:
 *
 * - the plugin's `Config` (the code-server address, the password, whether to log
 *   in automatically, and whether to run code-server at all), so a profile's
 *   `cordis.patch.yml` can retarget the panel without a code edit;
 * - code-server's process, through {@link createSupervisor}: attach to whatever
 *   already answers, otherwise spawn from the configured root (or the vendored
 *   `vendor/code-server` submodule once it is built) and keep it running;
 * - two loopback-only routes: `/codeserver-view/config` publishes the panel's
 *   configuration plus the supervisor's status, and `/codeserver-view/login`
 *   serves an auto-submitting form that logs the browser into code-server, so
 *   the password never reaches the browser half. `/codeserver-view/restart`
 *   asks the supervisor to restart the process.
 *
 * code-server authenticates with `POST /login` (`password` form field); a
 * successful exchange sets the session cookie and redirects to the app root, and
 * a failed one re-renders its login page. Both outcomes are useful, so the login
 * route simply forwards the browser there.
 *
 * @module DSHCodeServerView
 */
import Schema from '@deepseek-ai/schemastery'
import { fileURLToPath } from 'node:url'
import { createCopilotGuard } from './copilot.js'
import { createSupervisor, VENDORED_ROOT } from './supervisor.js'

/** Loader-row identity of this bundle's Host half. */
export const name = 'DSHCodeServerView'

/** This package's own directory, used to keep derived files outside it. */
export const PLUGIN_DIR = fileURLToPath(new URL('.', import.meta.url))

/** code-server instance framed by a tab that carries no explicit URL. */
export const DEFAULT_URL = 'http://127.0.0.1:8080/'

/**
 * Plugin configuration, validated and defaulted by Cordis while the row loads.
 * @see docs/user/develop/basic/config.md in the Harness checkout
 */
export const Config = Schema.object({
  /** Base address of the code-server instance, with or without a path prefix. */
  url: Schema.string().default(DEFAULT_URL),
  /** code-server password; empty leaves code-server's own login page in place. */
  password: Schema.string().default(''),
  /** Log in automatically whenever a password is configured. */
  autoLogin: Schema.boolean().default(true),

  /** Let this plugin own code-server's process (attach first, then spawn). */
  manage: Schema.boolean().default(false),
  /** code-server root directory; defaults to the vendored submodule when built. */
  root: Schema.string().default(''),
  /** Extra code-server arguments; empty derives `--bind-addr` from `url`. */
  args: Schema.array(Schema.string()).default([]),
  /** Working directory for the spawn; empty uses the resolved root. */
  cwd: Schema.string().default(''),
  /** `--user-data-dir` for the spawned instance; empty uses code-server's default. */
  dataDir: Schema.string().default(''),
  /** Health route probed to decide attach vs spawn, and to detect readiness. */
  healthPath: Schema.string().default('/healthz'),
  /** How long to wait for a spawned code-server to answer, in milliseconds. */
  startTimeoutMs: Schema.number().default(30000),
  /** Termination grace handed to the subprocess service, in milliseconds. */
  graceMs: Schema.number().default(8000),
  /** Restart policy after an unexpected exit. */
  restart: Schema.union(['never', 'on-failure']).default('on-failure'),
  /** Stop the process when the plugin unloads; false leaves it to the DSH lifetime. */
  stopOnUnload: Schema.boolean().default(false),

  /** Derived files (the filtered built-in extensions) live here; empty picks a user cache directory. */
  workDir: Schema.string().default(''),
  /** Keep code-server's built-in Copilot out of the spawned instance. */
  copilot: Schema.object({
    /** Master switch; false leaves code-server exactly as shipped. */
    disable: Schema.boolean().default(false),
    /** Lever 1: run code-server against a built-in extensions directory without Copilot. */
    builtinExtensions: Schema.boolean().default(true),
    /** Extensions to leave out, matched by `publisher.name` (case-insensitive). */
    exclude: Schema.array(Schema.string()).default(['GitHub.copilot-chat', 'GitHub.copilot']),
    /** Publishers to leave out entirely; empty keeps GitHub's non-Copilot extensions. */
    excludePublishers: Schema.array(Schema.string()).default([]),
    /** Lever 2: merge the AI-off settings block into the user settings. */
    settings: Schema.boolean().default(true),
    /** `enforce` also overrides a conflicting value; `fill` only adds missing keys. */
    settingsPolicy: Schema.union(['enforce', 'fill']).default('enforce'),
    /** Lever 3: remove Copilot leftovers and the extension caches. */
    purgeCaches: Schema.boolean().default(true),
    /** Also remove the BYOK chat-model registry (`chatLanguageModels.json`). */
    purgeChatModels: Schema.boolean().default(false),
  }),
})

/** Path prefix this plugin owns on the Web carrier. */
const ROUTE_PREFIX = '/codeserver-view'

/**
 * Parse the configured address, adding a scheme and a trailing slash so every
 * route can be resolved relative to it.
 * @param input - the configured `url` value.
 * @returns the parsed base URL, or undefined when it is not a usable HTTP(S) address.
 */
function baseUrlOf(input) {
  const raw = typeof input === 'string' ? input.trim() : ''
  if (raw.length === 0) return undefined
  const withScheme = /^[a-z][a-z\d+.-]*:\/\//iu.test(raw) ? raw : `http://${raw}`
  let parsed
  try {
    parsed = new URL(withScheme)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
  if (!parsed.pathname.endsWith('/')) parsed.pathname = `${parsed.pathname}/`
  return parsed
}

/**
 * Whether the request arrived over the loopback interface.
 *
 * The login page carries the configured password and the restart route acts on
 * the host machine, so both answer loopback clients only: a deployment that
 * binds the Web carrier to a public interface must not hand either to the
 * network. A loopback reverse proxy still passes.
 * @param req - the incoming request.
 * @returns true for a loopback peer.
 */
function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * Answer one JSON payload without caching.
 * @param res - the response to own.
 * @param status - HTTP status code.
 * @param value - JSON-serializable body.
 */
function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

/**
 * Escape one string for use inside a double-quoted HTML attribute.
 * @param value - raw text.
 * @returns attribute-safe text.
 */
function escapeAttribute(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

/**
 * Build the page that logs the browser into code-server.
 *
 * It posts the password to code-server's own `/login`, which answers with the
 * session cookie and a redirect to the app; on a wrong password code-server
 * re-renders its login page, so the panel always ends up somewhere meaningful.
 * @param base - normalized code-server base URL.
 * @param password - the configured password.
 * @returns a complete HTML document.
 */
function loginDocument(base, password) {
  const action = new URL('login', base)
  action.searchParams.set('to', `${base.pathname}${base.search}`)
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <title>VS Code</title>
    <style>
      body { margin: 0; display: flex; align-items: center; justify-content: center;
        min-height: 100vh; font: 13px/1.5 system-ui, sans-serif;
        color: #d5d7dd; background: #17181c; }
      form { display: flex; flex-direction: column; gap: 12px; align-items: center; }
      button { padding: 6px 14px; font: inherit; color: inherit; cursor: pointer;
        background: #2a2c33; border: 1px solid #3a3d46; border-radius: 6px; }
    </style>
  </head>
  <body>
    <form method="post" action="${escapeAttribute(action.href)}">
      <input type="hidden" name="password" value="${escapeAttribute(password)}" />
      <p>Signing in to code-server…</p>
      <button type="submit">Continue</button>
    </form>
    <script>document.forms[0].submit()</script>
  </body>
</html>
`
}

/**
 * Announce the Host half, supervise code-server, and publish the routes when a
 * Web carrier exists.
 * @param ctx - the plugin's Cordis context.
 * @param config - the validated plugin configuration.
 * @returns nothing.
 */
export function apply(ctx, config) {
  const configured = baseUrlOf(config?.url)
  const base = configured ?? new URL(DEFAULT_URL)
  if (configured === undefined) {
    console.log(`[code-server-view] config.url "${String(config?.url)}" is not an HTTP(S) address; using ${base.href}`)
  }
  const password = typeof config?.password === 'string' ? config.password : ''
  const autoLogin = config?.autoLogin !== false
  const manage = config?.manage === true

  /**
   * Read one optional Cordis service.
   *
   * `ctx.<service>` throws unless the plugin declares it in `inject`, and
   * declaring `subprocess` there would keep the whole plugin (panel included)
   * inactive in profiles without a provider. `ctx.get` is the optional read.
   * @param name - the service name.
   * @returns the service, or undefined when it is not mounted.
   */
  const serviceOf = (name) => {
    try {
      return ctx.get?.(name)
    } catch {
      return undefined
    }
  }

  const supervisor = createSupervisor({
    config: { ...config, url: base.href },
    fetchImpl: globalThis.fetch,
    spawnProcess: (request) => {
      const service = serviceOf('subprocess')
      if (service === undefined) throw new Error('no subprocess provider is mounted in this profile')
      return service.spawn(request)
    },
    resolveExecutable: (executable) => {
      const service = serviceOf('subprocess')
      return service === undefined ? undefined : service.resolveExecutable(executable)
    },
    // The Copilot guard runs inside the spawn path: it may pin the data
    // directory and contribute `--builtin-extensions-dir`.
    prepareSpawn: ({ root, dataDir }) => createCopilotGuard({
      config: {
        ...(config?.copilot ?? {}),
        workDir: typeof config?.workDir === 'string' ? config.workDir : '',
      },
      root,
      pluginDir: PLUGIN_DIR,
      log: (line) => { console.log(line) },
    }).apply({ root, dataDir }),
    log: (line) => { console.log(line) },
  })

  console.log(`[code-server-view] host half mounted; code-server ${base.href}${password.length > 0 && autoLogin ? ' (auto-login configured)' : ''}${password.length > 0 && !autoLogin ? ' (password configured, auto-login off)' : ''}${manage ? ` (managing the process; vendored submodule at ${VENDORED_ROOT})` : ''}${config?.copilot?.disable === true ? ' (Copilot disabled for the spawned instance)' : ''}`)

  ctx.effect(() => {
    void supervisor.ensureRunning()
    return () => supervisor.dispose()
  }, 'DSHCodeServerView: supervisor')

  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/config`,
      handler: (req, res) => {
        if (!isLoopback(req)) return sendJson(res, 404, { error: 'not-found' })
        return sendJson(res, 200, {
          url: base.href,
          autoLogin,
          hasPassword: password.length > 0,
          supervisor: supervisor.status(),
        })
      },
    }), 'DSHCodeServerView: config route')

    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/login`,
      handler: (req, res) => {
        if (!isLoopback(req)) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          return res.end('not found')
        }
        const document = password.length > 0 && autoLogin ? loginDocument(base, password) : undefined
        if (document === undefined) {
          res.writeHead(302, { Location: base.href, 'Cache-Control': 'no-store' })
          return res.end()
        }
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': Buffer.byteLength(document),
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
        })
        return res.end(document)
      },
    }), 'DSHCodeServerView: login route')

    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/restart`,
      handler: async (req, res) => {
        if (!isLoopback(req)) return sendJson(res, 404, { error: 'not-found' })
        await supervisor.restart()
        return sendJson(res, 200, supervisor.status())
      },
    }), 'DSHCodeServerView: restart route')
  })
}
