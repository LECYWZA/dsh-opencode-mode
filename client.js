window.__ModuleLoader__.load({
  id: 'dsh-opencode-mode',
  factory(require) {
    return {
      inject: ['slots', 'sessions', 'remote', 'shortcuts'],
      apply(ctx) {
        // Tab toggles between OC Plan and OC Build for the session the user is
        // looking at. It deliberately takes priority over the browser's focus
        // navigation, matching opencode's Tab agent cycle.
        ctx.effect(() => ctx.shortcuts.register({
          id: 'opencode-plan-build.toggle',
          label: () => 'OC Plan / OC Build',
          aliases: ['mode', 'oc-mode', 'plan', 'build'],
          defaults: {
            'web:linux': { code: 'Tab' },
            'web:macos': { code: 'Tab' },
            'web:windows': { code: 'Tab' },
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
        }), 'opencode-plan-build: tab shortcut')
      },
    }
  },
})
