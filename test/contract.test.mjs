/**
 * Contract test for both halves of DSHCodeServerView.
 *
 * It executes the real artifacts in sandboxes — `client.js` with a stub React,
 * a stub module-loader sink, a stub `fetch`, and a mock of the four Client
 * services the plugin declares; `index.js` with a stub Schemastery and a mock
 * Web carrier — then asserts the module-loader handoff, every registration, the
 * element trees the components return, and the behaviour of the two Host routes.
 * No dependency, no browser, no DSH install is needed:
 * `node test/contract.test.mjs`.
 *
 * It is a regression guard for the plugin's own code against the documented
 * contracts. It deliberately does not re-implement React, the slot framework, or
 * Schemastery, so a green run proves structure and route behaviour, not what the
 * framework renders.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createContext, runInContext } from 'node:vm'
import { fileURLToPath, pathToFileURL } from 'node:url'

const clientPath = fileURLToPath(new URL('../client.js', import.meta.url))
const indexPath = fileURLToPath(new URL('../index.js', import.meta.url))
const supervisorPath = fileURLToPath(new URL('../supervisor.js', import.meta.url))
const copilotPath = fileURLToPath(new URL('../copilot.js', import.meta.url))
const manifestPath = fileURLToPath(new URL('../package.json', import.meta.url))
const packageDir = dirname(manifestPath)

const findings = []
let failed = false

/** Record one assertion outcome instead of aborting the run at the first failure. */
function check(label, body) {
  try {
    body()
    findings.push(`PASS  ${label}`)
  } catch (error) {
    failed = true
    findings.push(`FAIL  ${label}: ${error.message}`)
  }
}

/** The same, for one assertion that must await the code under test. */
async function checkAsync(label, body) {
  try {
    await body()
    findings.push(`PASS  ${label}`)
  } catch (error) {
    failed = true
    findings.push(`FAIL  ${label}: ${error.message}`)
  }
}

// ------------------------------------------------------------- the stub React

/**
 * Minimal React stand-in: element trees plus the two hooks the body uses. State
 * lives in this module so a re-render sees what an effect wrote, effects are
 * recorded and flushed explicitly, and each render restarts the hook cursor.
 */
const hookState = []
const effectQueue = []
let hookCursor = 0

const stubReact = {
  Fragment: Symbol('react.fragment'),
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children }
  },
  useState(initial) {
    const index = hookCursor
    hookCursor += 1
    if (!(index in hookState)) hookState[index] = typeof initial === 'function' ? initial() : initial
    return [hookState[index], (next) => {
      hookState[index] = typeof next === 'function' ? next(hookState[index]) : next
    }]
  },
  useEffect(callback) {
    effectQueue.push(callback)
    hookCursor += 1
  },
  useCallback(callback) {
    hookCursor += 1
    return callback
  },
}

/** Render one component from a fresh hook cursor. */
function renderComponent(component, props) {
  hookCursor = 0
  effectQueue.length = 0
  return component(props)
}

/** Run the effects the last render queued, then let their promises settle. */
async function flushEffects() {
  for (const effect of effectQueue.splice(0)) effect()
  await new Promise((resolve) => { setTimeout(resolve, 0) })
}

// ------------------------------------------------------- load the real bundle

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

// ------------------------------------------------------- manifest and display

check('declares a bundle patch whose row mounts this package', () => {
  const patchPath = join(packageDir, manifest.dsh?.bundle?.patch ?? '')
  assert.ok(existsSync(patchPath), `dsh.bundle.patch -> ${manifest.dsh?.bundle?.patch} does not exist`)
  const rows = readFileSync(patchPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().startsWith('name:'))
  assert.deepEqual(rows.map((line) => line.split(':')[1].trim().replaceAll("'", '')),
    [manifest.name], 'the patch must insert exactly one row named after the package')
})

check('declares a web client half exported at ./client', () => {
  assert.equal(manifest.dsh?.client?.platform, 'web')
  assert.equal(manifest.type, 'module')
  assert.ok(existsSync(join(packageDir, 'client.js')), 'client.js is missing')
  assert.ok(existsSync(join(packageDir, 'index.js')), 'index.js is missing')
})

// The Plugins page reads the manifest's root `icon`; the exported `<name>/icon`
// alone is not enough on every resolver, so an undeclared icon silently falls
// back to a placeholder glyph.
check('declares a display icon that exists', () => {
  assert.equal(typeof manifest.icon, 'string', 'manifest.icon must name the artwork')
  assert.ok(existsSync(join(packageDir, manifest.icon)), `manifest.icon -> ${manifest.icon} does not exist`)
})

check('publishes localized title and description for every locale', () => {
  const localeDir = join(packageDir, 'locale')
  const files = readdirSync(localeDir).filter((file) => file.endsWith('.json'))
  assert.ok(files.length >= 2, 'expected at least the zh and en dictionaries')
  for (const file of files) {
    const meta = JSON.parse(readFileSync(join(localeDir, file), 'utf8')).meta
    assert.equal(typeof meta?.title, 'string', `${file}: meta.title is missing`)
    assert.ok(meta.title.length > 0, `${file}: meta.title is empty`)
    assert.equal(typeof meta?.description, 'string', `${file}: meta.description is missing`)
  }
})

check('declares the harness package it imports as a peer', () => {
  assert.ok(manifest.peerDependencies?.['@deepseek-ai/schemastery'],
    'the Host half imports @deepseek-ai/schemastery, so it must be declared')
})

let handoff
const sandbox = {
  window: { __ModuleLoader__: { load: (registration) => { handoff = registration } } },
  console,
}
runInContext(readFileSync(clientPath, 'utf8'), createContext(sandbox), { filename: 'client.js' })

const requested = []
const requireShim = (specifier) => {
  requested.push(specifier)
  if (specifier === 'react') return stubReact
  throw new Error(`the bundle requested a module outside the platform table: ${specifier}`)
}

check('registers one lazy factory under the package name', () => {
  assert.ok(handoff, 'window.__ModuleLoader__.load was never called')
  assert.equal(handoff.id, manifest.name, 'the loader id must be the package name')
  assert.equal(typeof handoff.factory, 'function')
})

let plugin
check('factory is side-effect free and returns a cordis object plugin', () => {
  plugin = handoff.factory(requireShim)
  assert.deepEqual(requested, ['react'], 'the factory must resolve React and nothing else')
  assert.equal(typeof plugin.apply, 'function')
  assert.deepEqual(
    [...plugin.inject].sort(),
    ['locale', 'sidebarRight', 'sidebarRightTabs', 'slots'],
    'the plugin injects cordis service names',
  )
})

// ------------------------------------------------------------ the mock Client

const seen = { types: [], slots: [], locales: [], effects: [], injected: [] }

/** One mock of the Client surface this plugin declares, recording every call. */
function createCtx() {
  return {
    effect(fn, label) {
      seen.effects.push(label)
      const dispose = fn()
      assert.equal(typeof dispose, 'function', `effect "${label}" must return its disposer`)
      return dispose
    },
    slots: {
      inject(key, callback) {
        seen.injected.push(key)
        return callback()
      },
      register(options, component) {
        assert.equal(typeof component, 'function', 'a slot component is a bare call signature')
        seen.slots.push({ options, component })
        return () => {}
      },
    },
    sidebarRightTabs: {
      register(definition) {
        seen.types.push(definition)
        return () => {}
      },
    },
    locale: {
      register(ns, dictionaries) {
        seen.locales.push({ ns, dictionaries })
        return () => {}
      },
      bind: () => (key) => key,
    },
  }
}

plugin.apply(createCtx())

const type = seen.types[0]
const body = seen.slots.find((entry) => entry.options.name === 'sidebar.right.pane.tab')
const title = seen.slots.find((entry) => entry.options.name === 'sidebar.right.pane.tab.title')

check('registers one tab type offered on the guide page', () => {
  assert.equal(seen.types.length, 1)
  assert.equal(type.id, manifest.name)
  assert.equal(typeof type.kind, 'string')
  assert.equal(type.priority, 'extension')
  assert.equal(type.multiple, true)
  assert.equal(typeof type.title, 'function')
  assert.equal(type.guide.length, 1)
  assert.equal(typeof type.guide[0].id, 'string')
  assert.equal(typeof type.guide[0].order, 'number')
  assert.equal(typeof type.guide[0].icon, 'function')
})

check('body and chip title register under the type id, inside ctx.slots.inject', () => {
  assert.ok(body, 'no sidebar.right.pane.tab registration')
  assert.ok(title, 'no sidebar.right.pane.tab.title registration')
  assert.equal(body.options.key, type.id, 'the keyed dispatch key must be the definition id')
  assert.equal(title.options.key, type.id)
  assert.equal(body.options.locale, seen.locales[0].ns)
  assert.deepEqual(seen.injected, ['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title'])
})

check('publishes one locale namespace with every key both halves render', () => {
  const { ns, dictionaries } = seen.locales[0]
  assert.equal(ns, manifest.name)
  const keys = [
    'type.label', 'guide.title', 'guide.description', 'frame.title',
    'status.connecting', 'action.reload', 'action.external',
  ]
  for (const [language, dictionary] of Object.entries(dictionaries)) {
    for (const key of keys) assert.equal(typeof dictionary[key], 'string', `${language}.${key} is missing`)
  }
})

check('every registration is owned by a labelled effect', () => {
  assert.equal(seen.effects.length, 4)
})

// ------------------------------------------------------------ rendered output

/** Props the seat supplies to the body: the tab information hook and `t`. */
const bodyProps = (params) => ({
  useTabInfo: () => ({ tab: { title: 'VS Code', navigation: { params } } }),
  t: (key) => key,
})

/** Depth-first search for the first element of one type. */
function findElement(node, type) {
  if (node === null || typeof node !== 'object') return undefined
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findElement(child, type)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  if (node.type === type) return node
  return findElement(node.children, type)
}

/**
 * Expand function components so the tree can be inspected like rendered output.
 * Fragments and host elements pass through; their children are expanded in place.
 * @param node - one element, text child, or array of them.
 * @returns the same shape with every function component replaced by its result.
 */
function expand(node) {
  if (node === null || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(expand)
  if (typeof node.type === 'function') return expand(node.type(node.props))
  return { ...node, children: expand(node.children) }
}

/** A Host config answer for one scenario. */
const configAnswer = (payload) => () => Promise.resolve({
  ok: true,
  json: () => Promise.resolve(payload),
})

/** A Host that does not answer at all. */
const offlineFetch = () => Promise.reject(new Error('offline'))

/**
 * Render the body, flush its config read, and render it again with the result.
 * @param params - the tab's navigation parameters.
 * @param fetchImpl - the stub `fetch` the sandbox exposes.
 * @returns the expanded element tree of the settled render.
 */
async function renderBody(params, fetchImpl) {
  hookState.length = 0
  sandbox.fetch = fetchImpl
  renderComponent(body.component, bodyProps(params))
  await flushEffects()
  return expand(renderComponent(body.component, bodyProps(params)))
}

await checkAsync('body waits for the host configuration before framing anything', async () => {
  hookState.length = 0
  sandbox.fetch = () => new Promise(() => {})
  const tree = renderComponent(body.component, bodyProps({}))
  assert.equal(findElement(tree, 'iframe'), undefined, 'nothing may be framed before the config arrives')
  assert.ok(JSON.stringify(tree).includes('status.connecting'), 'the pane shows its local placeholder')
})

await checkAsync('frames the configured address and names it in the toolbar', async () => {
  const tree = await renderBody({}, configAnswer({ url: 'http://127.0.0.1:9999/', autoLogin: true, hasPassword: false }))
  const frame = findElement(tree, 'iframe')
  assert.ok(frame, 'no iframe in the rendered tree')
  assert.equal(frame.props.src, 'http://127.0.0.1:9999/')
  assert.equal(frame.props.allow, 'clipboard-read; clipboard-write; fullscreen')
  assert.equal(frame.props.style.width, '100%')
  assert.equal(frame.props.style.flex, '1 1 auto')
  assert.ok(JSON.stringify(tree).includes('http://127.0.0.1:9999/'), 'the toolbar shows the configured address')
})

await checkAsync('logs in through the host route when a password is configured', async () => {
  const tree = await renderBody({}, configAnswer({ url: 'http://127.0.0.1:9999/', autoLogin: true, hasPassword: true }))
  assert.equal(findElement(tree, 'iframe').props.src, '/codeserver-view/login',
    'a configured password frames the host login route, never the password itself')
  assert.ok(JSON.stringify(tree).includes('http://127.0.0.1:9999/'), 'the toolbar still shows the address')
})

await checkAsync('keeps the plain address when auto-login is switched off', async () => {
  const tree = await renderBody({}, configAnswer({ url: 'http://127.0.0.1:9999/', autoLogin: false, hasPassword: true }))
  assert.equal(findElement(tree, 'iframe').props.src, 'http://127.0.0.1:9999/')
})

await checkAsync('falls back to the built-in default when the host does not answer', async () => {
  const tree = await renderBody({}, offlineFetch)
  assert.equal(findElement(tree, 'iframe').props.src, 'http://127.0.0.1:8080/')
})

await checkAsync('an opener URL wins and skips the configuration read', async () => {
  let read = false
  const tree = await renderBody({ url: 'http://127.0.0.1:9999/?folder=/srv/demo' }, () => {
    read = true
    return Promise.reject(new Error('must not be called'))
  })
  assert.equal(read, false, 'an explicit URL needs no Host configuration')
  assert.equal(findElement(tree, 'iframe').props.src, 'http://127.0.0.1:9999/?folder=/srv/demo')
})

await checkAsync('body offers local reload and open-in-browser controls', async () => {
  const tree = await renderBody({}, offlineFetch)
  const buttons = []
  const collect = (node) => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach(collect)
    if (node.type === 'button') buttons.push(node)
    collect(node.children)
  }
  collect(tree)
  assert.equal(buttons.length, 2)
  for (const button of buttons) assert.equal(typeof button.props.onClick, 'function')
})

check('chip title renders the glyph and the captured tab title', () => {
  hookState.length = 0
  const tree = expand(renderComponent(title.component, { useTabInfo: () => ({ tab: { title: 'VS Code' } }) }))
  assert.equal(findElement(tree, 'svg').props.width, 16)
  assert.ok(JSON.stringify(tree.children).includes('VS Code'), 'the captured title is not rendered')
})

// --------------------------------------------------------------- the Host half

/** Schema stand-in: records each field's default so the test can assert them. */
const schemaStub = {
  object: (shape) => shape,
  string: () => ({ default: (value) => ({ kind: 'string', default: value }) }),
  boolean: () => ({ default: (value) => ({ kind: 'boolean', default: value }) }),
  number: () => ({ default: (value) => ({ kind: 'number', default: value }) }),
  array: (inner) => ({ default: (value) => ({ kind: 'array', inner, default: value }) }),
  union: (options) => ({ default: (value) => ({ kind: 'union', options, default: value }) }),
}

// Both dependency-free halves are real modules, so import them directly; only
// index.js needs a sandbox, because its Schemastery import is replaced by a stub.
const supervisorModule = await import(pathToFileURL(supervisorPath).href)
const copilotModule = await import(pathToFileURL(copilotPath).href)

const hostSandbox = {
  console: { log() {} },
  URL,
  Buffer,
  process,
  __nodeUrl: { fileURLToPath },
  __moduleUrl: pathToFileURL(indexPath).href,
  __schemaStub: schemaStub,
  __supervisor: supervisorModule,
  __copilot: copilotModule,
}
runInContext(
  `${readFileSync(indexPath, 'utf8')
    .replace("import Schema from '@deepseek-ai/schemastery'", 'const Schema = __schemaStub')
    .replace("import { fileURLToPath } from 'node:url'", 'const { fileURLToPath } = __nodeUrl')
    .replace("import { createCopilotGuard } from './copilot.js'", 'const { createCopilotGuard } = __copilot')
    .replace("import { createSupervisor, VENDORED_ROOT } from './supervisor.js'", 'const { createSupervisor, VENDORED_ROOT } = __supervisor')
    .replaceAll('import.meta.url', '__moduleUrl')
    .replace(/^export /gm, '')}
globalThis.__host = { Config, apply, name, DEFAULT_URL, PLUGIN_DIR }`,
  createContext(hostSandbox),
  { filename: 'index.js' },
)
const host = hostSandbox.__host

/** A response double recording what the handler wrote. */
function fakeResponse() {
  return {
    status: undefined,
    headers: undefined,
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
      return this
    },
    end(body) {
      this.body = body ?? ''
      return this
    },
  }
}

/** A request double from one peer address. */
const fakeRequest = (remoteAddress = '127.0.0.1') => ({ socket: { remoteAddress } })

/**
 * Mount the Host half against a mock Web carrier.
 * @param config - the plugin configuration to validate.
 * @param options - the optional subprocess service double.
 * @returns the registered routes, injection requests, and effect disposers.
 */
function mountHost(config, options = {}) {
  const routes = new Map()
  const injections = []
  const disposers = []
  const ctx = {
    inject(names, callback) {
      injections.push(names)
      callback(ctx)
    },
    effect(fn, label) {
      const dispose = fn()
      assert.equal(typeof dispose, 'function', `effect "${String(label)}" must return its disposer`)
      disposers.push({ label: String(label), dispose })
      return dispose
    },
    get: (name) => (name === 'subprocess' ? options.subprocess : undefined),
    webServer: {
      register(route) {
        if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
        routes.set(route.path, route)
        return () => {}
      },
    },
  }
  host.apply(ctx, config)
  return { routes, injections, disposers }
}

/** Call one mounted route and return its response double. */
function callRoute(routes, path, req = fakeRequest()) {
  const res = fakeResponse()
  routes.get(path).handler(req, res)
  return res
}

/** Call one mounted async route and return its settled response double. */
async function callRouteAsync(routes, path, req = fakeRequest()) {
  const res = fakeResponse()
  await routes.get(path).handler(req, res)
  return res
}

check('host config declares the address, password, and auto-login defaults', () => {
  assert.equal(host.Config.url.default, 'http://127.0.0.1:8080/')
  assert.equal(host.Config.password.default, '')
  assert.equal(host.Config.autoLogin.default, true)
})

check('host half mounts both routes through an optional web carrier', () => {
  const { routes, injections } = mountHost({ url: 'http://127.0.0.1:8080/', password: '', autoLogin: true })
  // The arrays cross a vm realm, so compare their JSON shape rather than their prototypes.
  assert.equal(JSON.stringify(injections), '[["webServer"]]',
    'the web carrier is optional, never an injection requirement')
  assert.deepEqual([...routes.keys()].sort(),
    ['/codeserver-view/config', '/codeserver-view/login', '/codeserver-view/restart'])
  for (const route of routes.values()) assert.equal(route.kind, 'exact')
})

check('config route publishes a normalized address and hides the password', () => {
  const { routes } = mountHost({ url: '127.0.0.1:9999/base', password: 'top-secret', autoLogin: true })
  const res = callRoute(routes, '/codeserver-view/config')
  assert.equal(res.status, 200)
  assert.equal(res.headers['Cache-Control'], 'no-store')
  const payload = JSON.parse(res.body)
  assert.equal(payload.url, 'http://127.0.0.1:9999/base/')
  assert.equal(payload.hasPassword, true)
  assert.equal(payload.autoLogin, true)
  assert.equal(res.body.includes('top-secret'), false, 'the password must never leave the Host')
})

check('config route falls back to the default for an unusable address', () => {
  const { routes } = mountHost({ url: 'not a url at all', password: '', autoLogin: true })
  assert.equal(JSON.parse(callRoute(routes, '/codeserver-view/config').body).url, 'http://127.0.0.1:8080/')
})

check('login route posts the escaped password to code-server and submits itself', () => {
  const { routes } = mountHost({ url: 'http://127.0.0.1:9999/base/', password: 'p<&"w', autoLogin: true })
  const res = callRoute(routes, '/codeserver-view/login')
  assert.equal(res.status, 200)
  assert.equal(res.headers['Content-Type'], 'text/html; charset=utf-8')
  assert.match(res.body, /method="post"/)
  assert.match(res.body, /action="http:\/\/127\.0\.0\.1:9999\/base\/login\?to=%2Fbase%2F"/)
  assert.ok(res.body.includes('value="p&lt;&amp;&quot;w"'), 'the password is attribute-escaped, not injected')
  assert.match(res.body, /document\.forms\[0\]\.submit\(\)/)
})

check('login route redirects instead of logging in when no password is configured', () => {
  const { routes } = mountHost({ url: 'http://127.0.0.1:9999/', password: '', autoLogin: true })
  const res = callRoute(routes, '/codeserver-view/login')
  assert.equal(res.status, 302)
  assert.equal(res.headers.Location, 'http://127.0.0.1:9999/')
})

check('login route redirects when auto-login is switched off', () => {
  const { routes } = mountHost({ url: 'http://127.0.0.1:9999/', password: 'top-secret', autoLogin: false })
  const res = callRoute(routes, '/codeserver-view/login')
  assert.equal(res.status, 302)
  assert.equal(res.body.includes('top-secret'), false, 'an opted-out auto-login must not serve the password')
})

check('both routes refuse a non-loopback peer', () => {
  const { routes } = mountHost({ url: 'http://127.0.0.1:9999/', password: 'top-secret', autoLogin: true })
  for (const path of ['/codeserver-view/config', '/codeserver-view/login']) {
    const res = callRoute(routes, path, fakeRequest('192.168.1.20'))
    assert.equal(res.status, 404, `${path} answered a remote peer`)
    assert.equal(res.body.includes('top-secret'), false)
  }
})

// ------------------------------------------------------------ the supervisor

/** Let the supervisor's pending probes, timers, and awaits settle. */
const settle = (ms = 50) => new Promise((resolve) => { setTimeout(resolve, ms) })

/** A code-server root on disk: `out/node/entry.js` plus a version to report. */
const fixtureRoot = mkdtempSync(join(tmpdir(), 'dsh-codeserver-root-'))
// A hard crash would otherwise leak the fixture, so clean it on the way out too.
process.on('exit', () => { rmSync(fixtureRoot, { recursive: true, force: true }) })
mkdirSync(join(fixtureRoot, 'out', 'node'), { recursive: true })
writeFileSync(join(fixtureRoot, 'out', 'node', 'entry.js'), '// fixture\n')
writeFileSync(join(fixtureRoot, 'package.json'), JSON.stringify({ name: 'code-server', version: '4.140.0' }))

/**
 * Subprocess service double: records every spawn and hands back a controllable
 * handle, so the test can assert argv/env and drive exit and termination.
 * @param options - the stderr text a handle should report when read.
 * @returns the service double plus its request and handle logs.
 */
function fakeSubprocess(options = {}) {
  const requests = []
  const handles = []
  return {
    requests,
    handles,
    spawn(request) {
      requests.push(request)
      const handle = {
        pid: 4000 + requests.length,
        collected: {
          stdout: { readFrom: () => ({ text: '' }) },
          stderr: { readFrom: () => ({ text: options.stderr ?? '' }) },
        },
        terminated: false,
        waited: false,
        terminate() { handle.terminated = true },
        waitForExit() { handle.waited = true; return Promise.resolve() },
      }
      // Attached after the literal so the executor cannot observe a TDZ binding.
      handle.done = new Promise((resolve) => { handle.finish = resolve })
      handles.push(handle)
      return handle
    },
    resolveExecutable: () => undefined,
  }
}

/** A health probe that answers, or one that refuses. */
const healthAnswers = () => Promise.resolve({ ok: true })
const healthRefuses = () => Promise.reject(new Error('connection refused'))

/** The supervisor snapshot the config route publishes. */
function supervisorOf(routes) {
  return JSON.parse(callRoute(routes, '/codeserver-view/config').body).supervisor
}

await checkAsync('supervision stays off unless the configuration asks for it', async () => {
  const service = fakeSubprocess()
  hostSandbox.fetch = healthAnswers
  const { routes } = mountHost({ url: 'http://127.0.0.1:8080/', password: '' }, { subprocess: service })
  await settle()
  const status = supervisorOf(routes)
  assert.equal(status.mode, 'off')
  assert.equal(status.state, 'off')
  assert.equal(service.requests.length, 0)
})

await checkAsync('a live address is adopted instead of duplicated', async () => {
  const service = fakeSubprocess()
  hostSandbox.fetch = healthAnswers
  const { routes } = mountHost({ url: 'http://127.0.0.1:8080/', manage: true, root: fixtureRoot }, { subprocess: service })
  await settle()
  const status = supervisorOf(routes)
  assert.equal(status.mode, 'attach')
  assert.equal(status.state, 'attached')
  assert.equal(service.requests.length, 0, 'an answering address must never be spawned twice')
})

await checkAsync('a dead address is spawned from the configured root', async () => {
  const service = fakeSubprocess()
  let answering = false
  hostSandbox.fetch = () => (answering ? healthAnswers() : healthRefuses())
  const { routes } = mountHost({
    url: 'http://127.0.0.1:9999/',
    manage: true,
    root: fixtureRoot,
    password: 'top-secret',
    dataDir: 'C:/code-server-data',
  }, { subprocess: service })
  await settle()

  assert.equal(service.requests.length, 1, 'exactly one spawn')
  const request = service.requests[0]
  assert.equal(request.argv[1], fixtureRoot, 'code-server runs from its root directory')
  assert.equal(JSON.stringify(request.argv.slice(-4)),
    JSON.stringify(['--bind-addr', '127.0.0.1:9999', '--user-data-dir', 'C:/code-server-data']),
    'the bind address is derived from url and dataDir becomes an argument')
  assert.equal(request.env.PASSWORD, 'top-secret', 'the password travels through the environment')
  assert.equal(request.argv.join(' ').includes('top-secret'), false, 'the password must never sit in argv')
  assert.equal(request.stdio.stdin, 'ignore')

  answering = true
  await settle(600)
  const status = supervisorOf(routes)
  assert.equal(status.state, 'running')
  assert.equal(status.version, '4.140.0', 'the running root reports its own version')
  assert.ok(status.pid > 0)
})

await checkAsync('a root that is not code-server is refused with a clear message', async () => {
  const service = fakeSubprocess()
  hostSandbox.fetch = healthRefuses
  const { routes } = mountHost({
    url: 'http://127.0.0.1:9999/',
    manage: true,
    root: join(fixtureRoot, 'not-code-server'),
  }, { subprocess: service })
  await settle()
  const status = supervisorOf(routes)
  assert.equal(status.state, 'error')
  assert.match(status.message, /does not look like a code-server root/)
  assert.equal(service.requests.length, 0)
})

await checkAsync('a code-server that never answers is reported with its output tail', async () => {
  const service = fakeSubprocess({ stderr: 'Error: listen EADDRINUSE: address already in use' })
  hostSandbox.fetch = healthRefuses
  const { routes } = mountHost({
    url: 'http://127.0.0.1:9999/',
    manage: true,
    root: fixtureRoot,
    startTimeoutMs: 200,
  }, { subprocess: service })
  await settle(700)
  const status = supervisorOf(routes)
  assert.equal(status.state, 'error')
  assert.match(status.message, /did not answer/)
  assert.match(status.message, /EADDRINUSE/, 'the child output tail explains the failure')
})

await checkAsync('an unexpected exit is reported and left alone when restart is never', async () => {
  const service = fakeSubprocess()
  let answering = false
  hostSandbox.fetch = () => (answering ? healthAnswers() : healthRefuses())
  const { routes } = mountHost({
    url: 'http://127.0.0.1:9999/',
    manage: true,
    root: fixtureRoot,
    restart: 'never',
  }, { subprocess: service })
  await settle()
  answering = true
  await settle(600)
  assert.equal(supervisorOf(routes).state, 'running')

  service.handles[0].finish({ exitCode: 3, signal: null })
  await settle()
  const status = supervisorOf(routes)
  assert.equal(status.state, 'exited')
  assert.equal(status.exitCode, 3)
  assert.equal(service.requests.length, 1, 'restart: never must not spawn again')
})

await checkAsync('the restart route replaces the managed process', async () => {
  const service = fakeSubprocess()
  let answering = false
  hostSandbox.fetch = () => (answering ? healthAnswers() : healthRefuses())
  const { routes } = mountHost({ url: 'http://127.0.0.1:9999/', manage: true, root: fixtureRoot }, { subprocess: service })
  await settle()
  answering = true
  await settle(600)
  assert.equal(supervisorOf(routes).state, 'running')

  const response = await callRouteAsync(routes, '/codeserver-view/restart')
  const status = JSON.parse(response.body)
  assert.equal(service.handles[0].terminated, true, 'the previous process is terminated')
  assert.equal(service.handles[0].waited, true, 'and its whole range is awaited')
  assert.equal(service.handles.length, 1, 'an address that answers afterwards is adopted, not spawned again')
  assert.equal(status.mode, 'attach')
})

await checkAsync('unloading leaves the process alone by default', async () => {
  const service = fakeSubprocess()
  let answering = false
  hostSandbox.fetch = () => (answering ? healthAnswers() : healthRefuses())
  const { disposers } = mountHost({ url: 'http://127.0.0.1:9999/', manage: true, root: fixtureRoot }, { subprocess: service })
  await settle()
  answering = true
  await settle(600)

  const supervisorEffect = disposers.find((entry) => entry.label.includes('supervisor'))
  assert.ok(supervisorEffect, 'the supervisor owns an effect')
  await supervisorEffect.dispose()
  assert.equal(service.handles[0].terminated, false,
    'a configuration edit must not kill the IDE; the DSH lifetime owns the process')
})

await checkAsync('stopOnUnload terminates the managed range', async () => {
  const service = fakeSubprocess()
  let answering = false
  hostSandbox.fetch = () => (answering ? healthAnswers() : healthRefuses())
  const { disposers } = mountHost({
    url: 'http://127.0.0.1:9999/',
    manage: true,
    root: fixtureRoot,
    stopOnUnload: true,
  }, { subprocess: service })
  await settle()
  answering = true
  await settle(600)

  const supervisorEffect = disposers.find((entry) => entry.label.includes('supervisor'))
  await supervisorEffect.dispose()
  assert.equal(service.handles[0].terminated, true)
  assert.equal(service.handles[0].waited, true)
})

// --------------------------------------------------------------- the Copilot guard

/**
 * Build a code-server-shaped fixture: an installation with built-in extensions,
 * a user data directory with settings and caches, and a work directory beside
 * the installation (never inside it, which the guard refuses).
 * @param name - a label used in the directory name.
 * @returns the fixture paths.
 */
function makeCopilotFixture(name) {
  const base = mkdtempSync(join(tmpdir(), `dsh-copilot-${name}-`))
  process.on('exit', () => { rmSync(base, { recursive: true, force: true }) })
  const root = join(base, 'code-server')
  const extensions = join(root, 'lib', 'vscode', 'extensions')
  const write = (relative, body) => {
    const file = join(base, 'localappdata', 'code-server', 'Data', relative)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body))
  }
  const writeExtension = (directory, manifest) => {
    const file = join(extensions, directory, 'package.json')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(manifest))
  }
  writeExtension('copilot', { publisher: 'GitHub', name: 'copilot-chat', version: '0.68.0' })
  writeExtension('github-authentication', { publisher: 'GitHub', name: 'github-authentication', version: '0.1.0' })
  writeExtension('python', { publisher: 'ms-python', name: 'python', version: '2026.1.0' })
  mkdirSync(join(extensions, 'mystery'), { recursive: true })
  write(join('User', 'settings.json'), '{\n  // keep this comment\n  "workbench.colorTheme": "Dark 2026"\n}\n')
  write(join('User', 'globalStorage', 'github.copilot-chat', 'cache.json'), '{}')
  write(join('User', 'globalStorage', 'other.extension', 'keep.json'), '{}')
  write(join('User', 'customBuiltinExtensionsCache.json'), '[]')
  write(join('CachedProfilesData', '__default__profile__', 'extensions.builtin.cache'), '{}')
  return {
    base,
    root,
    extensions,
    work: join(base, 'work'),
    data: join(base, 'localappdata', 'code-server', 'Data'),
  }
}

/**
 * Build a guard bound to one fixture.
 * @param fixture - the fixture paths.
 * @param config - the Copilot configuration to test.
 * @returns the guard.
 */
function guardFor(fixture, config) {
  return copilotModule.createCopilotGuard({
    config: { workDir: fixture.work, ...config },
    root: fixture.root,
    pluginDir: packageDir,
    platform: 'win32',
    env: { LOCALAPPDATA: join(fixture.base, 'localappdata') },
    home: fixture.base,
  })
}

await checkAsync('the Copilot guard does nothing until it is switched on', async () => {
  const fixture = makeCopilotFixture('off')
  const result = await guardFor(fixture, { disable: false }).apply({ root: fixture.root, dataDir: '' })
  assert.deepEqual(result.args, [], 'no argument is contributed while disabled')
  assert.equal(existsSync(fixture.work), false, 'no work directory is created while disabled')
  const settings = join(fixture.data, 'User', 'settings.json')
  assert.equal(readFileSync(settings, 'utf8'), '{\n  // keep this comment\n  "workbench.colorTheme": "Dark 2026"\n}\n',
    'the settings file is byte-identical: nothing was written')
  assert.equal(existsSync(`${settings}.dsh-backup`), false)
})

await checkAsync('the guard filters built-in extensions by manifest identity', async () => {
  const fixture = makeCopilotFixture('filter')
  const result = await guardFor(fixture, { disable: true }).apply({ root: fixture.root, dataDir: '' })
  assert.equal(result.args[0], '--builtin-extensions-dir')
  const filtered = result.args[1]
  assert.ok(filtered.startsWith(fixture.work), 'the filtered directory lives in workDir')

  const linked = readdirSync(filtered).filter((name) => name !== 'manifest.json').sort()
  assert.deepEqual(linked, ['github-authentication', 'mystery', 'python'],
    'every built-in except Copilot is linked, including one whose manifest cannot be read')
  assert.equal(linked.includes('copilot'), false, 'the Copilot extension is not present at all')

  const manifest = JSON.parse(readFileSync(join(filtered, 'manifest.json'), 'utf8'))
  assert.deepEqual(manifest.excluded, ['GitHub.copilot-chat'])
  assert.equal(result.status.excluded.includes('GitHub.copilot-chat'), true)
  assert.equal(result.status.builtinDir, filtered)
})

await checkAsync('a publisher rule removes that publisher without touching others', async () => {
  const fixture = makeCopilotFixture('publisher')
  const result = await guardFor(fixture, { disable: true, excludePublishers: ['github'] })
    .apply({ root: fixture.root, dataDir: '' })
  const linked = readdirSync(result.args[1]).filter((name) => name !== 'manifest.json').sort()
  assert.deepEqual(linked, ['mystery', 'python'], 'both GitHub extensions are gone, the rest stay')
})

await checkAsync('the guard rebuilds itself when the installation changes', async () => {
  const fixture = makeCopilotFixture('upgrade')
  const first = await guardFor(fixture, { disable: true }).apply({ root: fixture.root, dataDir: '' })
  writeFileSync(join(fixture.extensions, 'python', 'package.json'),
    JSON.stringify({ publisher: 'ms-python', name: 'python', version: '2026.2.0' }))

  const second = await guardFor(fixture, { disable: true }).apply({ root: fixture.root, dataDir: '' })
  assert.notEqual(second.args[1], first.args[1], 'an upgrade produces a new filtered directory')
  const kept = readdirSync(join(fixture.work, 'builtin-extensions'))
  assert.deepEqual(kept, [second.args[1].split(/[\\/]/u).pop()], 'only the fingerprint in use is kept')
  assert.equal(existsSync(first.args[1]), false, 'the stale directory is removed')
})

await checkAsync('settings are merged without losing the user keys', async () => {
  const fixture = makeCopilotFixture('settings')
  const file = join(fixture.data, 'User', 'settings.json')
  const result = await guardFor(fixture, { disable: true, builtinExtensions: false })
    .apply({ root: fixture.root, dataDir: '' })

  assert.equal(result.dataDir, fixture.data, 'an unpinned data directory resolves to code-server’s default')
  const merged = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(merged['workbench.colorTheme'], 'Dark 2026', 'the user value survives')
  assert.equal(merged['chat.disableAIFeatures'], true)
  assert.equal(merged['chat.commandCenter.enabled'], false)
  assert.deepEqual(merged['github.copilot.enable'], { '*': false })
  assert.equal(result.status.settingsWritten, true)

  const backup = readFileSync(`${file}.dsh-backup`, 'utf8')
  assert.match(backup, /keep this comment/, 'the original file is backed up verbatim')
})

await checkAsync('an unparsable settings file is reported and left untouched', async () => {
  const fixture = makeCopilotFixture('broken')
  const file = join(fixture.data, 'User', 'settings.json')
  writeFileSync(file, '{ this is not json')
  const result = await guardFor(fixture, { disable: true, builtinExtensions: false })
    .apply({ root: fixture.root, dataDir: '' })
  assert.equal(result.status.settingsWritten, false)
  assert.equal(result.status.reason, 'unparsable')
  assert.equal(readFileSync(file, 'utf8'), '{ this is not json', 'the file is never rewritten')
})

await checkAsync('the fill policy respects a value the user already set', async () => {
  const fixture = makeCopilotFixture('policy')
  const file = join(fixture.data, 'User', 'settings.json')
  writeFileSync(file, JSON.stringify({ 'chat.disableAIFeatures': false }))
  await guardFor(fixture, { disable: true, builtinExtensions: false, settingsPolicy: 'fill' })
    .apply({ root: fixture.root, dataDir: '' })
  assert.equal(JSON.parse(readFileSync(file, 'utf8'))['chat.disableAIFeatures'], false)

  await guardFor(fixture, { disable: true, builtinExtensions: false, settingsPolicy: 'enforce' })
    .apply({ root: fixture.root, dataDir: '' })
  assert.equal(JSON.parse(readFileSync(file, 'utf8'))['chat.disableAIFeatures'], true)
})

await checkAsync('Copilot leftovers and the extension caches are purged, nothing else', async () => {
  const fixture = makeCopilotFixture('purge')
  const result = await guardFor(fixture, { disable: true, builtinExtensions: false })
    .apply({ root: fixture.root, dataDir: '' })
  assert.equal(existsSync(join(fixture.data, 'User', 'globalStorage', 'github.copilot-chat')), false)
  assert.equal(existsSync(join(fixture.data, 'User', 'customBuiltinExtensionsCache.json')), false)
  assert.equal(existsSync(join(fixture.data, 'CachedProfilesData', '__default__profile__', 'extensions.builtin.cache')), false)
  assert.equal(existsSync(join(fixture.data, 'User', 'globalStorage', 'other.extension', 'keep.json')), true,
    'unrelated state survives')
  assert.equal(result.status.purged.length, 3)
})

await checkAsync('a work directory inside the installation or the package is refused', async () => {
  const fixture = makeCopilotFixture('unsafe')
  const insideInstall = await copilotModule.createCopilotGuard({
    config: { disable: true, workDir: join(fixture.root, 'lib', 'derived') },
    root: fixture.root,
    pluginDir: packageDir,
  }).apply({ root: fixture.root, dataDir: '' })
  assert.equal(insideInstall.status.reason, 'unsafe-work-dir')
  assert.equal(existsSync(join(fixture.root, 'lib', 'derived')), false, 'nothing is created inside the installation')

  const insidePackage = await copilotModule.createCopilotGuard({
    config: { disable: true, workDir: join(packageDir, '.derived') },
    root: fixture.root,
    pluginDir: packageDir,
  }).apply({ root: fixture.root, dataDir: '' })
  assert.equal(insidePackage.status.reason, 'unsafe-work-dir')
  assert.equal(existsSync(join(packageDir, '.derived')), false, 'nothing is created inside the plugin package')
})

// A linked plugin (junction into this checkout) is imported from its real path,
// where only this package's own node_modules is reachable. A bare import that is
// merely a peer dependency is NOT installed for a link, so it fails at import
// time in the packaged desktop runtime and surfaces as
// "1 entry did not activate ... failed to import". Every bare import must
// therefore be a real dependency.
await checkAsync('every bare import in the shipped modules is a declared dependency', async () => {
  const declared = new Set(Object.keys(manifest.dependencies ?? {}))
  const peers = new Set(Object.keys(manifest.peerDependencies ?? {}))
  const offenders = []
  for (const file of ['index.js', 'supervisor.js', 'copilot.js']) {
    const source = readFileSync(join(packageDir, file), 'utf8')
    for (const match of source.matchAll(/^import\s[^'"]*['"]([^'"]+)['"]/gm)) {
      const specifier = match[1]
      if (specifier.startsWith('.') || specifier.startsWith('node:')) continue
      const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]
      if (declared.has(name)) continue
      offenders.push(`${file} imports ${name}${peers.has(name) ? ' (declared only as a peer)' : ''}`)
    }
  }
  assert.equal(offenders.length, 0, `bare imports that a linked install cannot resolve: ${offenders.join('; ')}`)
  assert.ok(declared.has('@deepseek-ai/schemastery'), 'schemastery must stay a real dependency for linked installs')
})

rmSync(fixtureRoot, { recursive: true, force: true })

console.log(findings.join('\n'))
console.log(failed ? '\nRESULT: FAILURES PRESENT' : '\nRESULT: all contract checks passed')
process.exitCode = failed ? 1 : 0
