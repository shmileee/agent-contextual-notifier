import { describe, expect, test } from "bun:test"
import { type ClaudeHookRuntime, createClaudeHookHandler } from "../src/claude/handler"
import type { SessionState } from "../src/claude/state"
import type { MarkerEvent, NotificationContent } from "../src/core/domain"

type Harness = {
  readonly clock: { now: number }
  readonly handle: (payload: unknown) => Promise<void>
  readonly markers: MarkerEvent[]
  readonly notifications: NotificationContent[]
  readonly states: Map<string, SessionState>
}

const session = { cwd: "/work/dotfiles", session_id: "session-1" } as const
const prompt = { ...session, hook_event_name: "UserPromptSubmit", prompt: "Tidy the tmux config" }
const stop = {
  ...session,
  background_tasks: [],
  hook_event_name: "Stop",
  last_assistant_message: "The config is tidy.",
}
const permissionNotification = {
  ...session,
  hook_event_name: "Notification",
  message: "Claude needs your permission",
  notification_type: "permission_prompt",
}

function createHarness(overrides: Partial<ClaudeHookRuntime> = {}): Harness {
  const clock = { now: 1_000_000 }
  const markers: MarkerEvent[] = []
  const notifications: NotificationContent[] = []
  const states = new Map<string, SessionState>()
  const handle = createClaudeHookHandler({
    mark: async (event) => {
      markers.push(event)
    },
    notify: async (content) => {
      notifications.push(content)
    },
    now: () => clock.now,
    projectDirectory: undefined,
    store: {
      read: async (sessionID) => states.get(sessionID) ?? {},
      remove: async (sessionID) => {
        states.delete(sessionID)
      },
      write: async (sessionID, state) => {
        states.set(sessionID, state)
      },
    },
    ...overrides,
  })
  return { clock, handle, markers, notifications, states }
}

describe("createClaudeHookHandler", () => {
  test("announces a finished turn with the prompt that started it", async () => {
    // Given
    const harness = createHarness()

    // When
    await harness.handle(prompt)
    await harness.handle(stop)

    // Then
    expect(harness.markers).toEqual(["user_message", "complete"])
    expect(harness.notifications).toEqual([
      {
        body: "Ready for input You: Tidy the tmux config Agent: The config is tidy.",
        subtitle: "Claude Code session",
        title: "Claude Code · dotfiles",
      },
    ])
  })

  test("names the project root and the session title when Claude Code provides them", async () => {
    // Given
    const harness = createHarness({ projectDirectory: "/work/home-assistant" })

    // When
    await harness.handle({ ...prompt, session_title: "Fix the heating schedule" })
    await harness.handle({ ...stop, cwd: "/work/home-assistant/packages/climate" })

    // Then
    expect(harness.notifications[0]?.title).toBe("Claude Code · home-assistant")
    expect(harness.notifications[0]?.subtitle).toBe("Fix the heating schedule")
  })

  test.each([
    ["background work is still running", [{ id: "task-1", type: "shell" }]],
    ["background work cannot be read", "corrupt"],
  ])("stays quiet on a finished turn when %s", async (_reason, backgroundTasks) => {
    // Given
    const harness = createHarness()

    // When
    await harness.handle({ ...stop, background_tasks: backgroundTasks })

    // Then
    expect(harness.markers).toEqual([])
    expect(harness.notifications).toEqual([])
  })

  test.each([
    [
      "a tool permission",
      {
        tool_input: { command: "rm -rf dist", description: "Remove the build" },
        tool_name: "Bash",
      },
      "Permission required You: Tidy the tmux config Agent: Bash: Remove the build",
      "permission",
    ],
    [
      "a question",
      {
        tool_input: { questions: [{ question: "Which shell do you use?" }] },
        tool_name: "AskUserQuestion",
      },
      "Question waiting You: Tidy the tmux config Agent: Which shell do you use?",
      "question",
    ],
    [
      "a plan",
      { tool_input: { plan: "# Plan\n\n1. Move the hooks." }, tool_name: "ExitPlanMode" },
      "Plan ready for review You: Tidy the tmux config Agent: # Plan 1. Move the hooks.",
      "plan_exit",
    ],
  ] as const)("describes %s that is still waiting", async (_label, request, body, marker) => {
    // Given
    const harness = createHarness()
    await harness.handle(prompt)

    // When
    await harness.handle({ ...session, ...request, hook_event_name: "PermissionRequest" })
    harness.clock.now += 6_000
    await harness.handle(permissionNotification)

    // Then
    expect(harness.markers).toEqual(["user_message", marker])
    expect(harness.notifications.map((content) => content.body)).toEqual([body])
  })

  test("does not describe a prompt with a request that was answered long ago", async () => {
    // Given
    const harness = createHarness()
    await harness.handle({
      ...session,
      hook_event_name: "PermissionRequest",
      tool_input: { questions: [{ question: "Which shell do you use?" }] },
      tool_name: "AskUserQuestion",
    })

    // When
    harness.clock.now += 120_000
    await harness.handle({
      ...permissionNotification,
      message: "Claude Code needs your approval for the plan",
    })

    // Then
    expect(harness.markers).toEqual(["plan_exit"])
    expect(harness.notifications[0]?.body).toBe(
      "Plan ready for review Agent: Claude Code needs your approval for the plan",
    )
  })

  test("forgets a waiting request once the user replies", async () => {
    // Given
    const harness = createHarness()
    await harness.handle({
      ...session,
      hook_event_name: "PermissionRequest",
      tool_input: { command: "rm -rf dist" },
      tool_name: "Bash",
    })

    // When
    await harness.handle(prompt)

    // Then
    expect(harness.states.get("session-1")).toEqual({
      lastUserText: "Tidy the tmux config",
      sessionTitle: undefined,
    })
  })

  test("treats an MCP elicitation as a question, whatever permission came before", async () => {
    // Given
    const harness = createHarness()
    await harness.handle({
      ...session,
      hook_event_name: "PermissionRequest",
      tool_input: { command: "rm -rf dist" },
      tool_name: "Bash",
    })

    // When
    await harness.handle({
      ...session,
      hook_event_name: "Notification",
      message: "The server needs an account name",
      notification_type: "elicitation_dialog",
    })

    // Then
    expect(harness.markers).toEqual(["question"])
    expect(harness.notifications[0]?.body).toBe(
      "Question waiting Agent: The server needs an account name",
    )
  })

  test("reports the error that ended a turn", async () => {
    // Given
    const harness = createHarness()
    await harness.handle(prompt)

    // When
    await harness.handle({
      ...session,
      error: "rate_limit",
      hook_event_name: "StopFailure",
      last_assistant_message: "API Error: Rate limit reached",
    })

    // Then
    expect(harness.markers).toEqual(["user_message", "error"])
    expect(harness.notifications[0]?.body).toBe(
      "Error You: Tidy the tmux config API Error: Rate limit reached",
    )
  })

  test("clears the marker and the stored context when the session ends", async () => {
    // Given
    const harness = createHarness()
    await harness.handle(prompt)
    await harness.handle(stop)

    // When
    await harness.handle({ ...session, hook_event_name: "SessionEnd", reason: "other" })

    // Then
    expect(harness.markers.at(-1)).toBe("session_started")
    expect(harness.states.has("session-1")).toBe(false)
  })

  test("clears the marker when a session starts", async () => {
    // Given
    const harness = createHarness()

    // When
    await harness.handle({ ...session, hook_event_name: "SessionStart", source: "startup" })

    // Then
    expect(harness.markers).toEqual(["session_started"])
    expect(harness.notifications).toEqual([])
  })

  test.each([
    ["an idle reminder", { ...permissionNotification, notification_type: "idle_prompt" }],
    ["an event it does not handle", { ...session, hook_event_name: "PreToolUse" }],
    ["a payload without a session", { hook_event_name: "Stop" }],
    ["a payload that is not an object", "Stop"],
  ])("ignores %s", async (_label, payload) => {
    // Given
    const harness = createHarness()

    // When
    await harness.handle(payload)

    // Then
    expect(harness.markers).toEqual([])
    expect(harness.notifications).toEqual([])
  })
})
