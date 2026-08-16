import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import type { IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
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
}

interface DownloadOptions {
    signal?: AbortSignal;
    onProgress?: (received: number, total: number) => void;
    /** Total timeout for the response body phase. */
    totalTimeoutMs?: number;
}

/**
 * Perform an HTTPS GET following at most `maxRedirects` redirects and
 * enforcing connection / total timeouts. Resolves with the final response
 * for 2xx statuses.
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

        const attempt = (currentUrl: string, redirectsLeft: number) => {
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

            const req = httpsRequest(parsed, { method: "GET" }, (res) => {
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
                    attempt(next, redirectsLeft - 1);
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
            });

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

        attempt(url, maxRedirects);
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
    ) {}

    async getManifest(version: string, signal?: AbortSignal): Promise<RuntimeManifest> {
        const response = await httpGet(this.assetUrl("manifest.json", version), {
            signal,
            totalTimeoutMs: MANIFEST_TOTAL_TIMEOUT_MS,
            maxRedirects: MAX_REDIRECTS,
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
        });
        return streamResponseToFile(response, destination, asset.size, options);
    }

    private assetUrl(filename: string, version: string): string {
        return `${this.baseUrl}/-/releases/download/v${version}/${filename}`;
    }
}
