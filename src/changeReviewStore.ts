import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { SessionStateSnapshot } from "./sessionStore";
import { t } from "./localize";
import { ChangeReviewView } from "./types";
import { isRecord } from "./guards";
import { containsPath } from "./paths";
import { errorMessage } from "./errors";

const execFileAsync = promisify(execFile);
const REGULAR_MODES = new Set(["100644", "100755"]);

type ChangeStatus = "added" | "modified" | "deleted" | "renamed";

interface GitContext {
    cwd: string;
    tempRoot: string;
    env: NodeJS.ProcessEnv;
}

interface ChangeFile {
    id: string;
    status: ChangeStatus;
    path: string;
    oldPath?: string;
    oldBlob: string;
    newBlob: string;
    oldMode: string;
    newMode: string;
    restorable: boolean;
    newWorkingHash?: string;
}

interface ChangeReview {
    turn: number;
    state: "capturing" | "ready" | "error";
    files: ChangeFile[];
    restored: boolean;
    error?: string;
    beforeTree?: string;
    afterTree?: string;
    git?: GitContext;
}

interface SessionReviews {
    cwd: string;
    seen: Set<string>;
    reviews: Map<number, ChangeReview>;
    queue: Promise<void>;
}

interface VirtualDocument {
    git: GitContext;
    blob?: string;
}

function eventTurn(value: unknown): number | undefined {
    if (!isRecord(value) || typeof value.turn !== "number") return undefined;
    return Number.isSafeInteger(value.turn) && value.turn > 0 ? value.turn : undefined;
}

function isNullBlob(hash: string): boolean {
    return /^0+$/u.test(hash);
}

function parseRawDiff(output: Buffer): ChangeFile[] {
    const fields = output.toString("utf8").split("\0");
    const files: ChangeFile[] = [];
    for (let index = 0; index < fields.length;) {
        const header = fields[index++];
        if (!header) continue;
        const match = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])(\d*)$/u.exec(header);
        if (!match) throw new Error(t("Git returned an unsupported change record."));
        const [, oldMode, newMode, oldBlob, newBlob, kind] = match;
        const firstPath = fields[index++];
        if (!firstPath) throw new Error(t("Git returned a change without a path."));
        const secondPath = kind === "R" ? fields[index++] : undefined;
        if (kind === "R" && !secondPath) throw new Error(t("Git returned an invalid rename record."));
        const status: ChangeStatus =
            kind === "A" ? "added" :
            kind === "M" || kind === "T" ? "modified" :
            kind === "D" ? "deleted" :
            kind === "R" ? "renamed" :
            (() => { throw new Error(t("Git returned an unsupported change type: {type}", { type: kind })); })();
        files.push({
            id: randomUUID(),
            status,
            path: secondPath ?? firstPath,
            ...(secondPath ? { oldPath: firstPath } : {}),
            oldBlob,
            newBlob,
            oldMode,
            newMode,
            restorable:
                (isNullBlob(oldBlob) || REGULAR_MODES.has(oldMode)) &&
                (isNullBlob(newBlob) || REGULAR_MODES.has(newMode)),
        });
    }
    return files;
}

async function runGit(
    git: GitContext,
    args: readonly string[],
    encoding: BufferEncoding | "buffer" = "utf8",
): Promise<string | Buffer> {
    const result = await execFileAsync("git", [...args], {
        cwd: git.cwd,
        env: git.env,
        encoding: encoding === "buffer" ? "buffer" : encoding,
        maxBuffer: 32 * 1024 * 1024,
    });
    return result.stdout;
}

async function readBlob(git: GitContext, hash: string): Promise<Buffer> {
    if (isNullBlob(hash)) return Buffer.alloc(0);
    return await runGit(git, ["cat-file", "blob", hash], "buffer") as Buffer;
}

async function readWorktreeBlob(git: GitContext, hash: string, filePath: string): Promise<Buffer> {
    return await runGit(git, ["cat-file", "--filters", `--path=${filePath}`, hash], "buffer") as Buffer;
}

function workingHash(content: Buffer): string {
    return createHash("sha256").update(content).digest("hex");
}

export class ChangeReviewStore implements vscode.Disposable, vscode.TextDocumentContentProvider {
    private readonly sessions = new Map<string, SessionReviews>();
    private readonly listeners = new Set<() => void>();
    private readonly documents = new Map<string, VirtualDocument>();
    private readonly tempRoots = new Set<string>();
    private readonly registration: vscode.Disposable;
    private disposed = false;

    public constructor(private readonly output: vscode.OutputChannel) {
        this.registration = vscode.workspace.registerTextDocumentContentProvider("dsh-change", this);
    }

    public onDidUpdate(listener: () => void): vscode.Disposable {
        this.listeners.add(listener);
        return new vscode.Disposable(() => this.listeners.delete(listener));
    }

    public observe(sessionId: string, cwd: string | undefined, snapshot: SessionStateSnapshot): void {
        if (this.disposed || !cwd) return;
        let session = this.sessions.get(sessionId);
        if (!session) {
            session = { cwd, seen: new Set(), reviews: new Map(), queue: Promise.resolve() };
            this.sessions.set(sessionId, session);
        }
        if (session.cwd !== cwd) return;

        for (const stored of snapshot.events) {
            if (stored.source !== "live" ||
                (stored.event.type !== "turn/start" && stored.event.type !== "turn/end")) continue;
            const turn = eventTurn(stored.event.data);
            if (turn === undefined) continue;
            const key = `${stored.event.seq}:${stored.event.type}`;
            if (session.seen.has(key)) continue;
            session.seen.add(key);
            if (stored.event.type === "turn/start") {
                session.reviews.set(turn, {
                    turn,
                    state: "capturing",
                    files: [],
                    restored: false,
                });
                this.emit();
                session.queue = session.queue.then(() => this.captureBefore(sessionId, turn));
            } else {
                session.queue = session.queue.then(() => this.captureAfter(sessionId, turn));
            }
            session.queue = session.queue.catch((error) => {
                this.failReview(sessionId, turn, error);
            });
        }
    }

    public view(sessionId: string | undefined): ChangeReviewView[] {
        if (!sessionId) return [];
        return [...(this.sessions.get(sessionId)?.reviews.values() ?? [])]
            .sort((left, right) => right.turn - left.turn)
            .map((review) => ({
                turn: review.turn,
                state: review.state,
                files: review.files.map((file) => ({
                    id: file.id,
                    status: file.status,
                    path: file.path,
                    ...(file.oldPath ? { oldPath: file.oldPath } : {}),
                    restorable: file.restorable,
                })),
                restored: review.restored,
                ...(review.error ? { error: review.error } : {}),
            }));
    }

    public async openDiff(sessionId: string, turn: number, fileId: string): Promise<void> {
        const review = this.review(sessionId, turn);
        const file = review.files.find((candidate) => candidate.id === fileId);
        if (!file || !review.git || review.state !== "ready") {
            throw new Error(t("This change is no longer available."));
        }
        const before = await readBlob(review.git, file.oldBlob);
        const after = await readBlob(review.git, file.newBlob);
        if (before.includes(0) || after.includes(0)) {
            void vscode.window.showWarningMessage(t("VS Code cannot display this binary change as a text diff."));
            return;
        }
        const beforeUri = this.documentUri(review.git, isNullBlob(file.oldBlob) ? undefined : file.oldBlob, file.oldPath ?? file.path);
        const afterUri = this.documentUri(review.git, isNullBlob(file.newBlob) ? undefined : file.newBlob, file.path);
        const title = file.status === "renamed"
            ? t("Turn {turn}: {oldPath} → {path}", { turn, oldPath: file.oldPath ?? file.path, path: file.path })
            : t("Turn {turn}: {path}", { turn, path: file.path });
        await vscode.commands.executeCommand("vscode.diff", beforeUri, afterUri, title, { preview: true });
    }

    /**
     * Restore the files changed by a completed turn.
     *
     * Returns false when the user cancels the confirmation, which lets a
     * compound checkpoint action avoid creating a fork after only half of the
     * requested operation was performed.
     */
    public async restore(sessionId: string, turn: number): Promise<boolean> {
        const review = this.review(sessionId, turn);
        if (review.state !== "ready" || review.restored || !review.git || !review.files.length ||
            review.files.some((file) => !file.restorable)) {
            throw new Error(t("This turn cannot be restored."));
        }
        const conflicts = await this.conflicts(review);
        if (conflicts.length) throw new Error(this.conflictMessage(conflicts));
        const action = t("Restore changes");
        const confirmation = await vscode.window.showWarningMessage(
            t("Restore all {count} file changes from turn {turn}? This cannot be undone by DSH.", {
                count: review.files.length,
                turn,
            }),
            { modal: true },
            action,
        );
        if (confirmation !== action) return false;
        const contents = await this.prepareRestore(review);
        const latestConflicts = await this.conflicts(review);
        if (latestConflicts.length) throw new Error(this.conflictMessage(latestConflicts));
        await this.applyRestore(review, contents);
        review.restored = true;
        this.emit();
        void vscode.window.showInformationMessage(t("Restored changes from turn {turn}.", { turn }));
        return true;
    }

    public async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        const token = uri.path.split("/").filter(Boolean)[0];
        const document = token ? this.documents.get(token) : undefined;
        if (!document) throw new Error(t("This change document has expired."));
        return document.blob ? (await readBlob(document.git, document.blob)).toString("utf8") : "";
    }

    public dispose(): void {
        this.disposed = true;
        this.registration.dispose();
        this.listeners.clear();
        this.documents.clear();
        this.sessions.clear();
        for (const root of this.tempRoots) {
            void fs.rm(root, { recursive: true, force: true }).catch((error) => {
                this.output.appendLine(`[dsh:changes] cleanup failed: ${errorMessage(error)}`);
            });
        }
        this.tempRoots.clear();
    }

    private async captureBefore(sessionId: string, turn: number): Promise<void> {
        const session = this.sessions.get(sessionId);
        const review = session?.reviews.get(turn);
        if (!session || !review || review.state !== "capturing") return;
        const git = await this.createGitContext(session.cwd);
        if (!git) {
            session.reviews.delete(turn);
            this.emit();
            return;
        }
        review.git = git;
        review.beforeTree = await this.captureTree(git);
    }

    private async captureAfter(sessionId: string, turn: number): Promise<void> {
        const review = this.sessions.get(sessionId)?.reviews.get(turn);
        if (!review || review.state !== "capturing" || !review.git || !review.beforeTree) return;
        review.afterTree = await this.captureTree(review.git);
        const raw = await runGit(review.git, [
            "diff", "--raw", "-z", "-M", "--no-abbrev", review.beforeTree, review.afterTree, "--", ".",
        ], "buffer") as Buffer;
        review.files = parseRawDiff(raw);
        await this.captureWorkingHashes(review);
        review.state = "ready";
        this.emit();
    }

    private async createGitContext(cwd: string): Promise<GitContext | undefined> {
        const realCwd = await fs.realpath(cwd);
        let workspaceContainsCwd = false;
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            const workspaceRoot = await fs.realpath(folder.uri.fsPath);
            if (containsPath(workspaceRoot, realCwd)) {
                workspaceContainsCwd = true;
                break;
            }
        }
        if (!workspaceContainsCwd) {
            throw new Error(t("The session workspace is outside the open VS Code workspace."));
        }
        let root: string;
        let objectPath: string;
        try {
            root = (await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
                cwd: realCwd,
                encoding: "utf8",
            })).stdout.trim();
            objectPath = (await execFileAsync("git", ["rev-parse", "--git-path", "objects"], {
                cwd: realCwd,
                encoding: "utf8",
            })).stdout.trim();
        } catch {
            return undefined;
        }
        const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dsh-changes-"));
        this.tempRoots.add(tempRoot);
        if (this.disposed) {
            this.tempRoots.delete(tempRoot);
            await fs.rm(tempRoot, { recursive: true, force: true });
            throw new Error(t("This change review is no longer available."));
        }
        const alternateObjects = path.resolve(root, objectPath);
        const objectDirectory = path.join(tempRoot, "objects");
        await fs.mkdir(objectDirectory);
        return {
            cwd: realCwd,
            tempRoot,
            env: {
                ...process.env,
                GIT_INDEX_FILE: path.join(tempRoot, "index"),
                GIT_OBJECT_DIRECTORY: objectDirectory,
                GIT_ALTERNATE_OBJECT_DIRECTORIES: alternateObjects,
            },
        };
    }

    private async captureTree(git: GitContext): Promise<string> {
        try {
            await runGit(git, ["rev-parse", "--verify", "HEAD"]);
        } catch {
            await runGit(git, ["read-tree", "--empty"]);
            await runGit(git, ["add", "-A", "--", "."]);
            return (await runGit(git, ["write-tree"]) as string).trim();
        }
        await runGit(git, ["read-tree", "HEAD"]);
        await runGit(git, ["add", "-A", "--", "."]);
        return (await runGit(git, ["write-tree"]) as string).trim();
    }

    private failReview(sessionId: string, turn: number, error: unknown): void {
        const review = this.sessions.get(sessionId)?.reviews.get(turn);
        if (!review) return;
        review.state = "error";
        review.error = t("Unable to capture file changes: {message}", { message: errorMessage(error) });
        this.output.appendLine(`[dsh:changes] session ${sessionId} turn ${turn}: ${errorMessage(error)}`);
        this.emit();
    }

    private review(sessionId: string, turn: number): ChangeReview {
        const review = this.sessions.get(sessionId)?.reviews.get(turn);
        if (!review) throw new Error(t("This change review is no longer available."));
        return review;
    }

    private documentUri(git: GitContext, blob: string | undefined, filePath: string): vscode.Uri {
        const token = randomUUID();
        this.documents.set(token, { git, ...(blob ? { blob } : {}) });
        return vscode.Uri.from({
            scheme: "dsh-change",
            path: `/${token}/${path.basename(filePath)}`,
        });
    }

    private resolvePath(review: ChangeReview, relativePath: string): string {
        if (!review.git || path.isAbsolute(relativePath)) throw new Error(t("The change path is invalid."));
        const candidate = path.resolve(review.git.cwd, relativePath);
        if (!containsPath(review.git.cwd, candidate)) throw new Error(t("The change path is outside the session workspace."));
        return candidate;
    }

    private async assertSafeParents(review: ChangeReview, relativePath: string): Promise<void> {
        if (!review.git) throw new Error(t("This change review is no longer available."));
        const target = this.resolvePath(review, relativePath);
        let current = path.dirname(target);
        while (current !== review.git.cwd) {
            let stat;
            try {
                stat = await fs.lstat(current);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                    current = path.dirname(current);
                    continue;
                }
                throw error;
            }
            if (stat.isSymbolicLink() || !stat.isDirectory()) {
                throw new Error(t("A parent path is not a real directory: {path}", { path: relativePath }));
            }
            current = path.dirname(current);
        }
    }

    private async matchesFile(review: ChangeReview, relativePath: string, blob: string, mode: string): Promise<boolean> {
        await this.assertSafeParents(review, relativePath);
        const target = this.resolvePath(review, relativePath);
        try {
            const stat = await fs.lstat(target);
            if (!stat.isFile() || stat.isSymbolicLink()) return false;
            if ((mode === "100755") !== ((stat.mode & 0o111) !== 0)) return false;
            const expected = review.files.find(
                (file) => file.path === relativePath && file.newBlob === blob,
            )?.newWorkingHash;
            return expected !== undefined && workingHash(await fs.readFile(target)) === expected;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
            throw error;
        }
    }

    private async isAbsent(review: ChangeReview, relativePath: string): Promise<boolean> {
        await this.assertSafeParents(review, relativePath);
        try {
            await fs.lstat(this.resolvePath(review, relativePath));
            return false;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
            throw error;
        }
    }

    private async conflicts(review: ChangeReview): Promise<string[]> {
        const conflicts: string[] = [];
        for (const file of review.files) {
            let valid = false;
            if (file.status === "deleted") {
                valid = await this.isAbsent(review, file.path);
            } else if (file.status === "renamed") {
                valid = Boolean(file.oldPath) &&
                    await this.isAbsent(review, file.oldPath as string) &&
                    await this.matchesFile(review, file.path, file.newBlob, file.newMode);
            } else {
                valid = await this.matchesFile(review, file.path, file.newBlob, file.newMode);
            }
            if (!valid) conflicts.push(file.status === "renamed" && file.oldPath
                ? `${file.oldPath} → ${file.path}`
                : file.path);
        }
        return conflicts;
    }

    private async captureWorkingHashes(review: ChangeReview): Promise<void> {
        if (!review.git) throw new Error(t("This change review is no longer available."));
        for (const file of review.files) {
            if (isNullBlob(file.newBlob) || !REGULAR_MODES.has(file.newMode)) continue;
            await this.assertSafeParents(review, file.path);
            const target = this.resolvePath(review, file.path);
            const stat = await fs.lstat(target);
            if (!stat.isFile() || stat.isSymbolicLink()) {
                throw new Error(t("A changed path stopped being a regular file during capture: {path}", { path: file.path }));
            }
            const content = await fs.readFile(target);
            const currentBlob = (await runGit(review.git, [
                "hash-object", `--path=${file.path}`, "--", file.path,
            ]) as string).trim();
            if (currentBlob !== file.newBlob) {
                throw new Error(t("The workspace changed while turn {turn} was being captured.", { turn: review.turn }));
            }
            file.newWorkingHash = workingHash(content);
        }
    }

    private conflictMessage(conflicts: readonly string[]): string {
        const shown = conflicts.slice(0, 5).join(", ");
        const remaining = conflicts.length > 5 ? t(" and {count} more", { count: conflicts.length - 5 }) : "";
        return t("Restore stopped because these paths changed after the task: {paths}{remaining}", {
            paths: shown,
            remaining,
        });
    }

    private async prepareRestore(review: ChangeReview): Promise<Map<string, Buffer>> {
        if (!review.git) throw new Error(t("This change review is no longer available."));
        const contents = new Map<string, Buffer>();
        for (const file of review.files) {
            if (file.status === "added") continue;
            contents.set(
                file.id,
                await readWorktreeBlob(review.git, file.oldBlob, file.oldPath ?? file.path),
            );
        }
        return contents;
    }

    private async applyRestore(review: ChangeReview, contents: ReadonlyMap<string, Buffer>): Promise<void> {
        for (const file of review.files) {
            if (file.status === "renamed") {
                await this.writeOldFile(review, file.oldPath as string, file, contents.get(file.id));
                continue;
            }
            if (file.status !== "added") {
                await this.writeOldFile(review, file.path, file, contents.get(file.id));
            }
        }
        for (const file of review.files) {
            if (file.status === "added" || file.status === "renamed") {
                await fs.unlink(this.resolvePath(review, file.path));
            }
        }
    }

    private async writeOldFile(
        review: ChangeReview,
        relativePath: string,
        file: ChangeFile,
        content: Buffer | undefined,
    ): Promise<void> {
        if (!content) throw new Error(t("The restore content is no longer available."));
        const target = this.resolvePath(review, relativePath);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(
            target,
            content,
            { mode: file.oldMode === "100755" ? 0o755 : 0o644 },
        );
        await fs.chmod(target, file.oldMode === "100755" ? 0o755 : 0o644);
    }

    private emit(): void {
        for (const listener of this.listeners) listener();
    }
}
