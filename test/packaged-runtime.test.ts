import { expect, test } from "bun:test"
import { getPackagedCommand, needsPackagedSidecar, runPackagedRuntime } from "~/lib/packaged-runtime"

test("packaged runtime defaults to start and only starts a sidecar for servers", () => {
    expect(getPackagedCommand([])).toBe("start")
    expect(needsPackagedSidecar([])).toBe(true)
    expect(needsPackagedSidecar(["start", "--port", "9000"])).toBe(true)
    expect(needsPackagedSidecar(["remote"])).toBe(true)
    expect(needsPackagedSidecar(["accounts"])).toBe(false)
    expect(needsPackagedSidecar(["add-account"])).toBe(false)
})

test("successful long-running command keeps the sidecar alive", async () => {
    const events: string[] = []
    await runPackagedRuntime(["start"], {
        sidecarAvailable: true,
        startSidecar: async () => { events.push("start-sidecar") },
        stopSidecar: () => { events.push("stop-sidecar") },
        runCli: async () => { events.push("run-cli") },
    })

    expect(events).toEqual(["start-sidecar", "run-cli"])
})

test("one-shot commands do not start or stop the sidecar", async () => {
    const events: string[] = []
    await runPackagedRuntime(["accounts"], {
        sidecarAvailable: true,
        startSidecar: async () => { events.push("start-sidecar") },
        stopSidecar: () => { events.push("stop-sidecar") },
        runCli: async () => { events.push("run-cli") },
    })

    expect(events).toEqual(["run-cli"])
})

test("startup failures stop an already-started sidecar", async () => {
    const events: string[] = []
    await expect(runPackagedRuntime(["remote"], {
        sidecarAvailable: true,
        startSidecar: async () => { events.push("start-sidecar") },
        stopSidecar: () => { events.push("stop-sidecar") },
        runCli: async () => { throw new Error("startup failed") },
    })).rejects.toThrow("startup failed")

    expect(events).toEqual(["start-sidecar", "stop-sidecar"])
})

test("reported startup failure stops the sidecar", async () => {
    const events: string[] = []
    await runPackagedRuntime(["remote"], {
        sidecarAvailable: true,
        startSidecar: async () => { events.push("start-sidecar") },
        stopSidecar: () => { events.push("stop-sidecar") },
        runCli: async () => { events.push("run-cli") },
        startupFailed: () => true,
    })

    expect(events).toEqual(["start-sidecar", "run-cli", "stop-sidecar"])
})
