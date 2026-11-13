import { expect } from "bun:test"

export type ProcessResult = {
  readonly exitCode: number
  readonly stderr: string
  readonly stdout: string
}

export type TmuxFixture = {
  readonly environment: Readonly<Record<string, string>>
  readonly paneID: string
  readonly session: string
  readonly socket: string
}

const resources: Array<{ readonly session: string; readonly socket: string }> = []

export async function runProcess(
  command: readonly string[],
  environment: Readonly<Record<string, string>> = {},
  input?: string,
): Promise<ProcessResult> {
  const process = Bun.spawn([...command], {
    env: { ...Bun.env, ...environment },
    stdin: input === undefined ? "ignore" : new Response(input),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ])
  return { exitCode, stderr, stdout }
}

export async function runTmux(socket: string, args: readonly string[]): Promise<string> {
  const result = await runProcess(["tmux", "-L", socket, ...args])
  expect(result.exitCode, result.stderr).toBe(0)
  return result.stdout.trim()
}

// UUID-scoped sockets keep the tests away from the live tmux server.
export async function createTmux(): Promise<TmuxFixture> {
  const suffix = crypto.randomUUID()
  const socket = `agent-notifier-test-${suffix}`
  const session = `notifier-test-${suffix}`
  resources.push({ session, socket })
  await runTmux(socket, ["-f", "/dev/null", "new-session", "-d", "-s", session, "-n", "ha"])
  const paneID = await runTmux(socket, ["display-message", "-p", "-t", session, "#{pane_id}"])
  const tmux = await runTmux(socket, [
    "display-message",
    "-p",
    "-t",
    session,
    "#{socket_path},#{pid},0",
  ])
  return { environment: { TMUX: tmux, TMUX_PANE: paneID }, paneID, session, socket }
}

export async function destroyTmuxSessions(): Promise<void> {
  await Promise.all(
    resources
      .splice(0)
      .map(({ session, socket }) =>
        runProcess(["tmux", "-L", socket, "kill-session", "-t", session]),
      ),
  )
}
