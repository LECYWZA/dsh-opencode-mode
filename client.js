window.__ModuleLoader__.load({
  id: 'dsh-opencode-mode',
  factory(require) {
    return {
      inject: ['sessions', 'remote'],
      apply(ctx) {
        /** Resolve the session the user is currently looking at. */
        const currentSessionId = () => {
          const byId = ctx.sessions.list.getSnapshot().byId
          const current = Object.values(byId).find((summary) => (summary?.retainedBy?.mainView ?? 0) > 0)
          return current?.id
        }

        /** Execute one slash command against a session's live binding. */
        const execute = (sessionId, line) => {
          const live = ctx.sessions.binding(sessionId)?.session
          if (live === undefined) return undefined
          return live.command(line).catch(() => undefined)
        }

        /**
         * Canonical dsh-session URI encoding, mirroring
         * `encodeSessionReferenceUri` from @deepseek-ai/dsh-session-reference:
         * base64url(JSON.stringify(sessionId)) without padding. The payload is
         * NOT the bare id; a bare id decodes to bytes that fail JSON.parse and
         * the host rejects the whole turn.
         */
        const encodeSessionReference = (sessionId) => {
          const bytes = new TextEncoder().encode(JSON.stringify(sessionId))
          let binary = ''
          for (const byte of bytes) binary += String.fromCharCode(byte)
          return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '')
        }

        /** Escape a display label for the Markdown mention form `@[label](uri)`. */
        const escapeReferenceLabel = (label) => String(label).replace(/[\\\]]/gu, (match) => `\\${match}`)

        /** Render one canonical `@[label](dsh-session:...)` mention with a trailing space. */
        const formatSessionReference = (sessionId, label) => `@[${escapeReferenceLabel(label ?? sessionId)}](dsh-session:${encodeSessionReference(sessionId)}) `

        /** Inject the rename dialog stylesheet once. */
        const ensureRenameDialogStyle = () => {
          if (document.querySelector('style[data-opencode-mode-rename]') !== null) return
          const style = document.createElement('style')
          style.dataset.opencodeModeRename = ''
          style.textContent = 'dialog.opencode-mode-rename{border:none;padding:0;background:transparent}dialog.opencode-mode-rename::backdrop{background:rgba(0,0,0,.45)}'
          document.head.append(style)
        }

        /**
         * Open an independent rename dialog (a real modal, not the composer).
         * Submitting calls the official session-controller rename, so no command
         * lifecycle node and no model-visible message is produced.
         */
        const openRenameDialog = (sessionId) => {
          const live = ctx.sessions.binding(sessionId)?.session
          if (live === undefined) return
          ensureRenameDialogStyle()
          const summary = ctx.sessions.list.getSnapshot().byId[sessionId]
          const currentTitle = summary?.title ?? summary?.displayTitle ?? ''

          const overlay = document.createElement('dialog')
          overlay.className = 'opencode-mode-rename'

          const panel = document.createElement('div')
          panel.style.cssText = 'min-width:360px;max-width:min(520px,90vw);background:var(--dsw-alias-bg-module-platform,#1f2023);color:var(--dsw-alias-label-primary,#e6e6e6);border:1px solid var(--dsw-alias-border-l2,#3a3b3f);border-radius:12px;padding:20px;box-shadow:0 18px 50px rgba(0,0,0,.5);font:14px/1.5 system-ui,sans-serif'

          const heading = document.createElement('div')
          heading.textContent = '重命名会话'
          heading.style.cssText = 'font-size:16px;font-weight:600;margin-bottom:4px'

          const hint = document.createElement('div')
          hint.textContent = '标题会被固定，不再被自动标题覆盖。'
          hint.style.cssText = 'font-size:12px;color:var(--dsw-alias-label-tertiary,#9a9a9a);margin-bottom:12px'

          const input = document.createElement('input')
          input.type = 'text'
          input.value = currentTitle
          input.placeholder = '新的会话名称'
          input.style.cssText = 'width:100%;box-sizing:border-box;background:var(--dsw-alias-bg-module-platform-weak,#17181a);color:var(--dsw-alias-label-primary,#e6e6e6);border:1px solid var(--dsw-alias-border-l2,#3a3b3f);border-radius:8px;padding:9px 12px;font:inherit;outline:none;margin-bottom:6px'

          const errorBox = document.createElement('div')
          errorBox.style.cssText = 'min-height:18px;font-size:12px;color:var(--dsw-alias-state-error-primary,#ff6b6b);margin-bottom:10px'

          const actions = document.createElement('div')
          actions.style.cssText = 'display:flex;justify-content:flex-end;gap:8px'

          const cancel = document.createElement('button')
          cancel.type = 'button'
          cancel.textContent = '取消'
          cancel.style.cssText = 'background:transparent;color:var(--dsw-alias-label-secondary,#c9c9c9);border:1px solid var(--dsw-alias-border-l2,#3a3b3f);border-radius:8px;padding:8px 16px;cursor:pointer;font:inherit'

          const confirm = document.createElement('button')
          confirm.type = 'button'
          confirm.textContent = '确定'
          confirm.style.cssText = 'background:var(--dsw-alias-state-business-primary,#4c8dff);color:#fff;border:none;border-radius:8px;padding:8px 16px;cursor:pointer;font:inherit'

          const close = () => overlay.close()
          cancel.addEventListener('click', close)
          overlay.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              close()
            }
          })
          confirm.addEventListener('click', () => {
            const title = input.value.trim()
            if (title === '') {
              errorBox.textContent = '标题不能为空。'
              input.focus()
              return
            }
            confirm.disabled = true
            cancel.disabled = true
            errorBox.textContent = ''
            Promise.resolve(live.rename(title)).then((result) => {
              if (result !== undefined && result !== null && result.ok === false) {
                throw new Error(result.error?.message ?? 'rename failed')
              }
              close()
            }).catch((error) => {
              errorBox.textContent = error instanceof Error ? error.message : String(error)
              confirm.disabled = false
              cancel.disabled = false
              input.focus()
            })
          })

          actions.append(cancel, confirm)
          panel.append(heading, hint, input, errorBox, actions)
          overlay.append(panel)
          overlay.addEventListener('close', () => overlay.remove())
          document.body.append(overlay)
          overlay.showModal()
          input.focus()
          input.select()
        }

        /**
         * Tab toggles OC Plan / OC Build for the session in view.
         *
         * A capture-phase document listener rather than ctx.shortcuts: on Web,
         * shortcut commands dispatch AFTER local handlers, and the composer
         * consumes Tab for focus/insert, so a ctx.shortcuts binding on Tab
         * never fires. Capture runs before React's onKeyDown, which is what
         * makes an opencode-style Tab cycle possible. Modifier combinations
         * are left alone.
         */
        ctx.effect(() => {
          const onKeyDown = (event) => {
            if (event.key !== 'Tab') return
            if (event.ctrlKey || event.metaKey || event.altKey) return
            if (event.repeat || event.isComposing) return
            const sessionId = currentSessionId()
            if (sessionId === undefined) return
            event.preventDefault()
            event.stopPropagation()
            execute(sessionId, '/mode toggle')
          }
          document.addEventListener('keydown', onKeyDown, true)
          return () => document.removeEventListener('keydown', onKeyDown, true)
        }, 'opencode-plan-build: tab capture listener')

        // Shortcut-panel discoverability: a rebindable chord documenting the
        // same action for users who prefer a combination. Registered lazily so
        // the shortcuts service never blocks this plugin's activation.
        ctx.inject(['shortcuts'], (scope) => scope.effect(() => scope.shortcuts.register({
          id: 'opencode-plan-build.toggle',
          label: () => 'OC Plan / OC Build',
          aliases: ['mode', 'oc-mode', 'plan', 'build'],
          defaults: {
            'web:linux': { code: 'KeyM', modifiers: ['primary', 'alt'] },
            'web:macos': { code: 'KeyM', modifiers: ['primary', 'alt'] },
            'web:windows': { code: 'KeyM', modifiers: ['primary', 'alt'] },
          },
          regions: ['page', 'editable'],
          modals: [],
          resolve: () => ({
            status: 'handled',
            run: () => {
              const sessionId = currentSessionId()
              if (sessionId !== undefined) execute(sessionId, '/mode toggle')
            },
          }),
        }), 'opencode-plan-build: chord shortcut'))

        // /sessions: decorate the host row with a session picker. Selecting a
        // row opens that session through the workspace navigation service (the
        // same path a sidebar click takes). uiWorkspace must be injected: without
        // it ctx.uiWorkspace is undefined and the pick silently does nothing.
        ctx.inject(['commandUi', 'uiWorkspace'], (scope) => scope.effect(() => scope.commandUi.decorate({
          name: 'sessions',
          available: () => true,
          ui: {
            kind: 'popupSelect',
            options: async () => {
              const byId = ctx.sessions.list.getSnapshot().byId
              const current = currentSessionId()
              return Object.values(byId).map((summary) => ({
                id: summary.id,
                label: summary.title ?? summary.id,
                ...summary.workingDirectory === undefined ? {} : { detail: summary.workingDirectory },
                ...summary.id === current ? { active: true } : {},
              }))
            },
            onSelect: (option) => {
              scope.uiWorkspace.openSession(option.id)
            },
          },
        }), 'opencode-plan-build: /sessions popup'))

        // /seesession: a client contribution (NOT a host command row). Host
        // command rows that carry an input hint are only offered at the start
        // of the composer; a contribution has no hint, so "/see" opens the
        // picker anywhere in the draft. A pick inserts a canonical reference
        // into the composer (never sends).
        ctx.inject(['commandUi', 'sessions', 'conversation'], (scope) => scope.effect(() => scope.commandUi.register({
          name: 'seesession',
          description: () => '选择另一个会话并插入引用（只插入，不发送）',
          available: () => true,
          ui: {
            kind: 'popupSelect',
            options: async () => {
              const byId = ctx.sessions.list.getSnapshot().byId
              const current = currentSessionId()
              return Object.values(byId)
                .filter((summary) => summary.id !== current)
                .map((summary) => ({
                  id: summary.id,
                  label: summary.title ?? summary.id,
                  ...summary.workingDirectory === undefined ? {} : { detail: summary.workingDirectory },
                }))
            },
            onSelect: (option, session) => {
              // Insert a session reference into the composer instead of sending:
              // the user appends their own prompt and sends once, and the
              // native session-reference service captures the other session's
              // context at prompt admission.
              //
              // Prefer the composer shell's setDraft: it replaces the whole
              // draft (removing the trailing "/see" token) and keeps Lexical's
              // revision consistent, so the command layer's later consume is a
              // harmless no-op. Fall back to a DOM insert when the shell is
              // not reachable.
              const reference = formatSessionReference(option.id, option.label)
              try {
                const actx = scope.sessions.scope(session.sessionId)
                const shell = scope.conversation.input.for(actx)
                const current = shell.projection.clipboardText ?? ''
                const cleaned = current.replace(/(?:^|\s)\/[A-Za-z][\w-]*\s*$/u, ' ').trimEnd()
                shell.setDraft(cleaned === '' ? reference : `${cleaned} ${reference}`)
                return
              } catch {
                // fall through to the DOM insert
              }
              const composer = document.querySelector('[contenteditable="true"]')
              if (composer === null) return
              composer.focus()
              document.execCommand('insertText', false, reference)
            },
          },
        }), 'opencode-plan-build: /seesession popup'))

        // /rename: an independent input dialog (a real modal, not the prompt
        // box). Bare /rename opens it; /rename <title> keeps the host command.
        ctx.inject(['commandUi'], (scope) => scope.effect(() => scope.commandUi.decorate({
          name: 'rename',
          available: () => true,
          ui: {
            kind: 'action',
            run: (session) => {
              if (session?.sessionId !== undefined) openRenameDialog(session.sessionId)
            },
          },
        }), 'opencode-plan-build: /rename dialog'))

        // /models and /effort: real popup pickers over the Host model catalog.
        ctx.inject(['commandUi', 'sessions', 'remote'], (scope) => {
          const loadCatalog = () => scope.remote.session.modelCatalog()
            .then((response) => (response.ok ? response.value : undefined))
            .catch(() => undefined)
          const currentSelection = (sessionId) => {
            const binding = scope.sessions.binding(sessionId)
            return binding?.session?.projections?.faceOf?.('modelSelection')?.getSnapshot?.()
          }

          // /models: every provider-grouped model in the catalog.
          scope.effect(() => scope.commandUi.decorate({
            name: 'models',
            available: () => true,
            ui: {
              kind: 'popupSelect',
              options: async () => {
                const value = await loadCatalog()
                if (value === undefined) return []
                const rows = []
                for (const group of value.groups ?? []) {
                  for (const model of group.models ?? []) {
                    rows.push({
                      id: `${group.id}/${model.id}`,
                      label: model.name ?? model.id,
                      detail: group.name ?? group.id,
                    })
                  }
                }
                return rows
              },
              onSelect: (option, session) => {
                const slash = option.id.indexOf('/')
                const provider = option.id.slice(0, slash)
                const model = option.id.slice(slash + 1)
                return scope.sessions.selectModel({ sessionId: session.sessionId, provider, model }).catch(() => undefined)
              },
            },
          }), 'opencode-plan-build: /models popup')

          // /effort: reasoning levels advertised by the current model.
          scope.effect(() => scope.commandUi.decorate({
            name: 'effort',
            available: () => true,
            ui: {
              kind: 'popupSelect',
              options: async (session) => {
                const value = await loadCatalog()
                if (value === undefined) return []
                const current = currentSelection(session.sessionId)
                if (current === undefined || current === null) return []
                const group = (value.groups ?? []).find((candidate) => candidate.id === current.provider)
                const entry = (group?.models ?? []).find((candidate) => candidate.id === current.model)
                const efforts = entry?.reasoning?.efforts ?? []
                return efforts.map((level) => ({
                  id: level.id,
                  label: level.name ?? level.id,
                  active: current.reasoningEffort === level.id,
                }))
              },
              onSelect: (option, session) => {
                const current = currentSelection(session.sessionId)
                if (current === undefined || current === null) return undefined
                return scope.sessions.selectModel({
                  sessionId: session.sessionId,
                  provider: current.provider,
                  model: current.model,
                  reasoningEffort: option.id,
                }).catch(() => undefined)
              },
            },
          }), 'opencode-plan-build: /effort popup')
        })
      },
    }
  },
})
