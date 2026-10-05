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

// The Host half is two modules. Both run as scripts with their imports stubbed,
// so the test drives the real code without a bundler or an installed profile.
const supervisorSource = readFileSync(supervisorPath, 'utf8')
  .replace(/^import .*$/gm, '')
  .replaceAll('import.meta.url', '__moduleUrl')
  .replace(/^export /gm, '')

const supervisorSandbox = {
  console: { log() {} },
  URL,
  process,
  AbortController,
  setTimeout,
  clearTimeout,
  existsSync,
  readFileSync,
  join,
  fileURLToPath,
  __moduleUrl: pathToFileURL(supervisorPath).href,
}
runInContext(
  `${supervisorSource}
globalThis.__supervisor = { createSupervisor, isRunnableRoot, launcherFor, versionOf, VENDORED_ROOT }`,
  createContext(supervisorSandbox),
  { filename: 'supervisor.js' },
)
const supervisorModule = supervisorSandbox.__supervisor

const hostSandbox = {
  console: { log() {} },
  URL,
  Buffer,
  process,
  __schemaStub: schemaStub,
  __supervisor: supervisorModule,
}
runInContext(
  `${readFileSync(indexPath, 'utf8')
    .replace("import Schema from '@deepseek-ai/schemastery'", 'const Schema = __schemaStub')
    .replace("import { createSupervisor, VENDORED_ROOT } from './supervisor.js'", 'const { createSupervisor, VENDORED_ROOT } = __supervisor')
    .replace(/^export /gm, '')}
globalThis.__host = { Config, apply, name, DEFAULT_URL }`,
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

rmSync(fixtureRoot, { recursive: true, force: true })

console.log(findings.join('\n'))
console.log(failed ? '\nRESULT: FAILURES PRESENT' : '\nRESULT: all contract checks passed')
process.exitCode = failed ? 1 : 0
