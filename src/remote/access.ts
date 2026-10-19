import { isRecord } from "../guards";
import { RemoteProtocolError } from "./errors";

export interface AccessResource { kind: string; id?: string }
interface Grant { resource: AccessResource; actions: string[] }
export interface RemoteAccessSnapshot { available: boolean; owner: boolean; grants: readonly Grant[] }

/** Authorization hints for UI only; the Host remains authoritative for every RPC. */
export class RemoteAccessState {
    private value: RemoteAccessSnapshot = { available: false, owner: false, grants: [] };
    public get snapshot(): RemoteAccessSnapshot { return this.value; }
    public reset(): void { this.value = { available: false, owner: false, grants: [] }; }
    public legacyOwner(): void { this.value = { available: true, owner: true, grants: [] }; }
    public allows(action: string, resource: AccessResource = { kind: "global" }): boolean {
        return this.value.available && (this.value.owner || this.value.grants.some(grant =>
            grant.resource.kind === resource.kind && grant.resource.id === resource.id && grant.actions.includes(action)));
    }
    public apply(raw: unknown, first: boolean): void {
        if (!isRecord(raw) || (first && raw.type !== "baseline") || (!first && raw.type === "baseline")) throw new RemoteProtocolError("Remote access stream omitted baseline");
        if (raw.type === "baseline" && typeof raw.owner === "boolean") {
            if (!raw.owner && !Array.isArray(raw.grants)) throw new RemoteProtocolError("Invalid Remote access grants");
            this.value = { available: true, owner: raw.owner, grants: raw.owner ? [] : (raw.grants as unknown[]).map(grant) };
        } else if (!first && this.value.available && !this.value.owner && raw.type === "upsert") {
            const next = grant(raw.grant);
            this.value = { ...this.value, grants: [...this.value.grants.filter(item => !same(item.resource, next.resource)), next] };
        } else if (!first && this.value.available && !this.value.owner && raw.type === "remove") {
            const removed = resource(raw.resource);
            this.value = { ...this.value, grants: this.value.grants.filter(item => !same(item.resource, removed)) };
        } else throw new RemoteProtocolError("Invalid Remote access frame");
    }
}
function same(a: AccessResource, b: AccessResource): boolean { return a.kind === b.kind && a.id === b.id; }
function resource(raw: unknown): AccessResource {
    if (!isRecord(raw) || typeof raw.kind !== "string" || !raw.kind ||
        (raw.kind !== "global" && (typeof raw.id !== "string" || !raw.id))) throw new RemoteProtocolError("Invalid Remote resource");
    return raw.kind === "global" ? { kind: "global" } : { kind: raw.kind, id: raw.id as string };
}
function grant(raw: unknown): Grant {
    if (!isRecord(raw) || !Array.isArray(raw.actions) || !raw.actions.every(action => typeof action === "string")) throw new RemoteProtocolError("Invalid Remote grant");
    return { resource: resource(raw.resource), actions: [...raw.actions] };
}
