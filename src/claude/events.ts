import type { NotificationKind } from "../core/domain"

export type AttentionKind = Extract<NotificationKind, "permission" | "plan_exit" | "question">

export type ClaudeHookEvent =
  | {
      readonly kind: "session_started"
      readonly sessionID: string
      readonly sessionTitle: string | undefined
    }
  | { readonly kind: "session_ended"; readonly sessionID: string }
  | {
      readonly kind: "user_message"
      readonly prompt: string | undefined
      readonly sessionID: string
      readonly sessionTitle: string | undefined
    }
  | {
      readonly detail: string | undefined
      readonly kind: "permission_requested"
      readonly notificationKind: AttentionKind
      readonly sessionID: string
    }
  | {
      readonly cwd: string | undefined
      readonly kind: "attention"
      readonly message: string | undefined
      readonly notificationKind: AttentionKind
      readonly sessionID: string
    }
  | {
      readonly background: "active" | "idle" | "unknown"
      readonly cwd: string | undefined
      readonly kind: "stopped"
      readonly lastAssistantText: string | undefined
      readonly sessionID: string
    }
  | {
      readonly cwd: string | undefined
      readonly errorText: string | undefined
      readonly kind: "failed"
      readonly sessionID: string
    }

type Payload = Readonly<Record<string, unknown>>

const questionNotifications = new Set(["elicitation_dialog", "elicitation_url_dialog"])
const toolDetailFields = ["description", "command", "file_path", "url"] as const

function isPayload(value: unknown): value is Payload {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function field(payload: Payload, key: string): unknown {
  return payload[key]
}

function text(payload: Payload, key: string): string | undefined {
  const value = field(payload, key)
  return typeof value === "string" && value.trim() ? value : undefined
}

function background(payload: Payload): "active" | "idle" | "unknown" {
  const tasks = field(payload, "background_tasks")
  // Claude Code versions that predate the field cannot report background work.
  if (tasks === undefined) return "idle"
  if (!Array.isArray(tasks)) return "unknown"
  return tasks.length > 0 ? "active" : "idle"
}

function attentionKind(payload: Payload): AttentionKind | undefined {
  const type = text(payload, "notification_type")
  if (type === "permission_prompt") {
    const wording = `${text(payload, "title") ?? ""} ${text(payload, "message") ?? ""}`
    return wording.toLowerCase().includes("plan") ? "plan_exit" : "permission"
  }
  return type && questionNotifications.has(type) ? "question" : undefined
}

function firstQuestion(input: Payload): string | undefined {
  const questions = field(input, "questions")
  const first: unknown = Array.isArray(questions) ? questions[0] : undefined
  return isPayload(first) ? text(first, "question") : undefined
}

function permissionRequest(
  payload: Payload,
): Pick<Extract<ClaudeHookEvent, { kind: "permission_requested" }>, "detail" | "notificationKind"> {
  const toolName = text(payload, "tool_name")
  const rawInput = field(payload, "tool_input")
  const input = isPayload(rawInput) ? rawInput : {}

  if (toolName === "AskUserQuestion") {
    return { detail: firstQuestion(input), notificationKind: "question" }
  }
  if (toolName === "ExitPlanMode") {
    return { detail: text(input, "plan"), notificationKind: "plan_exit" }
  }
  const summary = toolDetailFields
    .map((name) => text(input, name))
    .find((value) => value !== undefined)
  const detail = [toolName, summary].filter((value) => value !== undefined).join(": ")
  return { detail: detail || undefined, notificationKind: "permission" }
}

export function parseClaudeHookEvent(rawPayload: unknown): ClaudeHookEvent | undefined {
  if (!isPayload(rawPayload)) return undefined
  const sessionID = text(rawPayload, "session_id")
  if (!sessionID) return undefined
  const cwd = text(rawPayload, "cwd")

  switch (text(rawPayload, "hook_event_name")) {
    case "SessionStart":
      return {
        kind: "session_started",
        sessionID,
        sessionTitle: text(rawPayload, "session_title"),
      }
    case "SessionEnd":
      return { kind: "session_ended", sessionID }
    case "UserPromptSubmit":
      return {
        kind: "user_message",
        prompt: text(rawPayload, "prompt"),
        sessionID,
        sessionTitle: text(rawPayload, "session_title"),
      }
    case "PermissionRequest":
      return { kind: "permission_requested", sessionID, ...permissionRequest(rawPayload) }
    case "Notification": {
      const notificationKind = attentionKind(rawPayload)
      if (!notificationKind) return undefined
      return {
        cwd,
        kind: "attention",
        message: text(rawPayload, "message"),
        notificationKind,
        sessionID,
      }
    }
    case "Stop":
      return {
        background: background(rawPayload),
        cwd,
        kind: "stopped",
        lastAssistantText: text(rawPayload, "last_assistant_message"),
        sessionID,
      }
    case "StopFailure":
      return {
        cwd,
        errorText:
          text(rawPayload, "last_assistant_message") ??
          text(rawPayload, "error_details") ??
          text(rawPayload, "error"),
        kind: "failed",
        sessionID,
      }
    default:
      return undefined
  }
}
