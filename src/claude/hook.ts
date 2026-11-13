import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { createSinks, defaultSound, runCommand } from "../core/sinks"
import { createClaudeHookHandler } from "./handler"
import { createFileStateStore } from "./state"

function setting(name: string): string | undefined {
  const value = Bun.env[name]?.trim()
  return value ? value : undefined
}

// A hook must never disturb the session: stay silent and exit 0 whatever happens.
try {
  const payload: unknown = JSON.parse(await Bun.stdin.text())
  const dataDirectory = setting("CLAUDE_PLUGIN_DATA") ?? join(tmpdir(), "agent-contextual-notifier")
  const handle = createClaudeHookHandler({
    ...createSinks({
      run: runCommand,
      sound:
        setting("CLAUDE_PLUGIN_OPTION_SOUND") ?? setting("AGENT_NOTIFIER_SOUND") ?? defaultSound,
      tmuxHelper: fileURLToPath(new URL("../../scripts/agent-notifier-tmux", import.meta.url)),
    }),
    now: Date.now,
    projectDirectory: setting("CLAUDE_PROJECT_DIR"),
    store: createFileStateStore(join(dataDirectory, "sessions")),
  })
  await handle(payload)
} catch {
  // Nothing useful can be reported from a hook.
}
