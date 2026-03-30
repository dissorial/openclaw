import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagedRun, RunExit, SpawnInput } from "../process/supervisor/index.js";
import { mergeMockedModule } from "../test-utils/vitest-module-mocks.js";

const requestHeartbeatNowMock = vi.hoisted(() => vi.fn());
const enqueueSystemEventMock = vi.hoisted(() => vi.fn());
const supervisorSpawnMock = vi.hoisted(() => vi.fn());

let buildExecExitOutcome: typeof import("./bash-tools.exec-runtime.js").buildExecExitOutcome;
let detectCursorKeyMode: typeof import("./bash-tools.exec-runtime.js").detectCursorKeyMode;
let emitExecSystemEvent: typeof import("./bash-tools.exec-runtime.js").emitExecSystemEvent;
let formatExecFailureReason: typeof import("./bash-tools.exec-runtime.js").formatExecFailureReason;
let resolveExecTarget: typeof import("./bash-tools.exec-runtime.js").resolveExecTarget;
let runExecProcess: typeof import("./bash-tools.exec-runtime.js").runExecProcess;
let DEFAULT_EXEC_UPDATE_THROTTLE_MS: typeof import("./bash-tools.exec-runtime.js").DEFAULT_EXEC_UPDATE_THROTTLE_MS;

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("detectCursorKeyMode", () => {
  beforeAll(async () => {
    ({ detectCursorKeyMode } = await import("./bash-tools.exec-runtime.js"));
  });

  it("returns null when no toggle found", () => {
    expect(detectCursorKeyMode("hello world")).toBe(null);
    expect(detectCursorKeyMode("")).toBe(null);
  });

  it("detects smkx (application mode)", () => {
    expect(detectCursorKeyMode("\x1b[?1h")).toBe("application");
    expect(detectCursorKeyMode("\x1b[?1h\x1b=")).toBe("application");
    expect(detectCursorKeyMode("before \x1b[?1h after")).toBe("application");
  });

  it("detects rmkx (normal mode)", () => {
    expect(detectCursorKeyMode("\x1b[?1l")).toBe("normal");
    expect(detectCursorKeyMode("\x1b[?1l\x1b>")).toBe("normal");
    expect(detectCursorKeyMode("before \x1b[?1l after")).toBe("normal");
  });

  it("last toggle wins when both present", () => {
    // smkx first, then rmkx - should be normal
    expect(detectCursorKeyMode("\x1b[?1h\x1b[?1l")).toBe("normal");
    // rmkx first, then smkx - should be application
    expect(detectCursorKeyMode("\x1b[?1l\x1b[?1h")).toBe("application");
    // Multiple toggles - last one wins
    expect(detectCursorKeyMode("\x1b[?1h\x1b[?1l\x1b[?1h")).toBe("application");
  });
});

describe("resolveExecTarget", () => {
  beforeAll(async () => {
    ({ resolveExecTarget } = await import("./bash-tools.exec-runtime.js"));
  });

  it("treats auto as a default strategy rather than a host allowlist", () => {
    expect(
      resolveExecTarget({
        configuredTarget: "auto",
        requestedTarget: "node",
        elevatedRequested: false,
        sandboxAvailable: false,
      }),
    ).toMatchObject({
      configuredTarget: "auto",
      selectedTarget: "node",
      effectiveHost: "node",
    });
  });
});

describe("emitExecSystemEvent", () => {
  beforeEach(async () => {
    vi.resetModules();
    requestHeartbeatNowMock.mockClear();
    enqueueSystemEventMock.mockClear();
    supervisorSpawnMock.mockReset();
    vi.doMock("../infra/heartbeat-wake.js", async () => {
      return await mergeMockedModule(
        await vi.importActual<typeof import("../infra/heartbeat-wake.js")>(
          "../infra/heartbeat-wake.js",
        ),
        () => ({
          requestHeartbeatNow: requestHeartbeatNowMock,
        }),
      );
    });
    vi.doMock("../infra/system-events.js", () => ({
      enqueueSystemEvent: enqueueSystemEventMock,
    }));
    vi.doMock("../process/supervisor/index.js", () => ({
      getProcessSupervisor: () => ({
        spawn: (...args: unknown[]) => supervisorSpawnMock(...args),
        cancel: vi.fn(),
        cancelScope: vi.fn(),
        reconcileOrphans: vi.fn(),
        getRecord: vi.fn(),
      }),
    }));
    ({ buildExecExitOutcome, emitExecSystemEvent, formatExecFailureReason } =
      await import("./bash-tools.exec-runtime.js"));
  });

  it("scopes heartbeat wake to the event session key", () => {
    emitExecSystemEvent("Exec finished", {
      sessionKey: "agent:ops:main",
      contextKey: "exec:run-1",
    });

    expect(enqueueSystemEventMock).toHaveBeenCalledWith("Exec finished", {
      sessionKey: "agent:ops:main",
      contextKey: "exec:run-1",
    });
    expect(requestHeartbeatNowMock).toHaveBeenCalledWith({
      reason: "exec-event",
      sessionKey: "agent:ops:main",
    });
  });

  it("keeps wake unscoped for non-agent session keys", () => {
    emitExecSystemEvent("Exec finished", {
      sessionKey: "global",
      contextKey: "exec:run-global",
    });

    expect(enqueueSystemEventMock).toHaveBeenCalledWith("Exec finished", {
      sessionKey: "global",
      contextKey: "exec:run-global",
    });
    expect(requestHeartbeatNowMock).toHaveBeenCalledWith({
      reason: "exec-event",
    });
  });

  it("ignores events without a session key", () => {
    emitExecSystemEvent("Exec finished", {
      sessionKey: "  ",
      contextKey: "exec:run-2",
    });

    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(requestHeartbeatNowMock).not.toHaveBeenCalled();
  });
});

describe("formatExecFailureReason", () => {
  it("formats timeout guidance with the configured timeout", () => {
    expect(
      formatExecFailureReason({
        failureKind: "overall-timeout",
        exitSignal: "SIGKILL",
        timeoutSec: 45,
      }),
    ).toContain("45 seconds");
  });

  it("formats shell failures without timeout-specific guidance", () => {
    expect(
      formatExecFailureReason({
        failureKind: "shell-command-not-found",
        exitSignal: null,
        timeoutSec: 45,
      }),
    ).toBe("Command not found");
  });
});

describe("buildExecExitOutcome", () => {
  it("keeps non-zero normal exits in the completed path", () => {
    expect(
      buildExecExitOutcome({
        exit: {
          reason: "exit",
          exitCode: 1,
          exitSignal: null,
          durationMs: 123,
          stdout: "",
          stderr: "",
          timedOut: false,
          noOutputTimedOut: false,
        },
        aggregated: "done",
        durationMs: 123,
        timeoutSec: 30,
      }),
    ).toMatchObject({
      status: "completed",
      exitCode: 1,
      aggregated: "done\n\n(Command exited with code 1)",
    });
  });

  it("classifies timed out exits as failures with a reason", () => {
    expect(
      buildExecExitOutcome({
        exit: {
          reason: "overall-timeout",
          exitCode: null,
          exitSignal: "SIGKILL",
          durationMs: 123,
          stdout: "",
          stderr: "",
          timedOut: true,
          noOutputTimedOut: false,
        },
        aggregated: "",
        durationMs: 123,
        timeoutSec: 30,
      }),
    ).toMatchObject({
      status: "failed",
      failureKind: "overall-timeout",
      timedOut: true,
      reason: expect.stringContaining("30 seconds"),
    });
  });
});

describe("runExecProcess update throttling", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    requestHeartbeatNowMock.mockClear();
    enqueueSystemEventMock.mockClear();
    supervisorSpawnMock.mockReset();
    vi.doMock("../infra/heartbeat-wake.js", async () => {
      return await mergeMockedModule(
        await vi.importActual<typeof import("../infra/heartbeat-wake.js")>(
          "../infra/heartbeat-wake.js",
        ),
        () => ({
          requestHeartbeatNow: requestHeartbeatNowMock,
        }),
      );
    });
    vi.doMock("../infra/system-events.js", () => ({
      enqueueSystemEvent: enqueueSystemEventMock,
    }));
    vi.doMock("../process/supervisor/index.js", () => ({
      getProcessSupervisor: () => ({
        spawn: (...args: unknown[]) => supervisorSpawnMock(...args),
        cancel: vi.fn(),
        cancelScope: vi.fn(),
        reconcileOrphans: vi.fn(),
        getRecord: vi.fn(),
      }),
    }));
    ({ runExecProcess, DEFAULT_EXEC_UPDATE_THROTTLE_MS } =
      await import("./bash-tools.exec-runtime.js"));
  });

  it("coalesces bursty stdout into a single partial update", async () => {
    const exitDeferred = createDeferred<RunExit>();
    let spawnInput: SpawnInput | undefined;
    const managedRun: ManagedRun = {
      runId: "run-1",
      pid: 4321,
      startedAtMs: Date.now(),
      stdin: undefined,
      wait: vi.fn(() => exitDeferred.promise),
      cancel: vi.fn(),
    };
    supervisorSpawnMock.mockImplementation(async (input: SpawnInput) => {
      spawnInput = input;
      return managedRun;
    });
    const onUpdate = vi.fn();

    await runExecProcess({
      command: "echo hi",
      workdir: "/tmp",
      env: {},
      usePty: false,
      warnings: [],
      maxOutput: 200_000,
      pendingMaxOutput: 30_000,
      notifyOnExit: false,
      timeoutSec: null,
      onUpdate,
    });

    expect(spawnInput?.onStdout).toBeTypeOf("function");
    spawnInput?.onStdout?.("a".repeat(20_000));
    spawnInput?.onStdout?.("b".repeat(10_000));

    expect(onUpdate).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(DEFAULT_EXEC_UPDATE_THROTTLE_MS);

    expect(onUpdate).toHaveBeenCalledTimes(1);
    const first = onUpdate.mock.calls[0]?.[0] as {
      details?: { tail?: string };
      content?: Array<{ text?: string }>;
    };
    expect(first.details?.tail).toContain("b");
    expect(first.content?.[0]?.text).toContain("b");

    exitDeferred.resolve({
      reason: "exit",
      exitCode: 0,
      exitSignal: null,
      durationMs: 50,
      stdout: "",
      stderr: "",
      timedOut: false,
      noOutputTimedOut: false,
    });
  });

  it("flushes a pending update before the process resolves", async () => {
    const exitDeferred = createDeferred<RunExit>();
    let spawnInput: SpawnInput | undefined;
    supervisorSpawnMock.mockImplementation(async (input: SpawnInput) => {
      spawnInput = input;
      return {
        runId: "run-2",
        pid: 9876,
        startedAtMs: Date.now(),
        stdin: undefined,
        wait: vi.fn(() => exitDeferred.promise),
        cancel: vi.fn(),
      } satisfies ManagedRun;
    });
    const onUpdate = vi.fn();

    const run = await runExecProcess({
      command: "echo hi",
      workdir: "/tmp",
      env: {},
      usePty: false,
      warnings: [],
      maxOutput: 200_000,
      pendingMaxOutput: 30_000,
      notifyOnExit: false,
      timeoutSec: null,
      onUpdate,
    });

    spawnInput?.onStdout?.("hello from stdout");
    expect(onUpdate).not.toHaveBeenCalled();

    exitDeferred.resolve({
      reason: "exit",
      exitCode: 0,
      exitSignal: null,
      durationMs: 25,
      stdout: "",
      stderr: "",
      timedOut: false,
      noOutputTimedOut: false,
    });

    await run.promise;

    expect(onUpdate).toHaveBeenCalledTimes(1);
    const first = onUpdate.mock.calls[0]?.[0] as { content?: Array<{ text?: string }> };
    expect(first.content?.[0]?.text).toContain("hello from stdout");
  });
});
