export function schemaNodeAtPath(schema: unknown, path: readonly string[]): Record<string, unknown> | undefined {
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) return undefined;
    const envelope = schema as Record<string, unknown>;
    const refs = envelope.refs && typeof envelope.refs === "object" ? envelope.refs as Record<string, unknown> : {};
    const resolve = (raw: unknown, depth = 0): unknown => {
        if (depth > 40) return undefined;
        if (typeof raw === "number") return resolve(refs[String(raw)], depth + 1);
        if (Array.isArray(raw)) return raw.map(item => resolve(item, depth + 1));
        if (!raw || typeof raw !== "object") return raw;
        return Object.fromEntries(Object.entries(raw as Record<string, unknown>).map(([key, value]) =>
            [key, ["inner", "sKey", "list"].includes(key) ? resolve(value, depth + 1) : key === "dict" && value && typeof value === "object"
                ? Object.fromEntries(Object.entries(value).map(([name, child]) => [name, resolve(child, depth + 1)])) : value]));
    };
    let node = resolve(typeof envelope.uid === "number" && envelope.refs ? envelope.uid : schema) as Record<string, unknown> | undefined;
    for (const segment of path) {
        if (!node) return undefined;
        if (node.type === "object" && node.dict && typeof node.dict === "object") node = (node.dict as Record<string, Record<string, unknown>>)[segment];
        else if (node.type === "dict" || node.type === "array") node = node.inner as Record<string, unknown> | undefined;
        else return undefined;
    }
    return node;
}

