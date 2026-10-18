/**
 * opencode-plan-build — opencode 式 plan/build 挡位 for dsh.
 *
 * Host duties:
 *   1. `/mode oc-plan|oc-build` switches the session's permission slot and
 *      injects a mode notice as a trailing user message (prefix cache stays
 *      reusable; the system prompt is never rewritten).
 *   2. `ctx.tools.guard()` enforces the OC Plan contract at dispatch time:
 *      formal-directory writes and high-risk commands are denied with a reason
 *      the model can act on ("switch to OC Build"), and sandbox escalation is
 *      refused so no approval popup appears. Tool schemas never change, so the
 *      KV prefix stays byte-identical.
 *   3. `/undo` + `/redo` (message-level revert: the tail is replaced inside the
 *      surface so the prefix before the revert point stays cache-reusable),
 *      `/rename`, `/export` (markdown to a directory), `/seesession` (another
 *      session's transcript), and `/models` as an alias of the built-in
 *      `/model` catalog.
 *
 * @module dsh-opencode-mode
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import fs from 'node:fs'
import path from 'node:path'

export const name = 'opencode-plan-build'
export const inject = ['tools', 'permissionPresets', 'commands']

const PLAN = 'oc-plan'
const BUILD = 'oc-build'

/** Write-family tool names (schemas vary by composition). */
const WRITE_TOOLS = new Set(['write', 'edit', 'patch', 'multiedit', 'apply_patch', 'write_file', 'edit_file', 'create_file'])

/** Absolute roots that count as scratch space. */
const TEMP_ROOTS = ['/tmp', '/private/tmp', '/var/tmp', '/dev/shm', '/run/user']

/** Commands whose first token is read-only or scratch-only, prefix matched. */
const ALLOWED_PREFIXES = [
  'ls', 'cat', 'head', 'tail', 'wc', 'stat', 'file', 'du', 'df', 'find', 'grep', 'rg',
  'sed -n', 'awk', 'tree', 'readlink', 'realpath', 'basename', 'dirname', 'sort', 'uniq',
  'cut', 'tr', 'jq', 'yq', 'md5sum', 'sha256sum', 'diff', 'cmp', 'lsblk', 'lscpu',
  'git status', 'git log', 'git diff', 'git show', 'git branch', 'git rev-parse',
  'git remote', 'git ls-files', 'git blame', 'git stash list', 'git describe',
  'ps', 'top', 'htop', 'uptime', 'free', 'uname', 'hostname', 'date', 'whoami', 'id',
  'env', 'pwd', 'which', 'type', 'ss', 'netstat', 'ip a', 'ip addr', 'nvidia-smi',
  'journalctl', 'systemctl status', 'systemctl list-units', 'dmesg',
  'docker ps', 'docker images', 'docker logs', 'docker inspect', 'docker stats',
  'docker version', 'docker info',
  'curl', 'wget', 'ping', 'dig', 'nslookup', 'traceroute', 'ssh',
  'mkdir -p /tmp', 'mkdir -p "$TMPDIR', 'touch /tmp', 'mktemp', 'cat > /tmp',
  'cat >> /tmp', 'echo > /tmp', 'echo >> /tmp', 'tee /tmp', 'cp ', 'mv ',
  'javac', 'java ', 'python3 -c', 'python -c', 'node -e', 'node -v', 'python3 -V',
  'go run', 'go build', 'cargo run', 'cargo build', 'rustc', 'gcc ', 'g++ ', 'make',
  'git clone', 'pip download', 'npm pack', 'npm view', 'pip show', 'pip list',
]

/** First tokens that are always denied in OC Plan. */
const DENIED_PREFIXES = [
  'rm ', 'rm -', 'rmdir', 'sed -i', 'tee /etc', 'chmod', 'chown', 'chattr',
  'apt', 'apt-get', 'dpkg', 'pip install', 'npm install -g', 'npm i -g',
  'systemctl restart', 'systemctl stop', 'systemctl start', 'systemctl enable',
  'systemctl disable', 'reboot', 'shutdown', 'poweroff', 'init ', 'telinit',
  'kill', 'pkill', 'killall', 'docker run', 'docker rm', 'docker stop', 'docker start',
  'docker pull', 'docker push', 'docker exec', 'docker compose', 'git commit',
  'git push', 'git reset', 'git checkout', 'git clean', 'git rebase', 'git merge',
  'npm publish', 'pnpm publish', 'ollama', 'mount', 'umount', 'swapon', 'mkswap',
  'iptables', 'nft ', 'ufw ', 'ip link set', 'ip addr add', 'ip route add',
]

/** Per-session undo/redo bookkeeping (message-level revert). */
const undoState = new WeakMap()

function isTempPath(value) {
  if (typeof value !== 'string' || value === '') return false
  for (const root of TEMP_ROOTS) {
    if (value === root || value.startsWith(`${root}/`)) return true
  }
  const tmp = process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP
  if (typeof tmp === 'string' && tmp !== '') {
    const root = tmp.replace(/[\\/]+$/, '')
    if (value === root || value.startsWith(`${root}/`) || value.startsWith(`${root}\\`)) return true
  }
  return false
}

/** Split a compound command into simple command segments. */
function segments(command) {
  return command
    .split(/\s*(?:&&|\|\||;|\n)\s*/u)
    .map((part) => part.trim())
    .filter((part) => part !== '')
}

/** Deny a command unless every segment is allowed or writes only into scratch space. */
function bashAllowed(command) {
  if (typeof command !== 'string' || command.trim() === '') return false
  for (const segment of segments(command)) {
    const parts = segment.split('|').map((p) => p.trim()).filter((p) => p !== '')
    for (const part of parts) {
      if (!singleAllowed(part)) return false
    }
  }
  return true
}

/** ssh: only a read-only remote command is allowed; a bare shell and remote writes are denied. */
function sshAllowed(part) {
  const tokens = part.split(/\s+/u).filter((token) => token !== '')
  let index = 1
  while (index < tokens.length) {
    const token = tokens[index]
    if (!token.startsWith('-')) break
    if (['-p', '-o', '-i', '-l', '-F', '-L', '-R', '-D'].includes(token)) index += 2
    else index += 1
  }
  const host = tokens[index]
  if (host === undefined) return false
  const remote = tokens.slice(index + 1).join(' ').replace(/^["']|["']$/gu, '')
  if (remote === '') return false
  for (const segment of segments(remote)) {
    const parts = segment.split('|').map((p) => p.trim()).filter((p) => p !== '')
    for (const inner of parts) {
      if (inner === 'ssh' || inner.startsWith('ssh ')) return false
      if (!singleAllowed(inner)) return false
    }
  }
  return true
}

function singleAllowed(part) {
  if (part === 'ssh' || part.startsWith('ssh ')) return sshAllowed(part)
  for (const denied of DENIED_PREFIXES) {
    if (part === denied || part.startsWith(denied)) return false
  }
  const redirect = /(?:^|\s)(?:>>?|>\|)\s*(\S+)/gu
  let match
  while ((match = redirect.exec(part)) !== null) {
    if (!isTempPath(match[1])) return false
  }
  for (const allowed of ALLOWED_PREFIXES) {
    if (part === allowed || part.startsWith(allowed)) return true
  }
  return false
}

/** The mode notice shape: user-role, trailing, never part of the system prompt. */
function modeNotice(target) {
  const text = target === PLAN
    ? 'The user switched this session to OC Plan (opencode plan mode). This is a read-only planning slot: only inspections, read-only commands, and scratch work under the temporary directory are allowed; formal-directory writes and high-risk commands are denied. Do not present a plan as a plain reply — the user switches to OC Build when ready to execute. Do not use todo_write to track the planning phase.'
    : 'The user switched this session to OC Build (opencode build mode). Implementation is allowed again: write files, run commands, and carry out the plan.'
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'opencode-plan-build', form: 'notice', summary: `mode:${target}` },
  })
}

/** Flatten one derived message into markdown-ish text for export or transcript reads. */
function messageText(message) {
  const blocks = message.content ?? []
  const parts = []
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'thinking' && typeof block.text === 'string') parts.push(`> ${block.text}`)
    else if (block.type === 'tool-call') parts.push(`[tool ${block.name ?? ''}]`)
    else if (block.type === 'tool-result') parts.push('[tool result]')
  }
  return parts.join('\n')
}

function formatSession(events, header) {
  const lines = [`# Session ${header?.id ?? ''}`, '']
  for (const event of events) {
    if (event.type === 'user/message') {
      const text = messageText({ content: event.data?.content ?? [] })
      if (text !== '') lines.push(`## User`, '', text, '')
    } else if (event.type === 'assistant/message') {
      const text = messageText({ content: event.data?.content ?? [] })
      if (text !== '') lines.push(`## Assistant`, '', text, '')
    }
  }
  return lines.join('\n')
}

export function apply(ctx, config = {}) {
  const planPreset = typeof config.planPreset === 'string' ? config.planPreset : PLAN
  const buildPreset = typeof config.buildPreset === 'string' ? config.buildPreset : BUILD

  // `/mode [oc-plan|oc-build]`
  ctx.commands.register({
    definitionId: 'opencode-plan-build:mode',
    name: 'mode',
    description: 'Switch the opencode-style mode (oc-plan = read-only planning, oc-build = execute)',
    input: { hint: '[oc-plan|oc-build]' },
    handler: (invocation) => {
      const presets = ctx.get('permissionPresets')
      if (presets === undefined) return { kind: 'error', text: 'permission presets are unavailable in this composition' }
      const requested = invocation.rawInput.trim()
      const session = invocation.agent.session
      if (requested === '') {
        const current = presets.current(session)
        return { kind: 'success', text: `Current mode: ${current}${current === planPreset ? ' (OC Plan)' : current === buildPreset ? ' (OC Build)' : ''}` }
      }
      if (requested !== planPreset && requested !== buildPreset) {
        return { kind: 'error', text: `Unknown mode "${requested}". Use /mode ${planPreset} or /mode ${buildPreset}.` }
      }
      presets.set(session, requested)
      invocation.agent.inject(modeNotice(requested))
      return { kind: 'success', text: requested === planPreset ? 'OC Plan — read-only planning.' : 'OC Build — execution allowed.' }
    },
  })

  // `/undo` — message-level revert: replace the last user turn and everything
  // after it inside the surface. The log stays append-only, and the prefix
  // before the revert point stays byte-identical (cache reusable).
  ctx.commands.register({
    definitionId: 'opencode-plan-build:undo',
    name: 'undo',
    description: 'Revert the last user turn (message-level; no file snapshot)',
    handler: (invocation) => {
      const session = invocation.agent.session
      const nodes = session.surface.nodes
      let lastUserSeq
      let lastUserData
      for (let i = nodes.length - 1; i >= 0; i -= 1) {
        const event = session.eventAt(nodes[i])
        if (event?.type === 'user/message' && event.data?.source?.kind !== 'opencode-plan-build') {
          lastUserSeq = nodes[i]
          lastUserData = event.data
          break
        }
      }
      if (lastUserSeq === undefined) return { kind: 'error', text: 'Nothing to undo in this session.' }
      const endSeq = nodes[nodes.length - 1]
      const before = session.deriveMessages().map((message) => ({ role: message.role, content: message.content }))
      const placeholder = createUserMessage({
        content: [{ type: 'text', text: 'The user reverted the previous message (undo). Continue from the state before it; do not repeat it.' }],
        source: { kind: 'opencode-plan-build', form: 'notice', summary: 'undo' },
      })
      session.append('user/message', {
        content: placeholder.content,
        source: placeholder.source,
      }, {
        surfaceOp: { op: 'replace', startSeq: lastUserSeq, endSeq },
        sourceEventSeqs: [lastUserSeq],
      })
      undoState.set(session, { lastUserSeq, endSeq, before, revertedUser: lastUserData })
      return { kind: 'success', text: 'Reverted the last user turn (surface replace, log kept).' }
    },
  })

  // `/redo` — re-append the reverted user text as a fresh turn.
  ctx.commands.register({
    definitionId: 'opencode-plan-build:redo',
    name: 'redo',
    description: 'Restore the reverted user turn (redo)',
    handler: (invocation) => {
      const session = invocation.agent.session
      const state = undoState.get(session)
      if (state?.revertedUser === undefined) return { kind: 'error', text: 'Nothing to redo in this session.' }
      const text = messageText({ content: state.revertedUser.content ?? [] })
      if (text.trim() === '') return { kind: 'error', text: 'The reverted turn carries no text to restore.' }
      invocation.agent.inject(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'opencode-plan-build', form: 'notice', summary: 'redo' },
      }))
      undoState.delete(session)
      return { kind: 'success', text: 'Re-applied the reverted text as a fresh turn.' }
    },
  })

  // `/rename [title]` — session title rename (pins the title).
  ctx.commands.register({
    definitionId: 'opencode-plan-build:rename',
    name: 'rename',
    description: 'Rename the current session (pins the title)',
    input: { hint: '<title>' },
    handler: (invocation) => {
      const title = invocation.rawInput.trim()
      if (title === '') return { kind: 'error', text: 'Usage: /rename <title>' }
      const titles = ctx.get('sessionTitle')
      if (titles === undefined) return { kind: 'error', text: 'the session-title service is unavailable in this composition' }
      try {
        const snapshot = titles.rename(invocation.agent.session, title)
        return { kind: 'success', text: `Renamed: ${snapshot.title ?? title}` }
      } catch (error) {
        return { kind: 'error', text: `Rename failed: ${error instanceof Error ? error.message : String(error)}` }
      }
    },
  })

  // `/export [directory]` — write this session's transcript as markdown.
  ctx.commands.register({
    definitionId: 'opencode-plan-build:exportmd',
    name: 'exportmd',
    description: 'Export this session transcript as a markdown file into a directory (markdown; the built-in /export downloads a ZIP)',
    input: { hint: '[directory]' },
    handler: (invocation) => {
      const target = invocation.rawInput.trim() || path.join(process.env.HOME ?? '.', 'Documents')
      const dir = target.startsWith('~') ? path.join(process.env.HOME ?? '.', target.slice(1)) : target
      try {
        fs.mkdirSync(dir, { recursive: true })
        const session = invocation.agent.session
        const events = session.snapshotEvents()
        const header = session.header
        const markdown = formatSession(events, header)
        const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
        const file = path.join(dir, `dsh-session-${String(header?.id ?? 'session').slice(-8)}-${stamp}.md`)
        fs.writeFileSync(file, markdown, 'utf8')
        return { kind: 'success', text: `Exported ${markdown.length} chars to ${file}` }
      } catch (error) {
        return { kind: 'error', text: `Export failed: ${error instanceof Error ? error.message : String(error)}` }
      }
    },
  })

  // `/seesession [id-prefix]` — list sessions, or read another session's transcript.
  ctx.commands.register({
    definitionId: 'opencode-plan-build:seesession',
    name: 'seesession',
    description: 'List sessions, or read another session transcript (read-only)',
    input: { hint: '[session id prefix]' },
    handler: async (invocation) => {
      const query = ctx.get('sessionQuery')
      if (query === undefined) return { kind: 'error', text: 'the session-query service is unavailable in this composition' }
      const currentId = invocation.agent.session.header?.id
      const prefix = invocation.rawInput.trim()
      try {
        if (prefix === '') {
          const sessions = await query.listSessions()
          const rows = sessions.slice(0, 30).map((session) => `${session.id}${session.id === currentId ? '  (current)' : ''}`)
          return { kind: 'success', text: ['Sessions:', ...rows].join('\n') }
        }
        const sessions = await query.listSessions()
        const match = sessions.find((session) => session.id.startsWith(prefix))
        if (match === undefined) return { kind: 'error', text: `No session matches "${prefix}".` }
        if (match.id === currentId) return { kind: 'success', text: 'That is this session — use /seesession <other-id>.' }
        const events = await query.readSession(match.id)
        const markdown = formatSession(events, { id: match.id })
        return { kind: 'success', text: markdown.length > 12000 ? `${markdown.slice(0, 12000)}\n… (truncated)` : markdown }
      } catch (error) {
        return { kind: 'error', text: `seesession failed: ${error instanceof Error ? error.message : String(error)}` }
      }
    },
  })

  // `/models` — alias of the built-in /model catalog (client popup owns it).
  ctx.commands.register({
    definitionId: 'opencode-plan-build:models',
    name: 'models',
    description: 'Alias of the model switcher (same catalog as /model)',
    input: { hint: '[model]' },
    handler: (invocation) => ({
      kind: 'success',
      text: 'Use the /model picker to switch model and reasoning effort (the database is the same; this alias exists for opencode muscle memory).',
    }),
  })

  // Runtime guard: OC Plan denies formal-directory writes, high-risk commands,
  // and sandbox escalation. Registered globally; it reads each agent's own slot.
  ctx.tools.guard((execution) => {
    const agent = execution.agent
    if (agent === undefined) return
    const preset = ctx.get('permissionPresets')?.current(agent.session)
    if (preset !== planPreset) return

    if (WRITE_TOOLS.has(execution.name)) {
      const args = execution.arguments ?? {}
      const target = args.path ?? args.file_path ?? args.filePath
      if (typeof target !== 'string' || !isTempPath(target)) {
        return `OC Plan is a read-only planning slot: writing to ${typeof target === 'string' ? target : 'that path'} is denied. Switch to OC Build (/mode ${buildPreset}) to make changes, or use the temporary directory for scratch work.`
      }
      return
    }

    if (execution.name === 'bash' || execution.name === 'pwsh') {
      const args = execution.arguments ?? {}
      if (args.sandbox_permissions !== undefined || (typeof args.justification === 'string' && args.justification.trim() !== '')) {
        return 'OC Plan does not escalate the sandbox. Switch to OC Build (/mode oc-build) if wider access is needed.'
      }
      const command = args.command ?? args.script
      if (!bashAllowed(command)) {
        return 'OC Plan denies this command: it is not a read-only inspection, a command confined to the temporary directory, or a one-shot exercise. Switch to OC Build (/mode oc-build) to execute it.'
      }
    }
  })
}
