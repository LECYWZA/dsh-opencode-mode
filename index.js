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
  'ls', 'cat', 'head', 'tail', 'wc', 'stat', 'file', 'du', 'df', 'grep', 'rg',
  'sed -n', 'tree', 'readlink', 'realpath', 'basename', 'dirname', 'uniq',
  'cut', 'tr', 'jq', 'md5sum', 'sha256sum', 'diff', 'cmp', 'lsblk', 'lscpu',
  'git status', 'git log', 'git diff', 'git show', 'git branch', 'git rev-parse',
  'git remote', 'git ls-files', 'git blame', 'git stash list', 'git describe',
  'ps', 'top', 'htop', 'uptime', 'free', 'uname', 'hostname', 'date', 'whoami', 'id',
  'env', 'pwd', 'which', 'type', 'ss', 'netstat', 'ip a', 'ip addr', 'nvidia-smi',
  'journalctl', 'systemctl status', 'systemctl list-units', 'dmesg',
  'docker ps', 'docker images', 'docker logs', 'docker inspect', 'docker stats',
  'docker version', 'docker info',
  'ping', 'dig', 'nslookup', 'traceroute',
  'mkdir -p /tmp', 'mkdir -p "$TMPDIR', 'touch /tmp', 'mktemp', 'cat > /tmp',
  'cat >> /tmp', 'echo > /tmp', 'echo >> /tmp', 'tee /tmp',
  'python3 -c', 'python -c', 'node -e', 'node -v', 'python3 -V',
  'java ', 'rustc', 'gcc ', 'g++ ', 'npm view', 'pip show', 'pip list',
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

/** Split one command segment into shell-like tokens (quotes honored). */
function shellTokens(part) {
  const tokens = []
  const pattern = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|(\S+)/gu
  let match
  while ((match = pattern.exec(part)) !== null) tokens.push(match[1] ?? match[2] ?? match[3])
  return tokens
}

/** Collect leading NAME=value environment assignments. */
function envAssignments(tokens, start) {
  const map = new Map()
  for (let index = 0; index < start; index += 1) {
    const token = tokens[index]
    const equals = token.indexOf('=')
    if (equals > 0) map.set(token.slice(0, equals), token.slice(equals + 1))
  }
  return map
}

function cpMvAllowed(tokens, start) {
  const args = tokens.slice(start + 1)
  const positionals = []
  let targetDir
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (token === '--') {
      positionals.push(...args.slice(index + 1))
      break
    }
    if (token === '-t' || token === '--target-directory') {
      targetDir = args[index + 1]
      index += 1
      continue
    }
    if (token.startsWith('--target-directory=')) {
      targetDir = token.slice('--target-directory='.length)
      continue
    }
    if (token.startsWith('-t') && token.length > 2) {
      targetDir = token.slice(2)
      continue
    }
    if (token.startsWith('-') && token !== '-') continue
    positionals.push(token)
  }
  if (targetDir !== undefined) return isTempPath(targetDir)
  if (positionals.length < 2) return false
  return isTempPath(positionals[positionals.length - 1])
}

function curlAllowed(tokens, start) {
  const args = tokens.slice(start + 1)
  const outputs = []
  let remoteName = false
  let outputDir
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (token === '-o' || token === '--output') {
      outputs.push(args[index + 1])
      index += 1
      continue
    }
    if (token.startsWith('--output=')) {
      outputs.push(token.slice('--output='.length))
      continue
    }
    if (token === '-O' || token === '--remote-name') {
      remoteName = true
      continue
    }
    if (token === '--output-dir') {
      outputDir = args[index + 1]
      index += 1
      continue
    }
    if (token.startsWith('--output-dir=')) {
      outputDir = token.slice('--output-dir='.length)
      continue
    }
    if (/^-[^-]/u.test(token)) {
      const short = token.slice(1)
      const at = short.indexOf('o')
      if (at >= 0) {
        const inline = short.slice(at + 1)
        if (inline !== '') outputs.push(inline)
        else {
          outputs.push(args[index + 1])
          index += 1
        }
      }
      if (short.includes('O')) remoteName = true
    }
  }
  for (const output of outputs) {
    if (output === undefined || !isTempPath(output)) return false
  }
  if (remoteName && (outputDir === undefined || !isTempPath(outputDir))) return false
  return true
}

function wgetAllowed(tokens, start) {
  const args = tokens.slice(start + 1)
  let document
  let prefix
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (token === '-O' || token === '--output-document') {
      document = args[index + 1]
      index += 1
      continue
    }
    if (token.startsWith('--output-document=')) {
      document = token.slice('--output-document='.length)
      continue
    }
    if (token === '-P' || token === '--directory-prefix') {
      prefix = args[index + 1]
      index += 1
      continue
    }
    if (token.startsWith('--directory-prefix=')) {
      prefix = token.slice('--directory-prefix='.length)
      continue
    }
    if (/^-[^-]/u.test(token)) {
      const short = token.slice(1)
      const atO = short.indexOf('O')
      if (atO >= 0) {
        const inline = short.slice(atO + 1)
        if (inline !== '') document = inline
        else if (args[index + 1] !== undefined && args[index + 1].startsWith('-')) document = '-'
        else {
          document = args[index + 1]
          index += 1
        }
      }
      const atP = short.indexOf('P')
      if (atP >= 0) {
        const inline = short.slice(atP + 1)
        if (inline !== '') prefix = inline
        else {
          prefix = args[index + 1]
          index += 1
        }
      }
    }
  }
  if (document !== undefined) return document === '-' || isTempPath(document)
  if (prefix !== undefined) return isTempPath(prefix)
  return false
}

function gitCloneAllowed(tokens, start) {
  const args = tokens.slice(start + 2)
  const withValue = new Set([
    '-b', '--branch', '--depth', '--origin', '-o', '--config', '-c', '--filter',
    '--reference', '--separate-git-dir', '--template', '--jobs', '-j',
    '--shallow-since', '--shallow-exclude', '--server-option', '--upload-pack',
  ])
  const positionals = []
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (token === '--') {
      positionals.push(...args.slice(index + 1))
      break
    }
    if (token.startsWith('--')) {
      if (!token.includes('=') && withValue.has(token)) index += 1
      continue
    }
    if (token.startsWith('-')) {
      if (withValue.has(token)) index += 1
      continue
    }
    positionals.push(token)
  }
  if (positionals.length < 2) return false
  return isTempPath(positionals[positionals.length - 1])
}

function pipDownloadAllowed(tokens, start) {
  const args = tokens.slice(start + 2)
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (token === '-d' || token === '--dest') return isTempPath(args[index + 1])
    if (token.startsWith('--dest=')) return isTempPath(token.slice('--dest='.length))
    if (token.startsWith('-d') && token.length > 2) return isTempPath(token.slice(2))
  }
  return false
}

function npmPackAllowed(tokens, start) {
  const args = tokens.slice(start + 2)
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (token === '--pack-destination') return isTempPath(args[index + 1])
    if (token.startsWith('--pack-destination=')) return isTempPath(token.slice('--pack-destination='.length))
  }
  return false
}

function javacAllowed(tokens, start) {
  const args = tokens.slice(start + 1)
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (token === '-d') return isTempPath(args[index + 1])
    if (token.startsWith('-d') && token.length > 2) return isTempPath(token.slice(2))
  }
  return false
}

function goAllowed(tokens, start) {
  const cache = envAssignments(tokens, start).get('GOCACHE')
  if (cache === undefined || !isTempPath(cache)) return false
  const args = tokens.slice(start + 2)
  if (args.length > 0 && args[0] === 'build') {
    for (let index = 1; index < args.length; index += 1) {
      if (args[index] === '-o') return isTempPath(args[index + 1])
      if (args[index].startsWith('-o') && args[index].length > 2) return isTempPath(args[index].slice(2))
    }
    return false
  }
  return true
}

function cargoAllowed(tokens, start) {
  const target = envAssignments(tokens, start).get('CARGO_TARGET_DIR')
  return target !== undefined && isTempPath(target)
}

function sortAllowed(tokens, start) {
  const args = tokens.slice(start + 1)
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (token === '-o' || token === '--output') return isTempPath(args[index + 1])
    if (token.startsWith('--output=')) return isTempPath(token.slice('--output='.length))
  }
  return true
}

/**
 * Command-specific write-target checks. Returns undefined for commands this
 * table does not own (falling through to the prefix table), otherwise the
 * definitive verdict.
 */
function specialAllowed(part) {
  const tokens = shellTokens(part)
  if (tokens.length === 0) return false
  let start = 0
  while (start < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[start])) start += 1
  const name = tokens[start]
  if (name === undefined) return false
  if (name === 'cp' || name === 'mv') return cpMvAllowed(tokens, start)
  if (name === 'curl') return curlAllowed(tokens, start)
  if (name === 'wget') return wgetAllowed(tokens, start)
  if (name === 'git' && tokens[start + 1] === 'clone') return gitCloneAllowed(tokens, start)
  if ((name === 'pip' || name === 'pip3') && tokens[start + 1] === 'download') return pipDownloadAllowed(tokens, start)
  if (name === 'npm' && tokens[start + 1] === 'pack') return npmPackAllowed(tokens, start)
  if (name === 'javac') return javacAllowed(tokens, start)
  if (name === 'go' && (tokens[start + 1] === 'run' || tokens[start + 1] === 'build')) return goAllowed(tokens, start)
  if (name === 'cargo' && (tokens[start + 1] === 'run' || tokens[start + 1] === 'build')) return cargoAllowed(tokens, start)
  if (name === 'make') return false
  if (name === 'find') return !tokens.some((token) => ['-delete', '-exec', '-execdir', '-ok', '-okdir'].includes(token))
  if (name === 'sort') return sortAllowed(tokens, start)
  if (name === 'awk' || name === 'gawk' || name === 'mawk') {
    return !/\bsystem\s*\(/u.test(part) && !/\bgetline\b/u.test(part)
  }
  if (name === 'yq') return !tokens.some((token) => token === '-i' || token === '--inplace' || token.startsWith('--inplace='))
  return undefined
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
  const special = specialAllowed(part)
  if (special !== undefined) return special
  for (const allowed of ALLOWED_PREFIXES) {
    if (part === allowed || part.startsWith(allowed)) return true
  }
  return false
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
      const target = requested === 'toggle' ? (presets.current(session) === planPreset ? buildPreset : planPreset) : requested
      if (target !== planPreset && target !== buildPreset) {
        return { kind: 'error', text: `Unknown mode "${requested}". Use /mode ${planPreset} or /mode ${buildPreset}.` }
      }
      presets.set(session, target)
      return { kind: 'success', text: target === planPreset ? 'OC Plan' : 'OC Build' }
    },
  })

  // The current slot is materialized only when a request is assembled (i.e.
  // when the user actually sends a message). Repeated Tab switches therefore
  // leave no model-visible trace: only the value at send time enters history.
  ctx.inject(['systemPrompt', 'permissionPresets'], (scope) => scope.effect(() => scope.systemPrompt.context({
    name: 'opencode-mode:mode',
    order: scope.systemPrompt.getContextOrder('SANDBOX_POLICY') + 1,
    text: (context) => {
      const session = context.agent?.session
      if (session === undefined) return ''
      const current = scope.get('permissionPresets')?.current(session)
      if (current === planPreset) {
        return 'Current opencode-style mode: OC Plan — read-only planning. Formal-directory writes and high-risk commands are denied by the runtime guard; switch to OC Build (/mode oc-build or Tab) when execution is needed.'
      }
      if (current === buildPreset) {
        return 'Current opencode-style mode: OC Build — execution allowed (full access).'
      }
      return ''
    },
  }), 'opencode-plan-build: mode runtime context'))

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

  // `/rename` — rename through a question form (an input dialog, not the
  // prompt box): bare `/rename` opens the form, and a typed title skips it.
  ctx.commands.register({
    definitionId: 'opencode-plan-build:rename',
    name: 'rename',
    description: 'Rename the current session (opens an input dialog; pins the title)',
    handler: async (invocation) => {
      const titles = ctx.get('sessionTitle')
      if (titles === undefined) return { kind: 'error', text: 'the session-title service is unavailable in this composition' }
      let title = invocation.rawInput.trim()
      if (title === '') {
        const interaction = ctx.get('userQuestions')
        if (interaction === undefined) return { kind: 'error', text: 'No question channel is available; use /rename <title> instead.' }
        let answer
        try {
          answer = await interaction.ask({
            questions: [{
              id: 'rename',
              header: 'Rename session',
              question: 'New session name (leave empty to cancel)',
              detail: 'The title is pinned once accepted; automatic titles will not overwrite it.',
              options: [{ label: 'Cancel', description: 'Keep the current title' }],
            }],
            agent: invocation.agent,
          })
        } catch {
          return { kind: 'success', text: 'Rename cancelled.' }
        }
        const item = answer.answers.find((entry) => entry.id === 'rename')
        title = (item?.custom ?? '').trim()
        if (title === '') return { kind: 'success', text: 'Rename cancelled.' }
      }
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

  // `/sessions` — host row backing the client popup picker; the client
  // decorates it with the session list and switches via uiWorkspace.
  ctx.commands.register({
    definitionId: 'opencode-plan-build:sessions',
    name: 'sessions',
    description: 'Switch to another session (popup picker)',
    handler: () => ({ kind: 'success', text: 'Pick a session from the popup; the left sidebar lists the same set.' }),
  })

  // `/models` — host row backing the client popup picker (real model list).
  ctx.commands.register({
    definitionId: 'opencode-plan-build:models',
    name: 'models',
    description: 'Switch the model (popup picker)',
    handler: () => ({ kind: 'success', text: 'Pick a model from the popup (the same catalog /model uses).' }),
  })

  // `/effort` — host row backing the client popup picker over reasoning levels.
  ctx.commands.register({
    definitionId: 'opencode-plan-build:effort',
    name: 'effort',
    description: 'Switch the reasoning effort of the current model (popup picker)',
    handler: () => ({ kind: 'success', text: 'Pick an effort level from the popup (off / low / high / max, as the current model advertises).' }),
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
