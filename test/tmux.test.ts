import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"

import { createTmux, destroyTmuxSessions, runProcess, runTmux } from "./tmux-harness"

const helper = join(import.meta.dir, "..", "scripts", "agent-notifier-tmux")
const plugin = join(import.meta.dir, "..", "agent-contextual-notifier.tmux")

afterEach(destroyTmuxSessions)

describe("tmux helper", () => {
  test("sets, labels, and clears the originating window", async () => {
    // Given
    const tmux = await createTmux()

    // When
    const completion = await runProcess([helper, "complete"], tmux.environment)
    const label = await runProcess([helper, "window_label"], tmux.environment)

    // Then
    expect(completion.exitCode, completion.stderr).toBe(0)
    expect(label.stdout.trim()).toBe("0: ha")
    expect(
      await runTmux(tmux.socket, ["display-message", "-p", "-t", tmux.paneID, "#{@agent_waiting}"]),
    ).toBe("●")

    await runProcess([helper, "user_message"], tmux.environment)
    expect(
      await runTmux(tmux.socket, ["display-message", "-p", "-t", tmux.paneID, "#{@agent_waiting}"]),
    ).toBe("")
  })

  test("resolves the originating pane when TMUX_PANE is absent", async () => {
    // Given
    const tmux = await createTmux()
    const done = `done-${crypto.randomUUID()}`
    const release = `release-${crypto.randomUUID()}`
    const command = `env -u TMUX_PANE "${helper}" complete; tmux wait-for -S "${done}"; tmux wait-for "${release}"`
    const waiter = runTmux(tmux.socket, ["wait-for", done])

    // When
    await runTmux(tmux.socket, ["send-keys", "-t", tmux.session, "-l", command])
    await runTmux(tmux.socket, ["send-keys", "-t", tmux.session, "Enter"])
    await waiter

    // Then
    expect(
      await runTmux(tmux.socket, ["display-message", "-p", "-t", tmux.paneID, "#{@agent_waiting}"]),
    ).toBe("●")
    await runTmux(tmux.socket, ["wait-for", "-S", release])
  })
})

describe("TPM entrypoint", () => {
  test("renders the waiting marker on the origin after another window is selected", async () => {
    // Given
    const tmux = await createTmux()
    await runTmux(tmux.socket, ["set-window-option", "-g", "window-status-format", "WINDOW"])
    await runProcess([plugin], tmux.environment)
    await runTmux(tmux.socket, ["new-window", "-d", "-t", tmux.session, "-n", "other"])

    // When
    await runProcess([helper, "complete"], tmux.environment)
    await runTmux(tmux.socket, ["select-window", "-t", `${tmux.session}:other`])

    // Then
    expect(
      await runTmux(tmux.socket, [
        "display-message",
        "-p",
        "-t",
        tmux.paneID,
        "#{E:window-status-format}",
      ]),
    ).toContain("● WINDOW")
  })

  test("installs window rendering and clear hooks idempotently", async () => {
    // Given
    const tmux = await createTmux()
    await runTmux(tmux.socket, [
      "set-option",
      "-g",
      "status-right",
      "#{?@agent_waiting,#{@agent_waiting} ,}RIGHT",
    ])
    await runTmux(tmux.socket, ["set-window-option", "-g", "window-status-format", "WINDOW"])
    await runTmux(tmux.socket, [
      "set-window-option",
      "-g",
      "window-status-current-format",
      "CURRENT",
    ])
    await runTmux(tmux.socket, [
      "set-hook",
      "-g",
      "after-select-window",
      "set-option -g @existing-hook yes",
    ])

    // When
    await runProcess([plugin], tmux.environment)
    await runProcess([plugin], tmux.environment)

    // Then
    expect(await runTmux(tmux.socket, ["show-option", "-gv", "status-right"])).toBe("RIGHT")
    for (const [optionName, original] of [
      ["window-status-format", "WINDOW"],
      ["window-status-current-format", "CURRENT"],
    ] as const) {
      const format = await runTmux(tmux.socket, ["show-window-options", "-gv", optionName])
      expect(format.match(/#\{@agent_waiting\}/g)).toHaveLength(1)
      expect(format).toContain(original)
    }
    for (const hookName of ["after-select-window", "session-window-changed", "client-focus-in"]) {
      const hook = await runTmux(tmux.socket, ["show-hooks", "-g", hookName])
      expect(hook.split("\n").filter((line) => line.includes("@agent_waiting"))).toHaveLength(1)
      if (hookName === "after-select-window") {
        expect(hook).toContain("@existing-hook")
      }
    }
  })

  test("migrates opencode-contextual-notifier names without moving the marker", async () => {
    // Given
    const tmux = await createTmux()
    const legacyFormat = "[#{?@opencode_waiting,#{@opencode_waiting} ,}#I:#W]"
    await runTmux(tmux.socket, ["set-option", "-g", "@opencode-notifier-marker", "!"])
    await runTmux(tmux.socket, ["set-window-option", "-g", "window-status-format", legacyFormat])
    await runTmux(tmux.socket, [
      "set-hook",
      "-g",
      "after-select-window",
      "set-option -wq -u @opencode_waiting",
    ])
    await runTmux(tmux.socket, [
      "set-hook",
      "-ag",
      "after-select-window",
      "set-option -g @existing-hook yes",
    ])

    // When
    await runProcess([plugin], tmux.environment)
    await runProcess([plugin], tmux.environment)
    await runProcess([helper, "complete"], tmux.environment)

    // Then
    expect(await runTmux(tmux.socket, ["show-window-options", "-gv", "window-status-format"])).toBe(
      "[#{?@agent_waiting,#{@agent_waiting} ,}#I:#W]",
    )
    const hook = await runTmux(tmux.socket, ["show-hooks", "-g", "after-select-window"])
    expect(hook).not.toContain("@opencode_waiting")
    expect(hook.split("\n").filter((line) => line.includes("@agent_waiting"))).toHaveLength(1)
    expect(hook).toContain("@existing-hook")
    expect(
      await runTmux(tmux.socket, ["display-message", "-p", "-t", tmux.paneID, "#{@agent_waiting}"]),
    ).toBe("!")
  })
})
