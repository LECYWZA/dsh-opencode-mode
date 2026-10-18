/**
 * opencode-plan-build — opencode 式 plan/build 挡位 for dsh.
 *
 * One host plugin, three duties:
 *   1. `/mode oc-plan|oc-build` switches the session's permission slot and
 *      injects a mode notice as a trailing user message (prefix cache stays
 *      reusable; the system prompt is never rewritten).
 *   2. `ctx.tools.guard()` enforces the OC Plan contract at dispatch time:
 *      formal-directory writes and high-risk commands are denied with a reason
 *      the model can act on ("switch to OC Build"), and sandbox escalation is
 *      refused so no approval popup appears. Tool schemas never change, so the
 *      KV prefix stays byte-identical.
 *   3. A cheap one-shot exercise path: /tmp (and the platform temp dir) are
 *      writable for scratch work — compile-and-run, downloads, clones — while
 *      nothing outside them is touched.
 *
 * @module dsh-opencode-mode
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'

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
  // filesystem inspection
  'ls', 'cat', 'head', 'tail', 'wc', 'stat', 'file', 'du', 'df', 'find', 'grep', 'rg',
  'sed -n', 'awk', 'tree', 'readlink', 'realpath', 'basename', 'dirname', 'sort', 'uniq',
  'cut', 'tr', 'jq', 'yq', 'md5sum', 'sha256sum', 'diff', 'cmp', 'lsblk', 'lscpu',
  // git read-only
  'git status', 'git log', 'git diff', 'git show', 'git branch', 'git rev-parse',
  'git remote', 'git ls-files', 'git blame', 'git stash list', 'git describe',
  // process / system inspection
  'ps', 'top', 'htop', 'uptime', 'free', 'uname', 'hostname', 'date', 'whoami', 'id',
  'env', 'pwd', 'which', 'type', 'ss', 'netstat', 'ip a', 'ip addr', 'nvidia-smi',
  'journalctl', 'systemctl status', 'systemctl list-units', 'dmesg',
  // containers read-only
  'docker ps', 'docker images', 'docker logs', 'docker inspect', 'docker stats',
  'docker version', 'docker info',
  // network read-only
  'curl', 'wget', 'ping', 'dig', 'nslookup', 'traceroute', 'ssh',
  // scratch-only writes (explicitly /tmp or the platform temp dir)
  'mkdir -p /tmp', 'mkdir -p "$TMPDIR', 'touch /tmp', 'mktemp', 'cat > /tmp',
  'cat >> /tmp', 'echo > /tmp', 'echo >> /tmp', 'tee /tmp', 'cp ', 'mv ',
  // one-shot exercise: compile & run without touching external state
  'javac', 'java ', 'python3 -c', 'python -c', 'node -e', 'node -v', 'python3 -V',
  'go run', 'go build', 'cargo run', 'cargo build', 'rustc', 'gcc ', 'g++ ', 'make',
  // download / clone into scratch (the guard checks the destination)
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

function isTempPath(value) {
  if (typeof value !== 'string' || value === '') return false
  const p = value.startsWith('~') || value.startsWith('$HOME')
    ? value
    : value
  for (const root of TEMP_ROOTS) {
    if (p === root || p.startsWith(`${root}/`)) return true
  }
  const tmp = process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP
  if (typeof tmp === 'string' && tmp !== '') {
    const root = tmp.replace(/[\\/]+$/, '')
    if (p === root || p.startsWith(`${root}/`) || p.startsWith(`${root}\\`)) return true
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
    // Pipes: each side must pass on its own.
    const parts = segment.split('|').map((p) => p.trim()).filter((p) => p !== '')
    for (const part of parts) {
      if (!singleAllowed(part)) return false
    }
  }
  return true
}

function singleAllowed(part) {
  for (const denied of DENIED_PREFIXES) {
    if (part === denied || part.startsWith(denied)) return false
  }
  // Redirections must target scratch space only.
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

export function apply(ctx, config = {}) {
  const planPreset = typeof config.planPreset === 'string' ? config.planPreset : PLAN
  const buildPreset = typeof config.buildPreset === 'string' ? config.buildPreset : BUILD

  // `/mode [oc-plan|oc-build]`
  ctx.commands.register({
    definitionId: 'opencode-plan-build',
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

  // Runtime guard: OC Plan denies formal-directory writes, high-risk commands,
  // and sandbox escalation. Registered globally; it reads each agent's own slot.
  ctx.tools.guard((execution) => {
    const agent = execution.agent
    if (agent === undefined) return
    const preset = ctx.get('permissionPresets')?.current(agent.session)
    if (preset !== planPreset) return

    if (WRITE_TOOLS.has(execution.name)) {
      const args = execution.arguments ?? {}
      const path = args.path ?? args.file_path ?? args.filePath
      if (typeof path !== 'string' || !isTempPath(path)) {
        return `OC Plan is a read-only planning slot: writing to ${typeof path === 'string' ? path : 'that path'} is denied. Switch to OC Build (/mode ${buildPreset}) to make changes, or use the temporary directory for scratch work.`
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
      return
    }
  })
}
