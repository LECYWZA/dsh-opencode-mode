window.__ModuleLoader__.load({
  id: 'dsh-opencode-mode',
  factory(require) {
    return {
      inject: ['slots', 'sessions', 'remote', 'shortcuts', 'commandUi', 'uiWorkspace'],
      apply(ctx) {
        /** Resolve the session the user is currently looking at. */
        const currentSessionId = () => {
          const byId = ctx.sessions.list.getSnapshot().byId
          const current = Object.values(byId).find((summary) => (summary?.retainedBy?.mainView ?? 0) > 0)
          return current?.id
        }

        /** Split a '/name args' line into its pieces. */
        const parseLine = (line) => {
          const trimmed = line.trim().replace(/^\//u, '')
          const space = trimmed.indexOf(' ')
          return space === -1
            ? { name: trimmed, args: '' }
            : { name: trimmed.slice(0, space), args: trimmed.slice(space + 1) }
        }

        /** Execute one slash command against a session (empty args execute bare). */
        const execute = (sessionId, line) => {
          const { name, args } = parseLine(line)
          const full = args === '' ? `/${name}` : `/${name} ${args}`
          return ctx.remote.commands.execute(sessionId, full).catch(() => undefined)
        }

        /**
         * Tab toggles OC Plan / OC Build for the session in view.
         *
         * Registered as a capture-phase document listener rather than through
         * ctx.shortcuts: on Web, shortcut commands dispatch AFTER local
         * handlers, and the composer consumes Tab for focus/insert, so a
         * ctx.shortcuts binding on Tab never fires. Capture runs before
         * React's onKeyDown, which is what makes an opencode-style Tab cycle
         * possible. Modifier combinations are left alone.
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
            execute(sessionId, '/mode')
          }
          document.addEventListener('keydown', onKeyDown, true)
          return () => document.removeEventListener('keydown', onKeyDown, true)
        }, 'opencode-plan-build: tab capture listener')

        // Shortcut-panel discoverability: a non-conflicting chord that documents
        // the same action and stays rebindable.
        ctx.effect(() => ctx.shortcuts.register({
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
              if (sessionId !== undefined) execute(sessionId, '/mode')
            },
          }),
        }), 'opencode-plan-build: chord shortcut')

        // /sessions: decorate the host row with a session picker. Selecting a
        // row opens that session (same set the left sidebar lists).
        ctx.effect(() => ctx.commandUi.decorate({
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
              ctx.uiWorkspace.openSession(option.id)
            },
          },
        }), 'opencode-plan-build: /sessions popup')

        // /seesession: decorate with a picker over the other sessions; a pick
        // runs the host command, which streams that transcript into the
        // conversation as a command result.
        ctx.effect(() => ctx.commandUi.decorate({
          name: 'seesession',
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
            onSelect: (option) => {
              const sessionId = currentSessionId()
              if (sessionId !== undefined) execute(sessionId, `/seesession ${option.id}`)
            },
          },
        }), 'opencode-plan-build: /seesession popup')
      },
    }
  },
})
