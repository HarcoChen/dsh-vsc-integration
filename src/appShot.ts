import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DshImageUpload } from "./types";
import { t } from "./localize";

const execFileAsync = promisify(execFile);

/** Captures a user-selected macOS application window as a one-shot image draft. */
export async function captureAppShot(): Promise<DshImageUpload | undefined> {
    if (process.platform !== "darwin") {
        throw new Error(t("AppShot is currently available only when the extension host runs on macOS."));
    }

    const path = join(tmpdir(), `dsh-appshot-${randomUUID()}.png`);
    try {
        // -i enables the native selector, -w restricts it to windows and -x omits the shutter sound.
        await execFileAsync("/usr/sbin/screencapture", ["-i", "-w", "-x", path]);
        try {
            const metadata = await stat(path);
            if (!metadata.isFile() || metadata.size === 0) return undefined;
        } catch (error) {
            const code = error && typeof error === "object" && "code" in error
                ? (error as { code?: unknown }).code
                : undefined;
            if (code === "ENOENT") return undefined;
            throw error;
        }
        const bytes = await readFile(path);
        const timestamp = new Date().toISOString().replace(/[:]/gu, "-");
        return {
            mediaType: "image/png",
            data: bytes.toString("base64"),
            name: `AppShot ${timestamp}.png`,
        };
    } finally {
        await rm(path, { force: true });
    }
}
