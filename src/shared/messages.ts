import type { GroupColor } from "../background/state.ts";

/** [name, value, expires epoch ms or 0 for session] */
export type SnapshotCookie = [string, string, number];

export interface SnapshotReply {
  container: string | null;
  cookies: SnapshotCookie[];
}

export type BgMessage =
  | { type: "mac:get-snapshot"; url?: string }
  | { type: "mac:set-cookie"; cookie: string; url?: string }
  | { type: "mac:barrier" }
  | { type: "mac:list"; tabId?: number }
  | { type: "mac:create"; name: string; color: GroupColor }
  | { type: "mac:delete"; id: string }
  | { type: "mac:open"; id: string; url?: string; windowId?: number };

/** Server-Timing entry names the DNR rules append to container documents. */
export const MARKER = "__macc";
export const SNAPSHOT = "__macj";

/** CustomEvent names used between the ISOLATED and MAIN worlds (JSON details). */
export const EV_TO_ISOLATED = "__mac_to_isolated";
export const EV_TO_MAIN = "__mac_to_main";

export type ToIsolated =
  | { type: "set-cookie"; id: number; cookie: string; url: string }
  | { type: "barrier"; id: number };

export type ToMain =
  | { type: "snapshot"; cookies: SnapshotCookie[] }
  | { type: "ack"; id: number };
