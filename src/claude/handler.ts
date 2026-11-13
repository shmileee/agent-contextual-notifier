import { basename } from "node:path"

import {
  buildNotificationContent,
  decideCompletionNotification,
  type NotificationKind,
} from "../core/domain"
import type { NotifierSinks } from "../core/sinks"
import { parseClaudeHookEvent } from "./events"
import type { PendingRequest, SessionState, SessionStateStore } from "./state"

export type ClaudeHookRuntime = NotifierSinks & {
  readonly now: () => number
  readonly projectDirectory: string | undefined
  readonly store: SessionStateStore
}

type Delivery = {
  readonly cwd: string | undefined
  readonly errorText?: string | undefined
  readonly event: NotificationKind
  readonly lastAssistantText?: string | undefined
  readonly state: SessionState
}

const agentName = "Claude Code"

// Claude Code announces a permission prompt a few seconds after requesting it; an older request
// was answered without a notification and must not describe a later prompt.
const pendingRequestLifetimeMs = 60_000

async function deliver(runtime: ClaudeHookRuntime, delivery: Delivery): Promise<void> {
  const directory = runtime.projectDirectory ?? delivery.cwd
  const content = buildNotificationContent({
    agentName,
    errorText: delivery.errorText,
    event: delivery.event,
    lastAssistantText: delivery.lastAssistantText,
    lastUserText: delivery.state.lastUserText,
    projectName: directory ? basename(directory) : "project",
    sessionTitle: delivery.state.sessionTitle ?? "",
  })
  await Promise.allSettled([runtime.mark(delivery.event), runtime.notify(content)])
}

export function createClaudeHookHandler(
  runtime: ClaudeHookRuntime,
): (payload: unknown) => Promise<void> {
  const { store } = runtime
  const currentRequest = (state: SessionState): PendingRequest | undefined => {
    const request = state.pendingRequest
    if (!request) return undefined
    const age = runtime.now() - request.requestedAt
    return age >= 0 && age <= pendingRequestLifetimeMs ? request : undefined
  }

  return async (payload) => {
    const event = parseClaudeHookEvent(payload)
    if (!event) return

    switch (event.kind) {
      case "session_started": {
        await runtime.mark("session_started")
        if (!event.sessionTitle) return
        const state = await store.read(event.sessionID)
        await store.write(event.sessionID, { ...state, sessionTitle: event.sessionTitle })
        return
      }
      case "session_ended": {
        await Promise.allSettled([runtime.mark("session_started"), store.remove(event.sessionID)])
        return
      }
      case "user_message": {
        await runtime.mark("user_message")
        const state = await store.read(event.sessionID)
        await store.write(event.sessionID, {
          lastUserText: event.prompt ?? state.lastUserText,
          sessionTitle: event.sessionTitle ?? state.sessionTitle,
        })
        return
      }
      case "permission_requested": {
        const state = await store.read(event.sessionID)
        await store.write(event.sessionID, {
          ...state,
          pendingRequest: {
            detail: event.detail,
            kind: event.notificationKind,
            requestedAt: runtime.now(),
          },
        })
        return
      }
      case "attention": {
        const state = await store.read(event.sessionID)
        const request = event.notificationKind === "question" ? undefined : currentRequest(state)
        await deliver(runtime, {
          cwd: event.cwd,
          event: request?.kind ?? event.notificationKind,
          lastAssistantText: request?.detail ?? event.message,
          state,
        })
        return
      }
      case "stopped": {
        const decision = decideCompletionNotification({
          background: event.background,
          session: "top-level",
          superseded: false,
          todos: "complete",
        })
        if (decision.kind === "skip") return
        await deliver(runtime, {
          cwd: event.cwd,
          event: "complete",
          lastAssistantText: event.lastAssistantText,
          state: await store.read(event.sessionID),
        })
        return
      }
      case "failed": {
        await deliver(runtime, {
          cwd: event.cwd,
          errorText: event.errorText,
          event: "error",
          state: await store.read(event.sessionID),
        })
        return
      }
      default: {
        const exhaustive: never = event
        return exhaustive
      }
    }
  }
}
