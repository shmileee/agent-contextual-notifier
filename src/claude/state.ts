import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"

import type { AttentionKind } from "./events"

export type PendingRequest = {
  readonly detail?: string | undefined
  readonly kind: AttentionKind
  readonly requestedAt: number
}

export type SessionState = {
  readonly lastUserText?: string | undefined
  readonly pendingRequest?: PendingRequest | undefined
  readonly sessionTitle?: string | undefined
}

export type SessionStateStore = {
  readonly read: (sessionID: string) => Promise<SessionState>
  readonly remove: (sessionID: string) => Promise<void>
  readonly write: (sessionID: string, state: SessionState) => Promise<void>
}

const safeSessionID = /^[A-Za-z0-9_-]{1,128}$/
const attentionKinds: readonly string[] = ["permission", "plan_exit", "question"]

function isAttentionKind(value: unknown): value is AttentionKind {
  return typeof value === "string" && attentionKinds.includes(value)
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function parsePendingRequest(value: unknown): PendingRequest | undefined {
  if (typeof value !== "object" || value === null) return undefined
  if (!("kind" in value) || !isAttentionKind(value.kind)) return undefined
  if (!("requestedAt" in value) || typeof value.requestedAt !== "number") return undefined
  return {
    detail: optionalText("detail" in value ? value.detail : undefined),
    kind: value.kind,
    requestedAt: value.requestedAt,
  }
}

function parseState(value: unknown): SessionState {
  if (typeof value !== "object" || value === null) return {}
  return {
    lastUserText: optionalText("lastUserText" in value ? value.lastUserText : undefined),
    pendingRequest: parsePendingRequest(
      "pendingRequest" in value ? value.pendingRequest : undefined,
    ),
    sessionTitle: optionalText("sessionTitle" in value ? value.sessionTitle : undefined),
  }
}

// Hooks run as short-lived processes, so context has to outlive the process that saw it.
export function createFileStateStore(directory: string): SessionStateStore {
  const pathFor = (sessionID: string): string | undefined =>
    safeSessionID.test(sessionID) ? join(directory, `${sessionID}.json`) : undefined

  return {
    read: async (sessionID) => {
      const path = pathFor(sessionID)
      if (!path) return {}
      try {
        return parseState(await Bun.file(path).json())
      } catch {
        return {}
      }
    },
    remove: async (sessionID) => {
      const path = pathFor(sessionID)
      if (path) await rm(path, { force: true })
    },
    write: async (sessionID, state) => {
      const path = pathFor(sessionID)
      if (!path) return
      await mkdir(directory, { recursive: true })
      await Bun.write(path, JSON.stringify(state))
    },
  }
}
