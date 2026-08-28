const assert = require("node:assert/strict");
const test = require("node:test");
const { constants } = require("node:fs");
const { access, mkdtemp, readFile, rm, stat, writeFile } = require("node:fs/promises");
const { gzipSync } = require("node:zlib");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { extractArchive } = require("../dist/managedRuntime/runtimeInstaller");

const BLOCK = 512;

/**
 * Build a tar in the GNU format that Linux tar produces, which is what the
 * release pipeline uses. Entries whose name exceeds 100 bytes get an "L"
 * long-name header whose payload length includes the NUL terminator.
 */
function gnuTar(entries) {
    const blocks = [];

    const header = (name, { size = 0, mode = 0o644, typeFlag = "0" }) => {
        const block = Buffer.alloc(BLOCK);
        block.write(name.slice(0, 100), 0, "utf8");
        block.write(mode.toString(8).padStart(7, "0") + "\0", 100, "utf8");
        block.write("0000000\0", 108, "utf8"); // uid
        block.write("0000000\0", 116, "utf8"); // gid
        block.write(size.toString(8).padStart(11, "0") + "\0", 124, "utf8");
        block.write("00000000000\0", 136, "utf8"); // mtime
        block.write(typeFlag, 156, "utf8");
        block.write("ustar  \0", 257, "utf8"); // GNU magic
        block.write("        ", 148, "utf8"); // checksum placeholder
        let sum = 0;
        for (const byte of block) sum += byte;
        block.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "utf8");
        return block;
    };

    const payload = (buffer) => {
        const padded = Buffer.alloc(Math.ceil(buffer.length / BLOCK) * BLOCK);
        buffer.copy(padded);
        return padded;
    };

    for (const entry of entries) {
        const body = entry.body === undefined ? Buffer.alloc(0) : Buffer.from(entry.body, "utf8");
        if (Buffer.byteLength(entry.name) > 100) {
            // GNU tar counts the terminating NUL in the long-name entry size.
            const nameBuffer = Buffer.from(entry.name + "\0", "utf8");
            blocks.push(header("././@LongLink", { size: nameBuffer.length, typeFlag: "L" }));
            blocks.push(payload(nameBuffer));
        }
        blocks.push(header(entry.name, { size: body.length, mode: entry.mode, typeFlag: entry.typeFlag ?? "0" }));
        if (body.length > 0) blocks.push(payload(body));
    }

    // End-of-archive marker: two zero-filled blocks.
    blocks.push(Buffer.alloc(BLOCK * 2));
    return Buffer.concat(blocks);
}

const LONG_NAME =
    "dsh-runtime/app/node_modules/@deepseek-ai/dsh-session-title-first-prompt-llm/lib/types/invariant.d.ts";

async function extractFixture(entries) {
    const dir = await mkdtemp(join(tmpdir(), "dsh-installer-test-"));
    const archive = join(dir, "runtime.tar.gz");
    await writeFile(archive, gzipSync(gnuTar(entries)));
    const staging = join(dir, "staging");
    await extractArchive(archive, staging, "darwin-arm64");
    return { dir, staging };
}

function runtimeFixture(extra = []) {
    return [
        { name: "dsh-runtime/", typeFlag: "5", mode: 0o755 },
        { name: "dsh-runtime/bin/", typeFlag: "5", mode: 0o755 },
        { name: "dsh-runtime/app/node_modules/", typeFlag: "5", mode: 0o755 },
        { name: "dsh-runtime/bin/dsh", body: "#!/bin/sh\nexit 0\n", mode: 0o755 },
        { name: "dsh-runtime/bin/node", body: "binary", mode: 0o755 },
        ...extra,
    ];
}

test("GNU long-name entries extract without the NUL terminator in the path", async () => {
    assert.ok(Buffer.byteLength(LONG_NAME) > 100, "fixture must exercise the long-name path");
    const { dir, staging } = await extractFixture(runtimeFixture([{ name: LONG_NAME, body: "export {};\n" }]));
    try {
        // Before the fix this threw "The archive contains an invalid entry name."
        const extracted = join(staging, LONG_NAME);
        assert.equal(await readFile(extracted, "utf8"), "export {};\n");
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("the end-of-archive marker is not extracted as a file over the staging directory", async () => {
    // Before the fix the zero blocks parsed as a regular entry with an empty
    // name, which resolved back to stagingDir and failed with EISDIR.
    const { dir, staging } = await extractFixture(runtimeFixture());
    try {
        const info = await stat(staging);
        assert.ok(info.isDirectory(), "staging must remain a directory");
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("archive permission bits are preserved so bundled executables stay executable", async () => {
    const helper = "dsh-runtime/app/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper";
    const { dir, staging } = await extractFixture(
        runtimeFixture([
            { name: helper, body: "helper", mode: 0o755 },
            { name: "dsh-runtime/app/package.json", body: "{}\n", mode: 0o644 },
        ]),
    );
    try {
        // bin/node must be executable or the launcher dies with EACCES, and
        // spawn-helper must be executable or node-pty cannot open a terminal.
        await access(join(staging, "dsh-runtime/bin/node"), constants.X_OK);
        await access(join(staging, helper), constants.X_OK);

        const plain = await stat(join(staging, "dsh-runtime/app/package.json"));
        assert.equal(plain.mode & 0o111, 0, "non-executable files must not gain the executable bit");
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
