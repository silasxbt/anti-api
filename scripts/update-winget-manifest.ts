import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"

function parseArgs(argv: string[]): Record<string, string> {
    const result: Record<string, string> = {}
    for (let i = 0; i < argv.length; i += 1) {
        const item = argv[i]
        if (!item.startsWith("--")) continue
        const [rawKey, inlineValue] = item.slice(2).split("=", 2)
        const nextValue = inlineValue ?? argv[i + 1]
        result[rawKey] = nextValue
        if (inlineValue === undefined) i += 1
    }
    return result
}

const repoRoot = process.cwd()
const args = parseArgs(process.argv.slice(2))
const packageJson = await Bun.file(join(repoRoot, "package.json")).json()
const version = (args.version || packageJson.version).replace(/^v/, "")
const arch = (args.arch || "x64").toLowerCase()
// Keep the published package ID and manifest path stable for existing WinGet installs.
const packageIdentifier = "Ink1ing.AntiAPI"
const packageName = "Anti-API"
const publisher = "silasxbt"
const manifestVersion = "1.12.0"
const manifestRoot = resolve(repoRoot, "packaging", "winget", "manifests", "i", "Ink1ing", "AntiAPI", version)
const zipPath = args["zip-path"] ? resolve(repoRoot, args["zip-path"]) : resolve(repoRoot, "dist", `anti-api-winget-${arch}.zip`)
const defaultUrl = `https://github.com/silasxbt/anti-api/releases/download/v${version}/anti-api-winget-${arch}.zip`
const installerUrl = args.url || defaultUrl

let sha256 = args.sha256
if (!sha256) {
    if (!existsSync(zipPath)) {
        throw new Error(`Missing zip file for SHA256 generation: ${zipPath}`)
    }
    const buffer = await readFile(zipPath)
    sha256 = createHash("sha256").update(buffer).digest("hex").toUpperCase()
}

await mkdir(manifestRoot, { recursive: true })

const versionManifest = `PackageIdentifier: ${packageIdentifier}
PackageVersion: ${version}
DefaultLocale: en-US
ManifestType: version
ManifestVersion: ${manifestVersion}
`

const defaultLocaleManifest = `PackageIdentifier: ${packageIdentifier}
PackageVersion: ${version}
PackageLocale: en-US
Publisher: ${publisher}
PublisherUrl: https://github.com/silasxbt
PublisherSupportUrl: https://github.com/silasxbt/anti-api/issues
Author: ${publisher}
PackageName: ${packageName}
PackageUrl: https://github.com/silasxbt/anti-api
License: MIT
LicenseUrl: https://github.com/silasxbt/anti-api/blob/main/LICENSE
ShortDescription: Independent local protocol-compatibility proxy for authorized provider connections.
Description: Anti-API provides local OpenAI-compatible and Anthropic-compatible protocol translation, explicit account management, routing, and quota visibility for configured provider connections. It is independent and not provider-endorsed.
Moniker: anti-api
Tags:
- ai
- llm
- proxy
- openai
- anthropic
- codex
- copilot
- zed
ManifestType: defaultLocale
ManifestVersion: ${manifestVersion}
`

const installerManifest = `PackageIdentifier: ${packageIdentifier}
PackageVersion: ${version}
InstallerLocale: en-US
InstallerType: zip
NestedInstallerType: portable
NestedInstallerFiles:
- RelativeFilePath: anti-api/anti-api.exe
  PortableCommandAlias: anti-api
ReleaseDate: ${new Date().toISOString().slice(0, 10)}
Installers:
- Architecture: ${arch}
  InstallerUrl: ${installerUrl}
  InstallerSha256: ${sha256}
ManifestType: installer
ManifestVersion: ${manifestVersion}
`

await writeFile(join(manifestRoot, `${packageIdentifier}.yaml`), versionManifest, "utf8")
await writeFile(join(manifestRoot, `${packageIdentifier}.locale.en-US.yaml`), defaultLocaleManifest, "utf8")
await writeFile(join(manifestRoot, `${packageIdentifier}.installer.yaml`), installerManifest, "utf8")

console.log(`Updated WinGet manifests for ${version}`)
console.log(`Manifest directory: ${manifestRoot}`)
console.log(`Installer URL: ${installerUrl}`)
console.log(`Installer SHA256: ${sha256}`)
