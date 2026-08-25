import { isAbsolute, relative, sep } from "node:path";

/**
 * Whether `candidate` is `root` itself or lies beneath it.
 *
 * Both arguments must already be resolved; callers that also need symlinks
 * collapsed are responsible for passing real paths, since this check is purely
 * lexical.
 *
 * The escape test deliberately matches `..` only as a whole segment — a bare
 * `..` or a `../` prefix. Testing `startsWith("..")` instead would also reject
 * entries whose name merely begins with two dots (`..config`), which are legal
 * on every platform and are inside the root.
 */
export function containsPath(root: string, candidate: string): boolean {
    const child = relative(root, candidate);
    return child === "" ||
        (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}
