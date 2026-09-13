/** Parse SemVer without accepting tags, leading-zero numeric ids, or partial versions. */
function parseVersion(value: string | undefined): string[] | undefined {
    if (value === undefined) return undefined;
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.exec(value);
    if (!match || match[4]?.split(".").some(id => /^0\d+$/u.test(id))) return undefined;
    return match.slice(1);
}

/** SemVer precedence: -1, 0, or 1; undefined means a version could not be parsed. Build metadata is ignored. */
export function compareRuntimeVersions(actual: string | undefined, target: string): number | undefined {
    const left = parseVersion(actual);
    const right = parseVersion(target);
    if (!left || !right) return undefined;
    for (let index = 0; index < 3; index += 1) {
        if (BigInt(left[index]) !== BigInt(right[index])) return BigInt(left[index]) < BigInt(right[index]) ? -1 : 1;
    }
    if (left[3] === undefined || right[3] === undefined) {
        return left[3] === right[3] ? 0 : left[3] === undefined ? 1 : -1;
    }
    const a = left[3].split(".");
    const b = right[3].split(".");
    for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
        if (a[index] === b[index]) continue;
        if (a[index] === undefined || b[index] === undefined) return a[index] === undefined ? -1 : 1;
        const numericA = /^\d+$/u.test(a[index]);
        const numericB = /^\d+$/u.test(b[index]);
        if (numericA && numericB) return BigInt(a[index]) < BigInt(b[index]) ? -1 : 1;
        if (numericA !== numericB) return numericA ? -1 : 1;
        return a[index] < b[index] ? -1 : 1;
    }
    return 0;
}

/** Only a known version below the target permits an automatic upgrade. */
export function isOlderRuntimeVersion(actual: string | undefined, target: string): boolean {
    return compareRuntimeVersions(actual, target) === -1;
}
