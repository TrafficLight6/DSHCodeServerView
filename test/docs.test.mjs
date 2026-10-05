/**
 * Documentation checks: the README and the verification record must stay
 * consistent with the code they describe, must not link files that are absent,
 * and must not carry paths that only exist on one machine.
 *
 * Zero dependencies; run with `node test/docs.test.mjs` (or `npm test`).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDir = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const read = (relative) => readFileSync(join(packageDir, relative), 'utf8')

const findings = []
let failures = 0

/**
 * Run one named check.
 * @param name - what is being asserted.
 * @param body - throws with a message when the assertion fails.
 */
function check(name, body) {
  try {
    body()
    findings.push(`PASS  ${name}`)
  } catch (error) {
    failures += 1
    findings.push(`FAIL  ${name}: ${error.message}`)
  }
}

const manifest = JSON.parse(read('package.json'))
const index = read('index.js')
const readme = read('README.md')
const verification = read('docs/verification.md')
const contract = read('test/contract.test.mjs')

/** Absolute paths that would only be valid on the machine this was written on. */
const MACHINE_PATH = /(?:[A-Za-z]:[\\/]Users[\\/]|E:[\\/])/u

/** Extensions treated as text; anything else is a binary asset. */
const TEXT_FILE = /(?:\.(?:md|js|mjs|cjs|json|yml|yaml|svg|txt|html|css)|(?:^|[\\/])(?:LICENSE|\.gitignore|\.gitmodules))$/u

/** Bitmap formats; the documentation is deliberately text-only, so none may appear. */
const BITMAP_FILE = /\.(?:png|jpe?g|gif|webp|bmp|ico|tiff?)$/iu

/**
 * List the repository's files, skipping the pieces that are not ours.
 * @param directory - the directory to walk.
 * @param keep - a predicate on the file name.
 * @returns absolute paths.
 */
function walkFiles(directory, keep = () => true) {
  const found = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'vendor') continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) found.push(...walkFiles(path, keep))
    else if (keep(entry.name)) found.push(path)
  }
  return found
}

check('the README documents every configuration key', () => {
  const block = index.slice(index.indexOf('export const Config'), index.indexOf('/** Path prefix'))
  const keys = [...block.matchAll(/^ {2,4}(\w+): Schema\./gm)].map((match) => match[1])
  if (keys.length < 20) throw new Error(`only ${keys.length} keys were found in the schema; the parser may be stale`)
  const missing = keys.filter((key) => !readme.includes(`\`${key}\``))
  if (missing.length > 0) throw new Error(`not documented: ${missing.join(', ')}`)
})

check('the README documents every host route', () => {
  const routes = [...index.matchAll(/path: `\$\{ROUTE_PREFIX\}\/(\w+)`/g)].map((match) => match[1])
  if (routes.length === 0) throw new Error('no routes were found in index.js')
  const missing = routes.filter((route) => !readme.includes(`/codeserver-view/${route}`))
  if (missing.length > 0) throw new Error(`not documented: ${missing.join(', ')}`)
})

check('the stated version matches the manifest', () => {
  if (!readme.includes(manifest.version)) throw new Error(`the README never states ${manifest.version}`)
})

check('the stated number of checks matches the contract test', () => {
  const declared = [...contract.matchAll(/^(?:await )?check(?:Async)?\(/gm)].length
  if (declared === 0) throw new Error('no checks were found in test/contract.test.mjs')
  if (!readme.includes(`${declared} 项`)) throw new Error(`the Chinese section does not state ${declared} checks`)
  if (!readme.includes(`${declared} checks`)) throw new Error(`the English section does not state ${declared} checks`)
  const documented = [...readFileSync(fileURLToPath(import.meta.url), 'utf8').matchAll(/^check\(/gm)].length
  if (!verification.includes(`${documented} 项文档检查`)) {
    throw new Error(`the verification record does not state the ${documented} documentation checks`)
  }
})

check('every shipped file is described', () => {
  const missing = manifest.files
    .filter((file) => !file.includes('*') && file !== 'README.md')
    .filter((file) => !readme.includes(file))
  if (missing.length > 0) throw new Error(`never mentioned: ${missing.join(', ')}`)
})

check('every host module is described', () => {
  const missing = ['index.js', 'supervisor.js', 'copilot.js', 'client.js'].filter((file) => !readme.includes(`\`${file}\``))
  if (missing.length > 0) throw new Error(`never mentioned: ${missing.join(', ')}`)
})

check('every relative link in the documentation resolves', () => {
  const broken = []
  for (const [name, text] of [['README.md', readme], ['docs/verification.md', verification]]) {
    for (const match of text.matchAll(/\]\(([^)#]+?)(?:#[^)]*)?\)/g)) {
      const target = match[1]
      if (/^[a-z][a-z0-9+.-]*:/iu.test(target)) continue
      if (!existsSync(resolve(packageDir, dirname(name), decodeURIComponent(target)))) broken.push(`${name} -> ${target}`)
    }
  }
  if (broken.length > 0) throw new Error(broken.join(', '))
})

check('every text file is UTF-8 without a BOM and without replacement characters', () => {
  // A shell round-trip that decodes as one encoding and re-encodes as another
  // silently corrupts CJK text and can swallow trailing punctuation, so this
  // guards the whole tree rather than only the two documents.
  const suspicious = []
  for (const file of walkFiles(packageDir, (name) => TEXT_FILE.test(name))) {
    const bytes = readFileSync(file)
    const relative = file.slice(packageDir.length + 1)
    if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) suspicious.push(`${relative} (BOM)`)
    else if (bytes.toString('utf8').includes('\uFFFD')) suspicious.push(`${relative} (replacement character)`)
  }
  if (suspicious.length > 0) throw new Error(suspicious.join(', '))
})

check('the repository ships no bitmap assets', () => {
  // The documentation is deliberately text-only: evidence is written down as
  // commands, responses and file states instead of screenshots, so a stray
  // image would mean something was committed by accident.
  const images = walkFiles(packageDir, (name) => BITMAP_FILE.test(name))
  if (images.length > 0) {
    throw new Error(images.map((file) => file.slice(packageDir.length + 1)).join(', '))
  }
})

check('no documentation carries a path from one specific machine', () => {
  const offenders = []
  for (const [name, text] of [['README.md', readme], ['docs/verification.md', verification], ['cordis.patch.yml', read('cordis.patch.yml')]]) {
    text.split('\n').forEach((line, position) => {
      if (MACHINE_PATH.test(line)) offenders.push(`${name}:${position + 1}`)
    })
  }
  if (offenders.length > 0) throw new Error(`machine-specific paths at ${offenders.join(', ')}`)
})

check('the documented example paths are placeholders, not one machine', () => {
  const block = readme.slice(readme.indexOf('## 安装'), readme.indexOf('## 配置'))
  if (!/D:\\src\\DSHCodeServerView/u.test(block)) throw new Error('the install section lost its example repository path')
})

check('claims that were corrected do not come back', () => {
  const stale = [
    '只打印一行日志',            // index.js has not been a one-line logger since 1.1
    '未做 code-server 健康检查', // the supervisor probes healthPath
    'two loopback-only routes',  // there are three
    '.verify/',                  // evidence lives in docs/verification.md now
    'docs/verification/',        // the screenshots were removed on purpose
  ]
  const found = stale.filter((phrase) => readme.includes(phrase))
  if (found.length > 0) throw new Error(found.join(' | '))
})

console.log(findings.join('\n'))
console.log(failures === 0 ? '\nRESULT: all documentation checks passed' : '\nRESULT: FAILURES PRESENT')
process.exitCode = failures === 0 ? 0 : 1
