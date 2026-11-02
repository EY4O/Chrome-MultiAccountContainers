// Checks a backup file before anything in it is imported. A backup can come
// from anywhere, so the whole file is refused on the first bad entry, with a
// message that says which one and why. Pure, so it can be unit-tested.

import type { Backup } from "./messages.ts";

export const TAB_GROUP_COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];
export const NAME_MAX = 64;
export const EMOJI_MAX = 8;
/** Container ids are the first 8 hex digits of a random UUID. */
const ID = /^[0-9a-f]{8}$/;
/** A bare hostname: letters, digits and hyphens in dot-separated labels; no scheme, port or path. */
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOST = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`, "i");

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Throws an Error naming the first problem; returns the file typed as a backup when it's sound. */
export function validateBackup(file: unknown, existingIds: string[]): Backup {
  if (!isObject(file) || file.format !== "containers-backup" || !Array.isArray(file.containers)) {
    throw new Error("That file isn't a containers backup.");
  }
  if (file.version !== 1) throw new Error("That backup is from a newer version of the extension.");
  const ids = new Set<string>();
  file.containers.forEach((c: unknown, i: number) => {
    const where = `Container ${i + 1}`;
    if (!isObject(c)) throw new Error(`${where} isn't a container.`);
    const label = typeof c.name === "string" && c.name.trim() ? `${where} ("${c.name.trim().slice(0, NAME_MAX)}")` : where;
    if (typeof c.id !== "string" || !ID.test(c.id)) throw new Error(`${label} has an id that isn't valid.`);
    if (ids.has(c.id)) throw new Error(`${label} has the same id as another container in the file.`);
    ids.add(c.id);
    if (typeof c.name !== "string" || !c.name.trim()) throw new Error(`${where} has no name.`);
    if (c.name.trim().length > NAME_MAX) throw new Error(`${label} has a name longer than ${NAME_MAX} characters.`);
    if (typeof c.color !== "string" || !TAB_GROUP_COLORS.includes(c.color)) {
      throw new Error(`${label} has a colour that isn't one of Chrome's tab group colours.`);
    }
    if (c.emoji !== undefined && (typeof c.emoji !== "string" || [...c.emoji].length > EMOJI_MAX)) {
      throw new Error(`${label} has an emoji that isn't valid.`);
    }
  });
  const assignments = file.assignments ?? {};
  if (!isObject(assignments)) throw new Error("The file's site list isn't valid.");
  for (const [host, a] of Object.entries(assignments)) {
    if (host.length > 253 || !HOST.test(host)) throw new Error(`"${host.slice(0, 80)}" isn't a site address (use just the host, like portal.contoso.com).`);
    if (!isObject(a)) throw new Error(`The entry for ${host} isn't valid.`);
    if (typeof a.containerId !== "string" || (!ids.has(a.containerId) && !existingIds.includes(a.containerId))) {
      throw new Error(`${host} is assigned to a container that isn't in the file or on this computer.`);
    }
    if ((a.ask !== undefined && typeof a.ask !== "boolean") || (a.allowElsewhere !== undefined && typeof a.allowElsewhere !== "boolean")) {
      throw new Error(`The entry for ${host} isn't valid.`);
    }
  }
  return file as unknown as Backup;
}
