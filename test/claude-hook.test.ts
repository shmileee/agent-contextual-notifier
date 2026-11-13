import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  createTmux,
  destroyTmuxSessions,
  type ProcessResult,
  runProcess,
  runTmux,
  type TmuxFixture,
} from "./tmux-harness"

const hook = join(import.meta.dir, "..", "src", "claude", "hook.ts")
const temporaryRoots: string[] = []

type HookFixture = {
  readonly environment: Readonly<Record<string, string>>
  readonly notification: () => Promise<readonly string[]>
  readonly tmux: TmuxFixture
}

const session = { cwd: "/work/dotfiles", session_id: "session-1" } as const
const prompt = { ...session, hook_event_name: "UserPromptSubmit", prompt: "Tidy the tmux config" }
const stop = {
  ...session,
  background_tasks: [],
  hook_event_name: "Stop",
  last_assistant_message: "The config is tidy.",
}

// A stand-in osascript records its arguments so no real notification is sent.
async function createFixture(): Promise<HookFixture> {
  const root = await mkdtemp(join(tmpdir(), "agent-notifier-hook-"))
  temporaryRoots.push(root)
  const log = join(root, "notification.log")
  await mkdir(join(root, "bin"))
  await Bun.write(join(root, "bin", "osascript"), `#!/bin/sh\nprintf '%s\\n' "$@" >"${log}"\n`)
  await chmod(join(root, "bin", "osascript"), 0o755)
  const tmux = await createTmux()
  const { PATH: inheritedPath = "" } = Bun.env
  return {
    environment: {
      ...tmux.environment,
      AGENT_NOTIFIER_SOUND: "",
      CLAUDE_PLUGIN_DATA: join(root, "data"),
      CLAUDE_PLUGIN_OPTION_SOUND: "",
      CLAUDE_PROJECT_DIR: "",
      PATH: `${join(root, "bin")}:${inheritedPath}`,
    },
    notification: async () => {
      const file = Bun.file(log)
      return (await file.exists()) ? (await file.text()).trimEnd().split("\n").slice(-4) : []
    },
    tmux,
  }
}

function runHook(
  payload: unknown,
  environment: Readonly<Record<string, string>>,
): Promise<ProcessResult> {
  const input = typeof payload === "string" ? payload : JSON.stringify(payload)
  return runProcess(["bun", hook], environment, input)
}

function marker(tmux: TmuxFixture): Promise<string> {
  return runTmux(tmux.socket, ["display-message", "-p", "-t", tmux.paneID, "#{@agent_waiting}"])
}

afterEach(async () => {
  await destroyTmuxSessions()
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  )
})

describe("Claude Code hook", () => {
  test("marks the window and notifies with context carried between hook processes", async () => {
    // Given
    const fixture = await createFixture()

    // When
    const submitted = await runHook(prompt, fixture.environment)
    const stopped = await runHook(stop, fixture.environment)

    // Then
    expect(submitted).toEqual({ exitCode: 0, stderr: "", stdout: "" })
    expect(stopped).toEqual({ exitCode: 0, stderr: "", stdout: "" })
    expect(await marker(fixture.tmux)).toBe("●")
    expect(await fixture.notification()).toEqual([
      "Ready for input You: Tidy the tmux config Agent: The config is tidy.",
      "Claude Code · dotfiles",
      "0: ha · Claude Code session",
      "Submarine",
    ])
  })

  test("clears the marker when the user replies", async () => {
    // Given
    const fixture = await createFixture()
    await runHook(stop, fixture.environment)

    // When
    await runHook(prompt, fixture.environment)

    // Then
    expect(await marker(fixture.tmux)).toBe("")
  })

  test("plays the sound configured for the plugin", async () => {
    // Given
    const fixture = await createFixture()

    // When
    await runHook(stop, { ...fixture.environment, CLAUDE_PLUGIN_OPTION_SOUND: "Glass" })

    // Then
    expect((await fixture.notification()).at(-1)).toBe("Glass")
  })

  test("notifies without a window label outside tmux", async () => {
    // Given
    const fixture = await createFixture()

    // When
    await runHook(stop, { ...fixture.environment, TMUX: "", TMUX_PANE: "" })

    // Then
    expect(await marker(fixture.tmux)).toBe("")
    expect((await fixture.notification()).at(-2)).toBe("Claude Code session")
  })

  test("stays silent and succeeds on input it cannot read", async () => {
    // Given
    const fixture = await createFixture()

    // When
    const result = await runHook("not json", fixture.environment)

    // Then
    expect(result).toEqual({ exitCode: 0, stderr: "", stdout: "" })
    expect(await marker(fixture.tmux)).toBe("")
    expect(await fixture.notification()).toEqual([])
  })
})
