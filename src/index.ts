import { fileURLToPath } from "node:url"

import type { Plugin } from "@opencode-ai/plugin"

import { runCommand } from "./core/sinks"
import { createOpenCodePlugin } from "./opencode/plugin"

// OpenCode treats every export of a plugin module as a plugin, so this entry exports only one.
export const ContextualNotifier: Plugin = createOpenCodePlugin({
  run: runCommand,
  tmuxHelper: fileURLToPath(new URL("../scripts/agent-notifier-tmux", import.meta.url)),
})
