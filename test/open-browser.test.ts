import { expect, test } from "bun:test"
import { getBrowserOpenCommand, openBrowser } from "../src/lib/open-browser"

test("browser opener uses native commands on each platform", () => {
    expect(getBrowserOpenCommand("https://example.com", "darwin")).toEqual({
        command: "open",
        args: ["https://example.com"],
    })
    expect(getBrowserOpenCommand("https://example.com", "win32")).toEqual({
        command: "rundll32",
        args: ["url.dll,FileProtocolHandler", "https://example.com"],
    })
    expect(getBrowserOpenCommand("https://example.com", "linux")).toEqual({
        command: "xdg-open",
        args: ["https://example.com"],
    })
})

test("browser opener can be disabled without spawning a shell", () => {
    const calls: string[][] = []
    const spawn = (command: string[]) => {
        calls.push(command)
    }

    expect(openBrowser("https://example.com", { platform: "win32", spawn })).toBe(true)
    expect(calls).toEqual([["rundll32", "url.dll,FileProtocolHandler", "https://example.com"]])
    expect(openBrowser("https://example.com", {
        platform: "darwin",
        env: { ANTI_API_NO_OPEN: "1" },
        spawn,
    })).toBe(false)
    expect(calls).toHaveLength(1)
})
