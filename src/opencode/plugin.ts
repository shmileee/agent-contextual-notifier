import { basename, join } from "node:path"

import type { Plugin } from "@opencode-ai/plugin"
import { z } from "zod"

import { type CommandRunner, createSinks, defaultSound } from "../core/sinks"
import { createNotifierEventHandler, type MessageSnapshot } from "./runtime"

const sessionSchema = z.object({
  parentID: z.string().optional(),
  title: z.string(),
})
const todoSchema = z.array(z.object({ status: z.string() }))
const messageHistorySchema = z.array(
  z.object({
    info: z.object({ role: z.enum(["assistant", "user"]) }),
    parts: z.array(z.object({ type: z.string(), text: z.string().optional() }).loose()),
  }),
)
const continuationSchema = z.object({
  sources: z.record(z.string(), z.object({ state: z.string() }).loose()),
})
const optionsSchema = z.object({
  sound: z.string().trim().min(1).default(defaultSound),
})

function latestText(
  history: z.infer<typeof messageHistorySchema>,
  role: "assistant" | "user",
): string | undefined {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index]
    if (!entry || entry.info.role !== role) continue
    const text = entry.parts
      .filter((part) => part.type === "text" && part.text)
      .map((part) => part.text)
      .join("\n")
      .trim()
    if (text) return text
  }
  return undefined
}

function parseMessages(value: unknown): MessageSnapshot | undefined {
  const parsed = messageHistorySchema.safeParse(value)
  if (!parsed.success) return undefined
  return {
    lastAssistantText: latestText(parsed.data, "assistant"),
    lastUserText: latestText(parsed.data, "user"),
  }
}

export type OpenCodePluginDependencies = {
  readonly run: CommandRunner
  readonly tmuxHelper: string
}

export function createOpenCodePlugin(dependencies: OpenCodePluginDependencies): Plugin {
  return async ({ client, directory }, rawOptions) => {
    const options = optionsSchema.parse(rawOptions ?? {})
    const continuationDirectory = join(directory, ".omo", "run-continuation")
    const handler = createNotifierEventHandler({
      ...createSinks({ ...dependencies, sound: options.sound }),
      projectName: basename(directory) || "project",
      readSession: async (sessionID) => {
        const response = await client.session.get({
          path: { id: sessionID },
          query: { directory },
        })
        const parsed = sessionSchema.safeParse(response.data)
        return parsed.success ? parsed.data : undefined
      },
      readTodos: async (sessionID) => {
        const response = await client.session.todo({
          path: { id: sessionID },
          query: { directory },
        })
        const parsed = todoSchema.safeParse(response.data)
        return parsed.success ? parsed.data : undefined
      },
      readMessages: async (sessionID) => {
        const response = await client.session.messages({
          path: { id: sessionID },
          query: { directory, limit: 20 },
        })
        return parseMessages(response.data)
      },
      readBackground: async (sessionID) => {
        const stateFile = Bun.file(join(continuationDirectory, `${sessionID}.json`))
        if (!(await stateFile.exists())) return "idle"
        const parsed = continuationSchema.safeParse(JSON.parse(await stateFile.text()))
        if (!parsed.success) return "unknown"
        return Object.values(parsed.data.sources).some((source) => source.state === "active")
          ? "active"
          : "idle"
      },
    })

    return {
      event: async ({ event }) => handler(event),
    }
  }
}
