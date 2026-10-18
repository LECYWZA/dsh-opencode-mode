window.__ModuleLoader__.load({
  id: 'dsh-opencode-mode',
  factory(require) {
    return {
      inject: ['slots', 'sessions', 'remote', 'shortcuts'],
      apply(ctx) {
        /**
         * Tab toggles OC Plan / OC Build for the session in view.
         *
         * Registered as a capture-phase document listener rather than through
         * ctx.shortcuts: on Web, shortcut commands dispatch AFTER local
         * handlers, and the composer consumes Tab for focus/insert, so a
         * ctx.shortcuts binding on Tab never fires. Capture runs before
         * React's onKeyDown, which is what makes an opencode-style Tab cycle
         * possible. Modifier combinations (Ctrl+Tab / Alt+Tab) are left alone.
         */
        ctx.effect(() => {
          const onKeyDown = (event) => {
            if (event.key !== 'Tab') return
            if (event.ctrlKey || event.metaKey || event.altKey) return
            if (event.repeat || event.isComposing) return
            const byId = ctx.sessions.list.getSnapshot().byId
            const current = Object.values(byId).find((summary) => (summary?.retainedBy?.mainView ?? 0) > 0)
            if (current === undefined) return
            event.preventDefault()
            event.stopPropagation()
            ctx.remote.commands.execute(current.id, '/mode').catch(() => {})
          }
          document.addEventListener('keydown', onKeyDown, true)
          return () => document.removeEventListener('keydown', onKeyDown, true)
        }, 'opencode-plan-build: tab capture listener')

        // Shortcut-panel discoverability: a non-conflicting registration that
        // documents the same action and stays rebindable for users who want a
        // chord instead of bare Tab.
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
              const byId = ctx.sessions.list.getSnapshot().byId
              const current = Object.values(byId).find((summary) => (summary?.retainedBy?.mainView ?? 0) > 0)
              if (current === undefined) return
              ctx.remote.commands.execute(current.id, '/mode').catch(() => {})
            },
          }),
        }), 'opencode-plan-build: chord shortcut')
      },
    }
  },
})
