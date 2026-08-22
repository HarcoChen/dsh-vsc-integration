#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const root = new URL("../", import.meta.url);
const packagePath = new URL("package.json", root);
const lockPath = new URL("package-lock.json", root);
const changelogPath = new URL("CHANGELOG.md", root);

function usage() {
    console.log(`Usage: npm run release -- <patch|minor|major|x.y.z> [--push]

The release command requires a clean worktree and a non-empty CHANGELOG.md
[Unreleased] section. It runs the test suite, updates package metadata,
promotes the Unreleased notes, commits, and creates the matching vX.Y.Z tag.

Options:
  --push       push the current branch and release tag to origin
  --dry-run    validate and run checks without changing files or git state
  --help       show this help

Example:
  npm run release -- patch --push`);
}

function fail(message) {
    console.error(`release: ${message}`);
    process.exit(1);
}

function git(args, options = {}) {
    try {
        return execFileSync("git", args, {
            cwd: new URL("../", import.meta.url),
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        }).trim();
    } catch (error) {
        if (options.allowFailure) return "";
        const detail = error instanceof Error ? error.message : String(error);
        fail(`git ${args.join(" ")} failed: ${detail}`);
    }
}

function run(command, args) {
    execFileSync(command, args, {
        cwd: new URL("../", import.meta.url),
        stdio: "inherit",
    });
}

function parseVersion(value) {
    if (typeof value !== "string") return undefined;
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
    if (!match) return undefined;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function nextVersion(current, bump) {
    const parsed = parseVersion(current);
    if (!parsed) fail(`package.json has an unsupported version: ${current}`);
    const explicit = parseVersion(bump);
    if (explicit) {
        if (explicit[0] < parsed[0] || (explicit[0] === parsed[0] && explicit[1] < parsed[1]) ||
            (explicit[0] === parsed[0] && explicit[1] === parsed[1] && explicit[2] <= parsed[2])) {
            fail(`new version ${bump} must be greater than current version ${current}`);
        }
        return bump;
    }

    const [major, minor, patch] = parsed;
    switch (bump) {
        case "major":
            return `${major + 1}.0.0`;
        case "minor":
            return `${major}.${minor + 1}.0`;
        case "patch":
            return `${major}.${minor}.${patch + 1}`;
        default:
            fail(`bump must be patch, minor, major, or an explicit x.y.z version (received ${bump})`);
    }
}

function changelogNotes(changelog) {
    const heading = /^## \[Unreleased\]\s*\n/m.exec(changelog);
    if (!heading) fail("CHANGELOG.md is missing an [Unreleased] section");

    const bodyStart = heading.index + heading[0].length;
    const nextHeading = /^## \[/gm;
    nextHeading.lastIndex = bodyStart;
    const next = nextHeading.exec(changelog);
    const bodyEnd = next?.index ?? changelog.length;
    const notes = changelog.slice(bodyStart, bodyEnd)
        .replace(/<!--[^]*?-->/gu, "")
        .trim();
    if (!notes) fail("CHANGELOG.md [Unreleased] section is empty");

    const before = changelog.slice(0, heading.index);
    const after = changelog.slice(bodyEnd);
    return { notes, rest: `${before}${after}` };
}

function promoteChangelog(changelog, version, previousVersion) {
    const { notes, rest } = changelogNotes(changelog);
    const date = new Date().toISOString().slice(0, 10);
    const entry = `## [${version}] - ${date}\n\n${notes}\n\n`;
    const unreleased = "## [Unreleased]\n\n<!-- 在这里填写下一版本的发布说明；npm run release 会自动提升这一节。 -->\n\n";
    const link = `[${version}]: https://github.com/HarcoChen/dsh-vsc-integration/compare/v${previousVersion}...v${version}`;
    const firstSection = rest.search(/^## \[/m);
    const withEntry = `${rest.slice(0, firstSection < 0 ? rest.length : firstSection)}${unreleased}${entry}${firstSection < 0 ? "" : rest.slice(firstSection)}`;
    const linkIndex = withEntry.search(/^\[[^\]]+\]:\s+https?:\/\//m);
    if (linkIndex < 0) return `${withEntry.trimEnd()}\n\n${link}\n`;
    return `${withEntry.slice(0, linkIndex)}${link}\n${withEntry.slice(linkIndex)}`;
}

function updateJson(path, version, update) {
    const value = JSON.parse(readFileSync(path, "utf8"));
    update(value);
    writeFileSync(path, `${JSON.stringify(value, null, 4)}\n`, "utf8");
}

const rawArgs = process.argv.slice(2);
if (rawArgs.includes("--help") || rawArgs.length === 0) {
    usage();
    process.exit(rawArgs.length === 0 ? 1 : 0);
}

const push = rawArgs.includes("--push");
const dryRun = rawArgs.includes("--dry-run");
const bump = rawArgs.find((argument) => !argument.startsWith("--"));
if (!bump) fail("missing version bump");

const status = git(["status", "--porcelain"]);
if (status) {
    fail("working tree is not clean; commit application changes before releasing");
}

const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
const currentVersion = typeof packageJson.version === "string" ? packageJson.version : "";
const version = nextVersion(currentVersion, bump);
const tag = `v${version}`;
if (git(["tag", "--list", tag])) fail(`tag ${tag} already exists`);

const changelog = readFileSync(changelogPath, "utf8");
const nextChangelog = promoteChangelog(changelog, version, currentVersion);
console.log(`Preparing ${tag}`);
console.log(`- test suite`);
console.log(`- package.json and package-lock.json -> ${version}`);
console.log(`- CHANGELOG.md [Unreleased] -> ${version}`);
console.log(`- commit and tag${push ? ", then push" : ""}`);

run("npm", ["test"]);
if (dryRun) {
    console.log("Dry run complete; no files or git refs were changed.");
    process.exit(0);
}

updateJson(packagePath, version, (value) => {
    value.version = version;
});
updateJson(lockPath, version, (value) => {
    value.version = version;
    const packages = value.packages;
    if (packages?.[""]) packages[""].version = version;
});
writeFileSync(changelogPath, nextChangelog, "utf8");

run("git", ["add", "package.json", "package-lock.json", "CHANGELOG.md"]);
run("git", ["commit", "-m", `release: ${tag}`]);
run("git", ["tag", tag]);

if (push) {
    const branch = git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (!branch) fail("cannot push from a detached HEAD");
    run("git", ["push", "origin", branch, "--follow-tags"]);
} else {
    console.log(`Release ${tag} is ready. Push it with: git push origin HEAD --follow-tags`);
}
