import type { Assignment, Container, GroupColor } from "../background/state.ts";
import type { SettingKey, Settings } from "./settings.ts";

/** [name, value, expires epoch ms or 0 for session] */
export type SnapshotCookie = [string, string, number];

export interface SnapshotReply {
  container: string | null;
  cookies: SnapshotCookie[];
}

/** One container as the popup shows it. */
export interface ContainerView extends Container {
  tabs: number;
  sites: string[];
  /** Every one of its tab groups is collapsed. */
  hidden: boolean;
  /** The shortcut that opens it, e.g. "Ctrl+Shift+1", or "" when none is set. */
  shortcut: string;
}

export interface PopupState {
  containers: ContainerView[];
  /** The tab the popup was opened over. */
  tab: { id: number; containerId: string | null; host: string | null; assignment: Assignment | null } | null;
}

export interface PromptInfo {
  host: string;
  target: Pick<Container, "id" | "name" | "emoji" | "color">;
  current: Pick<Container, "id" | "name" | "emoji" | "color"> | null;
  /** false: the user chose to always switch; the page switches straight away. */
  ask: boolean;
}

export interface Backup {
  format: "containers-backup";
  version: 1;
  exportedAt: string;
  containers: Pick<Container, "id" | "name" | "color" | "emoji">[];
  assignments: Record<string, Assignment>;
}

export interface SyncStatus {
  enabled: boolean;
  lastPush: number;
  lastPull: number;
  error: string;
}

export type BgMessage =
  | { type: "mac:get-snapshot"; url?: string }
  | { type: "mac:set-cookie"; cookie: string; url?: string }
  | { type: "mac:barrier" }
  | { type: "mac:activity" }
  | { type: "mac:list"; tabId?: number }
  | { type: "mac:create"; name: string; color: GroupColor; emoji?: string }
  | { type: "mac:update"; id: string; name?: string; color?: GroupColor; emoji?: string }
  | { type: "mac:reorder"; ids: string[] }
  | { type: "mac:hide"; id: string; hidden: boolean }
  | { type: "mac:reset"; id: string }
  | { type: "mac:delete"; id: string }
  | { type: "mac:open"; id: string; url?: string; windowId?: number }
  | { type: "mac:reopen"; tabId: number; id: string | null }
  | { type: "mac:assign"; host: string; id: string | null; tabId?: number }
  | { type: "mac:prompt-info"; url: string }
  | { type: "mac:prompt-choice"; url: string; open: boolean; remember: boolean }
  | { type: "mac:export" }
  | { type: "mac:import"; backup: Backup }
  | { type: "mac:sync-status" }
  | { type: "mac:settings" }
  | { [K in SettingKey]: { type: "mac:set-setting"; key: K; value: Settings[K] } }[SettingKey];

/** Server-Timing entry names the DNR rules append to container documents. */
export const MARKER = "__macc";
export const SNAPSHOT = "__macj";
/** On normal-tab pages of sites used in containers: no service workers here. */
export const NO_SW = "__macnosw";

/** CustomEvent names used between the ISOLATED and MAIN worlds (JSON details). */
export const EV_TO_ISOLATED = "__mac_to_isolated";
export const EV_TO_MAIN = "__mac_to_main";

export type ToIsolated =
  | { type: "set-cookie"; id: number; cookie: string; url: string }
  | { type: "barrier"; id: number };

export type ToMain =
  | { type: "snapshot"; cookies: SnapshotCookie[] }
  | { type: "ack"; id: number }
  | { type: "no-sw" };
