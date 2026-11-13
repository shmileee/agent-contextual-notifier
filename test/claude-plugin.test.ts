import { describe, expect, test } from "bun:test"
import { join } from "node:path"

import { parseClaudeHookEvent } from "../src/claude/events"

type HookGroup = { readonly hooks: readonly { readonly command: string }[] }

const root = join(import.meta.dir, "..")
const readJson = (...path: string[]): Promise<unknown> => Bun.file(join(root, ...path)).json()

const packageManifest = (await readJson("package.json")) as { name: string; version: string }
const pluginManifest = (await readJson(".claude-plugin", "plugin.json")) as {
  name: string
  version: string
}
const marketplace = (await readJson(".claude-plugin", "marketplace.json")) as {
  plugins: readonly { name: string; source: string }[]
}
const hooks = (await readJson("hooks", "hooks.json")) as {
  hooks: Readonly<Record<string, readonly HookGroup[]>>
}

describe("Claude Code plugin", () => {
  test("is released under the package name and version", () => {
    // Then
    expect(pluginManifest.name).toBe(packageManifest.name)
    expect(pluginManifest.version).toBe(packageManifest.version)
    expect(marketplace.plugins).toEqual([expect.objectContaining({ name: packageManifest.name })])
  })

  test("runs the hook script that ships in the repository", async () => {
    // Given
    const commands = Object.values(hooks.hooks).flatMap((groups) =>
      groups.flatMap((group) => group.hooks.map((hook) => hook.command)),
    )

    // biome-ignore lint/suspicious/noTemplateCurlyInString: Claude Code expands this placeholder
    const expected = 'bun "${CLAUDE_PLUGIN_ROOT}/src/claude/hook.ts"'

    // Then
    expect(new Set(commands)).toEqual(new Set([expected]))
    expect(await Bun.file(join(root, "src", "claude", "hook.ts")).exists()).toBe(true)
  })

  test.each(Object.keys(hooks.hooks))("registers %s, which the hook understands", (eventName) => {
    // Given
    const payload = {
      hook_event_name: eventName,
      notification_type: "permission_prompt",
      session_id: "session-1",
    }

    // Then
    expect(parseClaudeHookEvent(payload)).toBeDefined()
  })
})
