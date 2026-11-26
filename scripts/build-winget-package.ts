import { cp, mkdir, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import { basename, join, resolve } from "node:path"

const repoRoot = process.cwd()
const packageJson = await Bun.file(join(repoRoot, "package.json")).json()
const version = (process.argv[2]?.trim() || packageJson.version).replace(/^v/, "")
const archArg = (process.argv[3]?.trim() || process.arch).toLowerCase()
const arch = archArg === "x64" || archArg === "arm64" ? archArg : process.arch === "arm64" ? "arm64" : "x64"
const compileTarget = arch === "arm64" ? "bun-windows-arm64" : "bun-windows-x64"
const bundleRoot = resolve(repoRoot, "dist", `winget-${arch}`)
const bundleDir = join(bundleRoot, "anti-api")
const exePath = join(bundleDir, "anti-api.exe")
const proxyPath = join(repoRoot, "rust-proxy", "target", "release", "anti-proxy.exe")

await rm(bundleRoot, { recursive: true, force: true })
await mkdir(join(bundleDir, "public"), { recursive: true })

const compile = Bun.spawn([
    "bun",
    "build",
    "--compile",
    "--outfile",
    exePath,
    "--target",
    compileTarget,
    "--windows-hide-console",
    "--windows-title",
    "Anti-API",
    "--windows-publisher",
    "silasxbt",
    "--windows-description",
    "Independent local protocol-compatibility proxy for authorized provider connections",
    "--windows-version",
    `${version}.0`,
    "src/portable-main.ts",
], {
    cwd: repoRoot,
    stdout: "inherit",
    stderr: "inherit",
})

const compileExit = await compile.exited
if (compileExit !== 0) {
    throw new Error(`bun build failed with exit code ${compileExit}`)
}

if (!existsSync(proxyPath)) {
    throw new Error(`Missing anti-proxy.exe at ${proxyPath}. Build rust-proxy first.`)
}

await cp(join(repoRoot, "public"), join(bundleDir, "public"), { recursive: true })
await cp(proxyPath, join(bundleDir, "anti-proxy.exe"))
await cp(join(repoRoot, "LICENSE"), join(bundleDir, "LICENSE"))
await cp(join(repoRoot, "README.md"), join(bundleDir, "README.md"))

console.log(`Built WinGet bundle for ${version} (${arch})`)
console.log(`Bundle directory: ${bundleDir}`)
console.log(`Executable: ${basename(exePath)}`)
