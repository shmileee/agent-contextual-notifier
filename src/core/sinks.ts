import type { MarkerEvent, NotificationContent } from "./domain"

export type CommandRunner = (command: readonly string[]) => Promise<string>

export type NotifierSinks = {
  readonly mark: (event: MarkerEvent) => Promise<void>
  readonly notify: (content: NotificationContent) => Promise<void>
}

export type SinkOptions = {
  readonly run: CommandRunner
  readonly sound: string
  readonly tmuxHelper: string
}

export const defaultSound = "Submarine"

const notificationScript = [
  "on run argv",
  "display notification (item 1 of argv) with title (item 2 of argv) subtitle (item 3 of argv) sound name (item 4 of argv)",
  "end run",
] as const

export const runCommand: CommandRunner = async (command) => {
  try {
    const child = Bun.spawn([...command], { stdin: "ignore", stdout: "pipe", stderr: "ignore" })
    const [stdout] = await Promise.all([new Response(child.stdout).text(), child.exited])
    return stdout
  } catch {
    return ""
  }
}

export function createSinks(options: SinkOptions): NotifierSinks {
  return {
    mark: async (event) => {
      await options.run([options.tmuxHelper, event])
    },
    notify: async (content) => {
      const windowLabel = (await options.run([options.tmuxHelper, "window_label"])).trim()
      const subtitle = windowLabel ? `${windowLabel} · ${content.subtitle}` : content.subtitle
      await options.run([
        "osascript",
        ...notificationScript.flatMap((line) => ["-e", line]),
        content.body,
        content.title,
        subtitle,
        options.sound,
      ])
    },
  }
}
