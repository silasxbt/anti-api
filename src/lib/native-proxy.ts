/**
 * Native Outbound Proxy Bridge
 * Enables native SOCKS5/SOCKS5h and HTTP proxy support in Bun/Node.
 */

import http from "node:http"
import net from "node:net"
import consola from "consola"

let bridgeServer: http.Server | null = null

export function initNativeProxy(): void {
    const rawProxy = (
        process.env.ANTI_API_PROXY ||
        process.env.ALL_PROXY ||
        process.env.all_proxy ||
        process.env.HTTPS_PROXY ||
        process.env.https_proxy ||
        process.env.HTTP_PROXY ||
        process.env.http_proxy
    )?.trim()

    if (!rawProxy) {
        return
    }

    try {
        const parsed = new URL(rawProxy)
        const protocol = parsed.protocol.replace(/:$/, "").toLowerCase()

        if (protocol === "socks5" || protocol === "socks5h") {
            startSocks5Bridge(parsed, rawProxy)
        } else if (protocol === "http" || protocol === "https") {
            process.env.HTTP_PROXY = rawProxy
            process.env.HTTPS_PROXY = rawProxy
            process.env.http_proxy = rawProxy
            process.env.https_proxy = rawProxy
            consola.success(`Native HTTP proxy configured: ${rawProxy}`)
        } else {
            consola.warn(`Unsupported proxy protocol "${protocol}": ${rawProxy}`)
        }
    } catch (err: any) {
        consola.error(`Failed to parse proxy URL "${rawProxy}":`, err?.message || err)
    }
}

function startSocks5Bridge(proxyUrl: URL, displayUrl: string): void {
    const socksHost = proxyUrl.hostname
    const socksPort = Number(proxyUrl.port) || 1080
    const username = proxyUrl.username ? decodeURIComponent(proxyUrl.username) : undefined
    const password = proxyUrl.password ? decodeURIComponent(proxyUrl.password) : undefined

    bridgeServer = http.createServer((req, res) => {
        // Plain HTTP requests forwarding
        try {
            if (!req.url) {
                res.writeHead(400).end()
                return
            }
            const targetUrl = new URL(req.url)
            const targetHost = targetUrl.hostname
            const targetPort = Number(targetUrl.port) || 80

            dialSocks5(socksHost, socksPort, targetHost, targetPort, username, password, (err, socksSocket) => {
                if (err || !socksSocket) {
                    res.writeHead(502).end("Bad Gateway")
                    return
                }

                const rawRequest = `${req.method} ${targetUrl.pathname}${targetUrl.search} HTTP/1.1\r\nHost: ${targetUrl.host}\r\n`
                let headersStr = ""
                for (let i = 0; i < req.rawHeaders.length; i += 2) {
                    const key = req.rawHeaders[i]
                    const val = req.rawHeaders[i + 1]
                    if (key.toLowerCase() !== "proxy-connection") {
                        headersStr += `${key}: ${val}\r\n`
                    }
                }
                socksSocket.write(rawRequest + headersStr + "\r\n")
                req.pipe(socksSocket)
                socksSocket.pipe(res)

                socksSocket.on("error", () => res.writeHead(502).end())
            })
        } catch {
            res.writeHead(502).end("Bad Gateway")
        }
    })

    // HTTPS CONNECT tunneling
    bridgeServer.on("connect", (req, clientSocket, head) => {
        const [targetHost, targetPortStr] = (req.url || "").split(":")
        const targetPort = Number(targetPortStr) || 443

        dialSocks5(socksHost, socksPort, targetHost, targetPort, username, password, (err, socksSocket) => {
            if (err || !socksSocket) {
                clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n")
                clientSocket.end()
                return
            }

            clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
            if (head && head.length > 0) {
                socksSocket.write(head)
            }
            clientSocket.pipe(socksSocket)
            socksSocket.pipe(clientSocket)

            socksSocket.on("error", () => clientSocket.end())
            clientSocket.on("error", () => socksSocket.end())
        })
    })

    bridgeServer.on("error", (err) => {
        consola.error("SOCKS5 bridge error:", err)
    })

    bridgeServer.listen(0, "127.0.0.1", () => {
        const addr = bridgeServer?.address() as net.AddressInfo
        const localPort = addr?.port
        if (localPort) {
            const localHttpProxy = `http://127.0.0.1:${localPort}`
            process.env.HTTP_PROXY = localHttpProxy
            process.env.HTTPS_PROXY = localHttpProxy
            process.env.http_proxy = localHttpProxy
            process.env.https_proxy = localHttpProxy
            
            // Set NO_PROXY for internal addresses
            const existingNoProxy = process.env.NO_PROXY || process.env.no_proxy || ""
            const standardNoProxy = "localhost,127.0.0.1,::1"
            process.env.NO_PROXY = existingNoProxy ? `${standardNoProxy},${existingNoProxy}` : standardNoProxy
            process.env.no_proxy = process.env.NO_PROXY

            consola.success(`Native SOCKS5 proxy active: routing all outbound traffic via ${displayUrl} (bridge: ${localHttpProxy})`)
        }
        bridgeServer?.unref()
    })
}

function dialSocks5(
    socksHost: string,
    socksPort: number,
    targetHost: string,
    targetPort: number,
    username: string | undefined,
    password: string | undefined,
    callback: (err: Error | null, socket: net.Socket | null) => void
): void {
    const s = net.connect({ host: socksHost, port: socksPort }, () => {
        // Step 1: Greeting
        if (username && password) {
            s.write(Buffer.from([0x05, 0x02, 0x00, 0x02])) // Methods: No Auth (0x00) & User/Pass (0x02)
        } else {
            s.write(Buffer.from([0x05, 0x01, 0x00])) // Method: No Auth (0x00)
        }

        s.once("data", (greetingResp) => {
            if (greetingResp[0] !== 0x05) {
                s.destroy()
                return callback(new Error("Invalid SOCKS5 version"), null)
            }

            const chosenMethod = greetingResp[1]
            if (chosenMethod === 0x02 && username && password) {
                // User/Password Auth subnegotiation (RFC 1929)
                const uBuf = Buffer.from(username)
                const pBuf = Buffer.from(password)
                const authReq = Buffer.concat([
                    Buffer.from([0x01, uBuf.length]),
                    uBuf,
                    Buffer.from([pBuf.length]),
                    pBuf,
                ])
                s.write(authReq)
                s.once("data", (authResp) => {
                    if (authResp[1] !== 0x00) {
                        s.destroy()
                        return callback(new Error("SOCKS5 auth failed"), null)
                    }
                    sendConnectRequest(s, targetHost, targetPort, callback)
                })
            } else if (chosenMethod === 0x00) {
                sendConnectRequest(s, targetHost, targetPort, callback)
            } else {
                s.destroy()
                return callback(new Error(`Unsupported SOCKS5 auth method: ${chosenMethod}`), null)
            }
        })
    })

    s.on("error", (err) => {
        callback(err, null)
    })
}

function sendConnectRequest(
    s: net.Socket,
    targetHost: string,
    targetPort: number,
    callback: (err: Error | null, socket: net.Socket | null) => void
): void {
    const hostBuf = Buffer.from(targetHost)
    // SOCKS5 CONNECT: CMD=0x01, RSV=0x00, ATYP=0x03 (Domain Name)
    const connectReq = Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
        hostBuf,
        Buffer.from([targetPort >> 8, targetPort & 0xff]),
    ])

    s.write(connectReq)
    s.once("data", (connectResp) => {
        if (connectResp[1] !== 0x00) {
            s.destroy()
            return callback(new Error(`SOCKS5 connect error: 0x${connectResp[1].toString(16)}`), null)
        }
        callback(null, s)
    })
}
