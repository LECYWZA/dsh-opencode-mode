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
        // row opens that session (same set the left sidebar lists).
        ctx.inject(['commandUi'], (scope) => scope.effect(() => scope.commandUi.decorate({
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
        }), 'opencode-plan-build: /sessions popup'))

        // /seesession: decorate with a picker over the other sessions; a pick
        // runs the host command, which streams that transcript into the
        // conversation as a command result.
        ctx.inject(['commandUi'], (scope) => scope.effect(() => scope.commandUi.decorate({
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
        }), 'opencode-plan-build: /seesession popup'))
      },
    }
  },
})
