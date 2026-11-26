import { existsSync } from "fs"
import { dirname, join } from "path"

import { runCli } from "./main"
import { startRustProxy, stopRustProxy } from "./lib/rust-proxy"
import { runPackagedRuntime } from "./lib/packaged-runtime"

const exeDir = dirname(process.execPath)
const publicDir = join(exeDir, "public")
const rustProxyName = process.platform === "win32" ? "anti-proxy.exe" : "anti-proxy"
const rustProxyPath = join(exeDir, rustProxyName)

process.env.ANTI_API_OAUTH_NO_OPEN = process.env.ANTI_API_OAUTH_NO_OPEN || "1"

if (!process.env.ANTI_API_PUBLIC_DIR && existsSync(publicDir)) {
    process.env.ANTI_API_PUBLIC_DIR = publicDir
}
if (!process.env.ANTI_API_RUST_PROXY_BIN && existsSync(rustProxyPath)) {
    process.env.ANTI_API_RUST_PROXY_BIN = rustProxyPath
}

process.on("SIGINT", () => {
    stopRustProxy()
    process.exit(130)
})

process.on("SIGTERM", () => {
    stopRustProxy()
    process.exit(143)
})

// citty terminates the process directly on command/startup errors. Keep a
// synchronous last-resort cleanup hook so those exits cannot orphan the child.
process.on("exit", () => {
    stopRustProxy()
})

await runPackagedRuntime(process.argv.slice(2), {
    sidecarAvailable: existsSync(rustProxyPath),
    startSidecar: startRustProxy,
    stopSidecar: stopRustProxy,
    runCli,
    startupFailed: () => typeof process.exitCode === "number" && process.exitCode !== 0,
})
