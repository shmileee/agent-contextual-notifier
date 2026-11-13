import { describe, expect, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { $ } from "bun"

import * as entry from "../src"
import { createOpenCodePlugin } from "../src/opencode/plugin"

const responseHeaders = { "Content-Type": "application/json" } as const
const tmuxHelper = "/plugin/scripts/agent-notifier-tmux"

function createClient(): ReturnType<typeof createOpencodeClient> {
  return createOpencodeClient({
    baseUrl: "http://notifier.test",
    fetch: async (request) => {
      const path = new URL(request.url).pathname
      if (path.endsWith("/todo")) {
        return new Response(JSON.stringify([{ status: "completed" }]), {
          headers: responseHeaders,
        })
      }
      if (path.endsWith("/message")) {
        return new Response(
          JSON.stringify([
            {
              info: { role: "user" },
              parts: [{ type: "text", text: "hi" }],
            },
            {
              info: { role: "assistant" },
              parts: [{ type: "text", text: "Hello" }],
            },
          ]),
          { headers: responseHeaders },
        )
      }
      return new Response(JSON.stringify({ title: "Sound adapter" }), {
        headers: responseHeaders,
      })
    },
  })
}

function createInput(): PluginInput {
  return {
    client: createClient(),
    project: {
      id: "global",
      worktree: "/tmp",
      time: { created: 0 },
    },
    directory: "/tmp/home-assistant",
    worktree: "/tmp/home-assistant",
    experimental_workspace: { register: () => {} },
    serverUrl: new URL("http://notifier.test"),
    $,
  }
}

async function deliverCompletion(
  windowLabel: string,
  options?: Record<string, unknown>,
): Promise<{
  readonly commands: readonly (readonly string[])[]
  readonly notification: readonly string[] | undefined
}> {
  const commands: (readonly string[])[] = []
  const plugin = createOpenCodePlugin({
    run: async (command) => {
      commands.push(command)
      return command[1] === "window_label" ? windowLabel : ""
    },
    tmuxHelper,
  })
  const hooks = await plugin(createInput(), options)
  await hooks.event?.({
    event: { type: "session.idle", properties: { sessionID: "main" } },
  })
  return { commands, notification: commands.find((command) => command[0] === "osascript") }
}

describe("OpenCode plugin adapter", () => {
  test("marks the window and sends one pane-labeled notification with the default sound", async () => {
    // Given
    const windowLabel = "5: ha\n"

    // When
    const { commands, notification } = await deliverCompletion(windowLabel)

    // Then
    expect(commands).toContainEqual([tmuxHelper, "complete"])
    expect(commands.filter((command) => command[0] === "osascript")).toHaveLength(1)
    expect(notification?.slice(-4)).toEqual([
      "Ready for input You: hi Agent: Hello",
      "OpenCode · home-assistant",
      "5: ha · Sound adapter",
      "Submarine",
    ])
  })

  test("preserves the session subtitle outside tmux", async () => {
    // Given
    const windowLabel = ""

    // When
    const { notification } = await deliverCompletion(windowLabel)

    // Then
    expect(notification?.at(-2)).toBe("Sound adapter")
  })

  test("uses a configured notification sound", async () => {
    // Given
    const options = { sound: "Glass" }

    // When
    const { notification } = await deliverCompletion("5: ha", options)

    // Then
    expect(notification?.at(-1)).toBe("Glass")
  })
})

describe("package entry", () => {
  test("exports only the OpenCode plugin, because OpenCode loads every export as a plugin", () => {
    // Given
    const exported = Object.keys(entry)

    // Then
    expect(exported).toEqual(["ContextualNotifier"])
    expect(entry.ContextualNotifier).toBeFunction()
  })
})
