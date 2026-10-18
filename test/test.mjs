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

function mockContext() {
  const commands = new Map()
  const guards = []
  const services = new Map()
  const presets = {
    currentName: BUILD,
    set: (_session, name) => { presets.currentName = name },
    current: () => presets.currentName,
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
    effect: (callback) => { callback() },
    logger: { warn: () => {} },
  }
  return { ctx, commands, guards, services, presets }
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
  for (const name of ['mode', 'undo', 'redo', 'rename', 'exportmd', 'seesession', 'models']) {
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

test('/mode switches the slot and injects a trailing notice', () => {
  const { ctx, commands, presets } = mockContext()
  apply(ctx, {})
  const injected = []
  const result = commands.get('mode').handler({
    rawInput: 'oc-plan',
    agent: { session: mockSession(), inject: (message) => injected.push(message) },
  })
  assert.equal(result.kind, 'success')
  assert.equal(presets.currentName, PLAN)
  assert.equal(injected.length, 1)
  assert.equal(injected[0].role, 'user')
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
  assert.equal(guards[0]({ agent: { session }, name: 'bash', arguments: { command: 'javac /tmp/Main.java && java -cp /tmp Main' } }), undefined)
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

test('/rename pins a title through the title service', () => {
  const { ctx, commands, services } = mockContext()
  services.set('sessionTitle', { rename: (session, title) => ({ title }) })
  apply(ctx, {})
  const result = commands.get('rename').handler({ rawInput: 'My new title', agent: { session: mockSession() } })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /My new title/)
})

test('/rename rejects an empty title', () => {
  const { ctx, commands } = mockContext()
  apply(ctx, {})
  const result = commands.get('rename').handler({ rawInput: '', agent: { session: mockSession() } })
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

test('/seesession lists sessions and reads another transcript', async () => {
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
  const list = await commands.get('seesession').handler({ rawInput: '', agent })
  assert.equal(list.kind, 'success')
  assert.match(list.text, /session-other/)
  const read = await commands.get('seesession').handler({ rawInput: 'session-other', agent })
  assert.equal(read.kind, 'success')
  assert.match(read.text, /transcript of session-other/)
})

test('/models is an alias pointing at the model picker', () => {
  const { ctx, commands } = mockContext()
  apply(ctx, {})
  const result = commands.get('models').handler({ rawInput: '', agent: { session: mockSession() } })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /\/model/)
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
