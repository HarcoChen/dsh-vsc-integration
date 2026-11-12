import { createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { createConnection } from "node:net";
import { spawn } from "node:child_process";
import { readdir, lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface DesktopGrant {
    url: string;
    runtimeVersion: string;
    key?: string;
}
export const DESKTOP_GRANT_SECRET = "dsh.desktopConnection";

export function validateDesktopUrl(value: string): string {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new Error("Invalid Desktop connection address");
    }
    if (
        !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) ||
        url.pathname !== "/" ||
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.hash ||
        url.searchParams.getAll("token").length > 1 ||
        /[\r\n\0]/u.test(url.searchParams.get("token") ?? "") ||
        (url.searchParams.get("token")?.length ?? 0) > 4096 ||
        [...url.searchParams.keys()].some((key) => key !== "token")
    ) {
        throw new Error("Desktop connections require a local connection address");
    }
    return url.href;
}

/** Compatible with dsh-vscode-connect's authenticated, encrypted native pairing protocol. */
export function resolveDesktopPairing(key: string, signal: AbortSignal, pipe?: string): Promise<string> {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(key)) return Promise.reject(new Error("Invalid Desktop pairing key"));
    const nonce = randomBytes(32).toString("hex");
    const time = Date.now();
    const secret = Buffer.from(key, "base64url");
    const mac = createHmac("sha256", secret).update(`request:${nonce}:${time}`).digest("hex");
    const address = pipe ?? String.raw`\\.\pipe\dsh-vscode-${createHash("sha256").update(key).digest("hex")}`;
    return new Promise((resolve, reject) => {
        signal.throwIfAborted();
        const socket = createConnection(address);
        let input = "";
        let settled = false;
        const done = (error?: Error, url?: string): void => {
            if (settled) return;
            settled = true;
            signal.removeEventListener("abort", abort);
            socket.destroy();
            if (error) reject(error);
            else resolve(url!);
        };
        const abort = (): void => done(new Error("Desktop connection cancelled"));
        signal.addEventListener("abort", abort, { once: true });
        socket.setTimeout(3000, () => done(new Error("Desktop pairing timed out")));
        socket.on("error", () => done(new Error("Desktop pairing is unavailable")));
        socket.on("end", () => {
            if (!settled) done(new Error("Desktop pairing ended without an address"));
        });
        socket.on("connect", () => socket.write(JSON.stringify({ nonce, time, mac }) + "\n"));
        socket.on("data", (chunk) => {
            input += chunk.toString("utf8");
            if (input.length > 16_384) {
                done(new Error("Invalid Desktop pairing response"));
                return;
            }
            if (!input.includes("\n")) return;
            try {
                const value = JSON.parse(input.slice(0, input.indexOf("\n")));
                if (
                    !/^[a-f0-9]{24}$/u.test(value.iv) ||
                    !/^[a-f0-9]{32}$/u.test(value.tag) ||
                    typeof value.body !== "string" ||
                    value.body.length % 2 ||
                    !/^[a-f0-9]+$/u.test(value.body)
                )
                    throw new Error();
                const cipher = createDecipheriv("aes-256-gcm", secret, Buffer.from(value.iv, "hex"));
                cipher.setAAD(Buffer.from(nonce));
                cipher.setAuthTag(Buffer.from(value.tag, "hex"));
                const result = JSON.parse(
                    Buffer.concat([cipher.update(Buffer.from(value.body, "hex")), cipher.final()]).toString("utf8")
                );
                if (result.nonce !== nonce || typeof result.url !== "string") throw new Error();
                done(undefined, validateDesktopUrl(result.url));
            } catch {
                done(new Error("Desktop pairing response failed authentication"));
            }
        });
    });
}

function unprotectBootstrap(protectedKey: string, signal: AbortSignal): Promise<string> {
    const script =
        "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $text=[Console]::In.ReadToEnd(); $entropy=[Text.Encoding]::UTF8.GetBytes('dsh-vscode-connect.bootstrap.v1'); [Console]::Out.Write([Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($text),$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)))";
    return new Promise((resolve, reject) => {
        const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
            windowsHide: true,
            stdio: ["pipe", "pipe", "ignore"],
            signal,
            timeout: 5000,
        });
        let output = "";
        child.stdout.on("data", (chunk) => {
            output += chunk.toString("utf8");
            if (output.length > 16_384) child.kill();
        });
        child.stdin.on("error", () => {});
        child.on("error", () => reject(new Error("Windows Desktop discovery is unavailable")));
        child.on("close", (code) => {
            try {
                const value = JSON.parse(output);
                if (code !== 0 || value.version !== 1 || !/^[A-Za-z0-9_-]{43}$/u.test(value.key)) throw new Error();
                resolve(value.key);
            } catch {
                reject(new Error("Windows Desktop discovery could not read a valid grant"));
            }
        });
        child.stdin.end(protectedKey);
    });
}

export async function discoverDesktopKeys(signal: AbortSignal): Promise<string[]> {
    if (process.platform !== "win32") return [];
    const directory = join(
        process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
        "dsh-vscode-connect",
        "instances"
    );
    const keys = new Set<string>();
    const names = (await readdir(directory).catch(() => [] as string[]))
        .filter((name) => /^\d+-[a-f0-9]{24}\.json$/u.test(name))
        .sort()
        .reverse()
        .slice(0, 16);
    for (const name of names) {
        signal.throwIfAborted();
        try {
            const path = join(directory, name);
            const stat = await lstat(path);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32_768 || Date.now() - stat.mtimeMs > 15_000)
                continue;
            const value = JSON.parse(await readFile(path, "utf8"));
            if (
                value.version !== 1 ||
                !Number.isSafeInteger(value.pid) ||
                value.pid <= 0 ||
                typeof value.protectedKey !== "string" ||
                !/^[A-Za-z0-9+/=]{32,16384}$/u.test(value.protectedKey)
            )
                continue;
            process.kill(value.pid, 0);
            keys.add(await unprotectBootstrap(value.protectedKey, signal));
        } catch {
            signal.throwIfAborted();
        }
    }
    return [...keys];
}
