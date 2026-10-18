/**
 * Unit tests for dsh-opencode-mode host logic: registered commands, the OC Plan
 * dispatch guard, and the message-level undo/redo bookkeeping. Runs against the
 * real plugin module with a mock Cordis context, so no dsh process is required.
 *
 * Run: node test/test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'

const PLAN = 'oc-plan'
const BUILD = 'oc-build'

/** Optional cross-check against the real DSH URI codec when it is installed. */
let dshReference
try {
  dshReference = await import('/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session-reference/lib/types/uri.js')
} catch {
  dshReference = undefined
}

/** Mirror of client.js's browser-side canonical encoder. */
const encodeSessionReference = (sessionId) => {
  const bytes = new TextEncoder().encode(JSON.stringify(sessionId))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '')
}

/** Mirror of client.js's label escaping for the Markdown mention form. */
const escapeReferenceLabel = (label) => String(label).replace(/[\\\]]/gu, (match) => `\\${match}`)

/** Mirror of client.js's mention renderer. */
const formatSessionReference = (sessionId, label) => `@[${escapeReferenceLabel(label ?? sessionId)}](dsh-session:${encodeSessionReference(sessionId)}) `

function mockContext() {
  const commands = new Map()
  const guards = []
  const services = new Map()
  const contexts = []
  const presets = {
    currentName: BUILD,
    set: (_session, name) => { presets.currentName = name },
    current: () => presets.currentName,
  }
  const systemPrompt = {
    context: (entry) => { contexts.push(entry); return () => {} },
    getContextOrder: (name) => (name === 'SANDBOX_POLICY' ? 110 : 0),
  }
  const ctx = {
    commands: {
      register: (definition) => {
        if (commands.has(definition.name)) throw new Error(`duplicate command ${definition.name}`)
        commands.set(definition.name, definition)
        return () => commands.delete(definition.name)
      },
    },
    tools: { guard: (guard) => { guards.push(guard); return () => {} } },
    get: (name) => (name === 'permissionPresets' ? presets : services.get(name)),
    inject: (_deps, callback) => {
      const scope = {
        get: (name) => (name === 'permissionPresets' ? presets : name === 'systemPrompt' ? systemPrompt : services.get(name)),
        systemPrompt,
        effect: (callback) => { callback() },
        logger: ctx.logger,
      }
      callback(scope)
    },
    effect: (callback) => { callback() },
    logger: { warn: () => {} },
  }
  return { ctx, commands, guards, services, presets, contexts, systemPrompt }
}

function mockSession({ events = [], title = undefined, injected = [] } = {}) {
  const appended = []
  const session = {
    header: { id: 'session-test' },
    surface: { nodes: events.map((_event, index) => index) },
    eventAt: (seq) => events[seq],
    deriveMessages: () => events.filter((event) => event.type !== 'turn/start').map((_event, index) => ({ role: index % 2 === 0 ? 'user' : 'assistant', content: [] })),
    snapshotEvents: () => events,
    append: (type, data, opts) => {
      appended.push({ type, data, opts })
      events.push({ type, data })
      session.surface.nodes.push(events.length - 1)
      return { seq: events.length - 1 }
    },
    appended,
  }
  return session
}

const tests = []
function test(name, fn) { tests.push({ name, fn }) }

test('registers every requested command', () => {
  const { ctx, commands } = mockContext()
  apply(ctx, {})
  for (const name of ['mode', 'undo', 'redo', 'rename', 'exportmd', 'sessionread', 'models', 'effort']) {
    assert.ok(commands.has(name), `missing /${name}`)
  }
})

test('/mode reports the current slot', () => {
  const { ctx, commands, presets } = mockContext()
  apply(ctx, {})
  presets.currentName = PLAN
  const result = commands.get('mode').handler({ rawInput: '', agent: { session: mockSession(), inject: () => {} } })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /oc-plan/)
})

test('/mode switches the slot without injecting a model message', () => {
  const { ctx, commands, contexts, presets } = mockContext()
  apply(ctx, {})
  const injected = []
  const agent = { session: mockSession(), inject: (message) => injected.push(message) }
  const result = commands.get('mode').handler({ rawInput: 'oc-plan', agent })
  assert.equal(result.kind, 'success')
  assert.equal(presets.currentName, PLAN)
  commands.get('mode').handler({ rawInput: 'oc-build', agent })
  assert.equal(injected.length, 0)
  assert.equal(presets.currentName, BUILD)
  assert.equal(contexts.length, 1)
  assert.equal(contexts[0].order, 111)
})

test('the slot context reports the value at request (send) time', () => {
  const { ctx, contexts, presets } = mockContext()
  apply(ctx, {})
  const session = mockSession()
  presets.currentName = PLAN
  assert.match(contexts[0].text({ agent: { session } }), /OC Plan/)
  presets.currentName = BUILD
  assert.match(contexts[0].text({ agent: { session } }), /OC Build/)
})

test('session reference URI is canonical base64url, not a bare id', () => {
  const id = 'session-d18e7ec8-7048-483b-a9ce-b92c32e61f06'
  const mention = formatSessionReference(id, '测试会话')
  assert.match(mention, /^@\[测试会话\]\(dsh-session:[A-Za-z0-9_-]+\) $/u)
  assert.ok(!mention.includes(`dsh-session:${id}`), 'a bare id must never be used as the payload')
  const match = mention.match(/^@\[(.+)\]\(dsh-session:([A-Za-z0-9_-]+)\) $/u)
  assert.notEqual(match, null)
  assert.equal(JSON.parse(Buffer.from(match[2], 'base64url').toString('utf8')), id)
  if (dshReference !== undefined) {
    assert.equal(dshReference.decodeSessionReferenceUri(`dsh-session:${match[2]}`), id)
    const parsed = dshReference.parseSessionReferenceText(mention.trim())
    assert.equal(parsed.references[0].sessionId, id)
    assert.equal(parsed.references[0].label, '测试会话')
  }
})

test('session reference labels escape brackets and backslashes', () => {
  const mention = formatSessionReference('session-x', 'a]b\\c')
  assert.match(mention, /^@\[a\\\]b\\\\c\]\(dsh-session:/u)
})

test('/mode rejects unknown slots', () => {
  const { ctx, commands } = mockContext()
  apply(ctx, {})
  const result = commands.get('mode').handler({ rawInput: 'oc-nope', agent: { session: mockSession(), inject: () => {} } })
  assert.equal(result.kind, 'error')
})

test('guard denies formal-directory writes in OC Plan', () => {
  const { ctx, guards, presets } = mockContext()
  apply(ctx, {})
  presets.currentName = PLAN
  const session = mockSession()
  const reason = guards[0]({ agent: { session }, name: 'write', arguments: { path: '/home/user/project/a.txt' } })
  assert.ok(typeof reason === 'string' && reason.includes('OC Plan'))
})

test('guard allows scratch writes in OC Plan', () => {
  const { ctx, guards, presets } = mockContext()
  apply(ctx, {})
  presets.currentName = PLAN
  const session = mockSession()
  assert.equal(guards[0]({ agent: { session }, name: 'write', arguments: { path: '/tmp/scratch/a.txt' } }), undefined)
})

test('guard allows read-only bash and denies dangerous bash in OC Plan', () => {
  const { ctx, guards, presets } = mockContext()
  apply(ctx, {})
  presets.currentName = PLAN
  const session = mockSession()
  assert.equal(guards[0]({ agent: { session }, name: 'bash', arguments: { command: 'ls -la' } }), undefined)
  assert.equal(guards[0]({ agent: { session }, name: 'bash', arguments: { command: 'git status' } }), undefined)
  assert.equal(guards[0]({ agent: { session }, name: 'bash', arguments: { command: 'ssh root@192.168.123.174 "ls /tmp"' } }), undefined)
  assert.equal(guards[0]({ agent: { session }, name: 'bash', arguments: { command: 'javac -d /tmp /tmp/Main.java && java -cp /tmp Main' } }), undefined)
  assert.equal(guards[0]({ agent: { session }, name: 'bash', arguments: { command: 'git clone https://github.com/x/y.git /tmp/y' } }), undefined)
  assert.ok(typeof guards[0]({ agent: { session }, name: 'bash', arguments: { command: 'reboot' } }) === 'string')
  assert.ok(typeof guards[0]({ agent: { session }, name: 'bash', arguments: { command: 'apt-get install -y curl' } }) === 'string')
  assert.ok(typeof guards[0]({ agent: { session }, name: 'bash', arguments: { command: 'rm -rf /home/user/project' } }) === 'string')
  assert.ok(typeof guards[0]({ agent: { session }, name: 'bash', arguments: { command: 'ssh root@host reboot' } }) === 'string')
  assert.ok(typeof guards[0]({ agent: { session }, name: 'bash', arguments: { command: 'echo x > /etc/passwd' } }) === 'string')
  assert.ok(typeof guards[0]({ agent: { session }, name: 'bash', arguments: { command: 'ls', sandbox_permissions: 'danger-full-access', justification: 'x' } }) === 'string')
})

test('guard is a no-op in OC Build', () => {
  const { ctx, guards, presets } = mockContext()
  apply(ctx, {})
  presets.currentName = BUILD
  const session = mockSession()
  assert.equal(guards[0]({ agent: { session }, name: 'write', arguments: { path: '/etc/passwd' } }), undefined)
  assert.equal(guards[0]({ agent: { session }, name: 'bash', arguments: { command: 'rm -rf /home/user/project' } }), undefined)
})

test('OC Plan confines command outputs to the temporary directory', () => {
  const { ctx, guards, presets } = mockContext()
  apply(ctx, {})
  presets.currentName = PLAN
  const session = mockSession()
  const verdict = (command) => guards[0]({ agent: { session }, name: 'bash', arguments: { command } })
  const denied = (command) => {
    assert.ok(typeof verdict(command) === 'string', `expected denial: ${command}`)
  }
  const allowed = (command) => {
    assert.equal(verdict(command), undefined, `expected allow: ${command}`)
  }

  allowed('cp a.txt /tmp/a.txt')
  denied('cp a.txt b.txt')
  allowed('mv /tmp/a.txt /tmp/b.txt')
  denied('mv a.txt b.txt')
  allowed('curl https://example.com')
  allowed('curl -o /tmp/x https://example.com')
  denied('curl -o x https://example.com')
  denied('curl -O https://example.com')
  allowed('wget -qO- https://example.com')
  allowed('wget -O /tmp/x https://example.com')
  denied('wget https://example.com')
  allowed('cat x | tee /tmp/y')
  allowed('git clone https://github.com/x/y.git /tmp/y')
  denied('git clone https://github.com/x/y.git')
  allowed('pip download -d /tmp/pip pkg')
  denied('pip download pkg')
  allowed('npm pack --pack-destination /tmp/npm')
  denied('npm pack')
  allowed('javac -d /tmp /tmp/Main.java')
  denied('javac /tmp/Main.java')
  allowed('GOCACHE=/tmp/gocache go run main.go')
  denied('go run main.go')
  allowed('CARGO_TARGET_DIR=/tmp/cargo cargo build')
  denied('cargo build')
  denied('find . -delete')
  allowed('find . -name "*.txt"')
  denied('sort -o out.txt in.txt')
  allowed('sort -o /tmp/out.txt in.txt')
  denied('awk \'BEGIN{system("rm -rf /")}\'')
  allowed('awk \'{print $1}\' file.txt')
  denied('yq -i . a.yaml')
  denied('make')
  allowed('ssh root@host "curl -o /tmp/x https://example.com"')
  denied('ssh root@host "curl -o x https://example.com"')
})

test('/undo replaces the last user turn in the surface', () => {
  const { ctx, commands, presets } = mockContext()
  apply(ctx, {})
  presets.currentName = BUILD
  const session = mockSession({
    events: [
      { type: 'user/message', data: { content: [{ type: 'text', text: 'first question' }], source: { kind: 'user' } } },
      { type: 'assistant/message', data: { content: [{ type: 'text', text: 'first answer' }] } },
    ],
  })
  const result = commands.get('undo').handler({ agent: { session }, rawInput: '' })
  assert.equal(result.kind, 'success')
  assert.equal(session.appended.length, 1)
  assert.equal(session.appended[0].type, 'user/message')
  assert.equal(session.appended[0].opts.surfaceOp.op, 'replace')
  assert.equal(session.appended[0].opts.surfaceOp.startSeq, 0)
  assert.equal(session.appended[0].opts.surfaceOp.endSeq, 1)
})

test('/undo refuses an empty session', () => {
  const { ctx, commands } = mockContext()
  apply(ctx, {})
  const result = commands.get('undo').handler({ agent: { session: mockSession() }, rawInput: '' })
  assert.equal(result.kind, 'error')
})

test('/redo restores the reverted text as a new injected turn', () => {
  const { ctx, commands, presets } = mockContext()
  apply(ctx, {})
  presets.currentName = BUILD
  const session = mockSession({
    events: [{ type: 'user/message', data: { content: [{ type: 'text', text: 'first question' }], source: { kind: 'user' } } }],
  })
  const injected = []
  const agent = { session, inject: (message) => injected.push(message) }
  commands.get('undo').handler({ agent, rawInput: '' })
  const result = commands.get('redo').handler({ agent, rawInput: '' })
  assert.equal(result.kind, 'success')
  assert.equal(injected.length, 1)
  assert.equal(JSON.stringify(injected[0]).includes('first question'), true)
})

test('/rename pins a title through the title service', async () => {
  const { ctx, commands, services } = mockContext()
  services.set('sessionTitle', { rename: (session, title) => ({ title }) })
  apply(ctx, {})
  const result = await commands.get('rename').handler({ rawInput: 'My new title', agent: { session: mockSession() } })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /My new title/)
})

test('/rename opens a dialog when bare and rejects without a channel', async () => {
  const { ctx, commands } = mockContext()
  apply(ctx, {})
  const result = await commands.get('rename').handler({ rawInput: '', agent: { session: mockSession() } })
  assert.equal(result.kind, 'error')
})

test('/exportmd writes markdown into the requested directory', () => {
  const { ctx, commands } = mockContext()
  apply(ctx, {})
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-export-test-'))
  const session = mockSession({
    events: [
      { type: 'user/message', data: { content: [{ type: 'text', text: 'hello' }] } },
      { type: 'assistant/message', data: { content: [{ type: 'text', text: 'hi there' }] } },
    ],
  })
  const result = commands.get('exportmd').handler({ rawInput: dir, agent: { session } })
  assert.equal(result.kind, 'success')
  const files = fs.readdirSync(dir)
  assert.equal(files.length, 1)
  const markdown = fs.readFileSync(path.join(dir, files[0]), 'utf8')
  assert.match(markdown, /hello/)
  assert.match(markdown, /hi there/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('/sessionread lists sessions and reads another transcript', async () => {
  const { ctx, commands, services } = mockContext()
  const sessions = [
    { id: 'session-test' },
    { id: 'session-other' },
  ]
  services.set('sessionQuery', {
    listSessions: async () => sessions,
    readSession: async (id) => [
      { type: 'user/message', data: { content: [{ type: 'text', text: `transcript of ${id}` }] } },
    ],
  })
  apply(ctx, {})
  const agent = { session: mockSession() }
  const list = await commands.get('sessionread').handler({ rawInput: '', agent })
  assert.equal(list.kind, 'success')
  assert.match(list.text, /session-other/)
  const read = await commands.get('sessionread').handler({ rawInput: 'session-other', agent })
  assert.equal(read.kind, 'success')
  assert.match(read.text, /transcript of session-other/)
})

test('/models backs a real popup picker row', () => {
  const { ctx, commands } = mockContext()
  apply(ctx, {})
  const result = commands.get('models').handler({ rawInput: '', agent: { session: mockSession() } })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /popup/)
})

test('/effort backs a real popup picker row', () => {
  const { ctx, commands } = mockContext()
  apply(ctx, {})
  const result = commands.get('effort').handler({ rawInput: '', agent: { session: mockSession() } })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /effort|level/i)
})

let failed = 0
for (const { name, fn } of tests) {
  try {
    await fn()
    console.log(`PASS  ${name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL  ${name}`)
    console.error(error)
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`)
process.exit(failed === 0 ? 0 : 1)
