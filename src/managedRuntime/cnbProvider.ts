import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import type { IncomingMessage } from "node:http";
import { request as httpsRequest, type RequestOptions as HttpsRequestOptions } from "node:https";
import { connect as netConnect } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { URL } from "node:url";
import { t } from "../localize";
import { parseManifest } from "./runtimeManifest";
import type { RuntimeAsset, RuntimeDownloadProvider, RuntimeManifest } from "./types";

const MAX_REDIRECTS = 5;
const CONNECT_TIMEOUT_MS = 10_000;
const MANIFEST_TOTAL_TIMEOUT_MS = 30_000;
const DOWNLOAD_TOTAL_TIMEOUT_MS = 10 * 60_000;
const MAX_MANIFEST_BYTES = 1024 * 1024;

interface RequestOptions {
    signal?: AbortSignal;
    connectTimeoutMs?: number;
    totalTimeoutMs?: number;
    maxRedirects?: number;
    /**
     * HTTP(S) proxy URL. When set, HTTPS requests are tunneled through the
     * proxy with CONNECT. Falls back to HTTPS_PROXY/HTTP_PROXY environment
     * variables (curl-style) when not provided.
     */
    proxy?: string;
}

interface DownloadOptions {
    signal?: AbortSignal;
    onProgress?: (received: number, total: number) => void;
    /** Total timeout for the response body phase. */
    totalTimeoutMs?: number;
}

/**
 * Resolve the proxy to use for a target host, mirroring curl semantics:
 * an explicitly configured proxy wins, otherwise HTTPS_PROXY / HTTP_PROXY
 * environment variables are honored and NO_PROXY entries are respected.
 */
function resolveProxy(targetHost: string, explicitProxy: string | undefined): string | undefined {
    const candidate = explicitProxy && explicitProxy.trim()
        ? explicitProxy.trim()
        : process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy;
    if (!candidate) {
        return undefined;
    }
    const value = candidate.trim();
    if (!value || value.toLowerCase() === "direct") {
        return undefined;
    }
    const noProxy = process.env.NO_PROXY ?? process.env.no_proxy;
    if (noProxy) {
        const entries = noProxy.split(",").map((entry) => entry.trim()).filter(Boolean);
        for (const entry of entries) {
            if (entry === "*") {
                return undefined;
            }
            const host = entry.startsWith(".") ? entry.slice(1) : entry;
            if (targetHost === host || targetHost.endsWith(`.${host}`)) {
                return undefined;
            }
        }
    }
    return value;
}

/**
 * Establish a TLS connection to `targetHost:targetPort` through an HTTP(S)
 * proxy using a CONNECT tunnel. The returned socket is fully handshaked.
 */
function establishTunnel(
    proxyValue: string,
    targetHost: string,
    targetPort: number,
    timeoutMs: number,
): Promise<TLSSocket> {
    return new Promise<TLSSocket>((resolve, reject) => {
        let proxy: URL;
        try {
            proxy = new URL(proxyValue.includes("://") ? proxyValue : `http://${proxyValue}`);
        } catch {
            reject(new Error(t("The HTTP proxy URL is invalid.")));
            return;
        }
        if (proxy.protocol !== "http:" && proxy.protocol !== "https:") {
            reject(new Error(t("Unsupported HTTP proxy protocol “{protocol}”.", { protocol: proxy.protocol })));
            return;
        }
        const proxyPort = Number(proxy.port) || (proxy.protocol === "https:" ? 443 : 80);
        const upstream = proxy.protocol === "https:"
            ? tlsConnect({ host: proxy.hostname, port: proxyPort, servername: proxy.hostname })
            : netConnect({ host: proxy.hostname, port: proxyPort, family: 4 });

        let settled = false;
        const timer = setTimeout(() => {
            fail(new Error(t("The connection timed out.")));
        }, timeoutMs);
        const fail = (error: unknown) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            upstream.destroy();
            reject(error instanceof Error ? error : new Error(String(error)));
        };

        upstream.once("error", (error) => {
            fail(error);
        });
        upstream.on("connect", () => {
            const credentials = proxy.username
                ? `Proxy-Authorization: Basic ${Buffer.from(
                      `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password || "")}`,
                  ).toString("base64")}\r\n`
                : "";
            upstream.write(
                `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n${credentials}\r\n`,
            );
        });

        let buffer = "";
        upstream.on("data", (chunk: Buffer) => {
            buffer += chunk.toString("latin1");
            const headerEnd = buffer.indexOf("\r\n\r\n");
            if (headerEnd < 0) {
                return;
            }
            const statusLine = buffer.slice(0, buffer.indexOf("\r\n"));
            const match = /^HTTP\/1\.[01] (\d{3})/u.exec(statusLine);
            if (!match || match[1] !== "200") {
                fail(new Error(t("The HTTP proxy refused the connection (HTTP {status}).", { status: match?.[1] ?? "???" })));
                return;
            }
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            upstream.removeAllListeners("data");
            const socket = tlsConnect({ socket: upstream, servername: targetHost, host: targetHost, port: targetPort });
            socket.once("error", (error) => {
                fail(error);
            });
            socket.once("secureConnect", () => {
                resolve(socket);
            });
        });
    });
}

/**
 * Perform an HTTPS GET following at most `maxRedirects` redirects and
 * enforcing connection / total timeouts. Resolves with the final response
 * for 2xx statuses. HTTP(S) proxies (explicit or from the environment) are
 * honored via a CONNECT tunnel, matching the behavior of curl.
 */
function httpGet(url: string, options: RequestOptions): Promise<IncomingMessage> {
    return new Promise<IncomingMessage>((resolve, reject) => {
        const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
        const connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
        const controller = new AbortController();

        const externalAbort = () => controller.abort();
        options.signal?.addEventListener("abort", externalAbort, { once: true });

        let totalTimer: NodeJS.Timeout | undefined;
        if (options.totalTimeoutMs !== undefined) {
            totalTimer = setTimeout(() => {
                controller.abort(new Error(t("The download timed out.")));
            }, options.totalTimeoutMs);
        }

        const settled = () => {
            options.signal?.removeEventListener("abort", externalAbort);
            if (totalTimer !== undefined) {
                clearTimeout(totalTimer);
            }
        };

        const attempt = async (currentUrl: string, redirectsLeft: number) => {
            let parsed: URL;
            try {
                parsed = new URL(currentUrl);
            } catch {
                settled();
                reject(new Error(t("The download URL is invalid.")));
                return;
            }
            if (parsed.protocol !== "https:") {
                settled();
                reject(new Error(t("Refusing to download over a non-HTTPS URL.")));
                return;
            }

            const requestOptions: HttpsRequestOptions = {
                protocol: parsed.protocol,
                hostname: parsed.hostname,
                port: parsed.port,
                path: `${parsed.pathname}${parsed.search}`,
                method: "GET",
                family: 4,
            };

            const handler = (res: IncomingMessage) => {
                const status = res.statusCode ?? 0;
                if (status >= 300 && status < 400 && res.headers.location) {
                    res.resume();
                    if (redirectsLeft <= 0) {
                        settled();
                        reject(new Error(t("Too many redirects while downloading.")));
                        return;
                    }
                    let next: string;
                    try {
                        next = new URL(res.headers.location, currentUrl).toString();
                    } catch {
                        settled();
                        reject(new Error(t("The download URL is invalid.")));
                        return;
                    }
                    void attempt(next, redirectsLeft - 1);
                    return;
                }
                if (status < 200 || status >= 300) {
                    res.resume();
                    settled();
                    reject(new Error(t("The server returned HTTP {status}.", { status })));
                    return;
                }
                settled();
                resolve(res);
            };

            const attachHooks = (req: import("node:http").ClientRequest) => {
                req.on("error", (error) => {
                    settled();
                    reject(error);
                });
                req.setTimeout(connectTimeoutMs, () => {
                    req.destroy(new Error(t("The connection timed out.")));
                });
                controller.signal.addEventListener(
                    "abort",
                    () => {
                        const reason = controller.signal.reason;
                        req.destroy(reason instanceof Error ? reason : new Error(t("The download was canceled.")));
                    },
                    { once: true },
                );
            };

            const proxy = resolveProxy(parsed.hostname, options.proxy);
            if (proxy) {
                let socket: TLSSocket;
                try {
                    socket = await establishTunnel(proxy, parsed.hostname, Number(parsed.port || 443), connectTimeoutMs);
                } catch (error) {
                    settled();
                    reject(error instanceof Error ? error : new Error(String(error)));
                    return;
                }
                if (controller.signal.aborted) {
                    socket.destroy();
                    settled();
                    const reason = controller.signal.reason;
                    reject(reason instanceof Error ? reason : new Error(t("The download was canceled.")));
                    return;
                }
                const req = httpsRequest({ ...requestOptions, createConnection: () => socket }, handler);
                attachHooks(req);
                req.end();
            } else {
                const req = httpsRequest(requestOptions, handler);
                attachHooks(req);
                req.end();
            }
        };

        void attempt(url, maxRedirects);
    });
}

function readBodyLimited(
    response: IncomingMessage,
    limitBytes: number,
    options: { signal?: AbortSignal; totalTimeoutMs?: number } = {},
): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let total = 0;
        let settled = false;
        const timer = options.totalTimeoutMs === undefined
            ? undefined
            : setTimeout(() => fail(new Error(t("The download timed out."))), options.totalTimeoutMs);
        const onAbort = () => {
            const reason = options.signal?.reason;
            fail(reason instanceof Error ? reason : new Error(t("The download was canceled.")));
        };
        const cleanup = () => {
            options.signal?.removeEventListener("abort", onAbort);
            if (timer !== undefined) clearTimeout(timer);
        };
        const fail = (error: unknown) => {
            if (settled) return;
            settled = true;
            cleanup();
            response.destroy();
            reject(error instanceof Error ? error : new Error(String(error)));
        };
        options.signal?.addEventListener("abort", onAbort, { once: true });
        response.on("data", (chunk: Buffer) => {
            if (settled) return;
            total += chunk.length;
            if (total > limitBytes) {
                fail(new Error(t("The server response exceeded the allowed size limit.")));
                return;
            }
            chunks.push(chunk);
        });
        response.on("error", fail);
        response.on("end", () => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(Buffer.concat(chunks).toString("utf8"));
        });
    });
}

/** Stream a response body to disk while hashing and enforcing the declared size. */
function streamResponseToFile(
    response: IncomingMessage,
    destination: string,
    declaredSize: number,
    options: DownloadOptions,
): Promise<{ sha256: string; size: number }> {
    return new Promise<{ sha256: string; size: number }>((resolve, reject) => {
        const hash = createHash("sha256");
        let received = 0;
        let failed = false;
        const writeStream = createWriteStream(destination);
        const totalTimer = setTimeout(() => {
            fail(new Error(t("The download timed out.")));
        }, options.totalTimeoutMs ?? DOWNLOAD_TOTAL_TIMEOUT_MS);

        const cleanup = () => {
            options.signal?.removeEventListener("abort", onAbort);
            clearTimeout(totalTimer);
        };

        const fail = (error: unknown) => {
            if (failed) {
                return;
            }
            failed = true;
            cleanup();
            response.destroy();
            writeStream.destroy();
            reject(error instanceof Error ? error : new Error(String(error)));
        };

        const onAbort = () => {
            const reason = options.signal?.reason;
            fail(reason instanceof Error ? reason : new Error(t("The download was canceled.")));
        };

        options.signal?.addEventListener("abort", onAbort, { once: true });
        writeStream.on("error", fail);
        response.on("error", fail);
        response.on("data", (chunk: Buffer) => {
            if (failed) {
                return;
            }
            received += chunk.length;
            if (received > declaredSize) {
                fail(new Error(t("The downloaded archive exceeded the size declared in the manifest.")));
                return;
            }
            hash.update(chunk);
            options.onProgress?.(received, declaredSize);
            writeStream.write(chunk);
        });
        response.on("end", () => {
            if (!failed) {
                writeStream.end();
            }
        });
        writeStream.on("finish", () => {
            cleanup();
            resolve({ sha256: hash.digest("hex"), size: received });
        });
    });
}

/**
 * CNB download provider. Fetches the release manifest and streams assets
 * from CNB releases. A future GithubRuntimeProvider can share this HTTP
 * layer and follow the same release asset naming.
 */
export class CnbRuntimeProvider implements RuntimeDownloadProvider {
    readonly kind = "cnb" as const;

    constructor(
        private readonly baseUrl: string,
        private readonly version: string,
        private readonly proxy?: string,
    ) {}

    async getManifest(version: string, signal?: AbortSignal): Promise<RuntimeManifest> {
        const response = await httpGet(this.assetUrl("manifest.json", version), {
            signal,
            totalTimeoutMs: MANIFEST_TOTAL_TIMEOUT_MS,
            maxRedirects: MAX_REDIRECTS,
            proxy: this.proxy,
        });
        const body = await readBodyLimited(response, MAX_MANIFEST_BYTES, {
            signal,
            totalTimeoutMs: MANIFEST_TOTAL_TIMEOUT_MS,
        });
        let raw: unknown;
        try {
            raw = JSON.parse(body);
        } catch {
            throw new Error(t("The Runtime manifest is not valid JSON."));
        }
        return parseManifest(raw);
    }

    async downloadAsset(
        asset: RuntimeAsset,
        destination: string,
        options: DownloadOptions = {},
    ): Promise<{ sha256: string; size: number }> {
        const response = await httpGet(this.assetUrl(asset.filename, this.version), {
            signal: options.signal,
            totalTimeoutMs: DOWNLOAD_TOTAL_TIMEOUT_MS,
            maxRedirects: MAX_REDIRECTS,
            proxy: this.proxy,
        });
        return streamResponseToFile(response, destination, asset.size, options);
    }

    private assetUrl(filename: string, version: string): string {
        return `${this.baseUrl}/-/releases/download/v${version}/${filename}`;
    }
}
