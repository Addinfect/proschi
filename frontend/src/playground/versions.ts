import { LATEST_TAG, VERSION_TAG, formatRemoteSpec, parseRemoteSpec } from '../dsl/imports';
import { api } from '../services/api';

/**
 * Saved versions of a synced diagram (docs/design/versions-and-cloud.md,
 * backend/README.md "Diagram versions"): immutable, tagged snapshots that
 * `cloud:<name>:<tag>` sources read.
 */

export interface VersionInfo {
  tag: string;
  seq: number;
  note: string | null;
  /** Unix milliseconds. */
  createdAt: number;
  size: number;
  sha256: string;
}

export interface VersionContent extends VersionInfo {
  documentId: string;
  name: string;
  source: string;
  imports: Record<string, string> | null;
}

export interface VersionList {
  /** Newest first. */
  versions: VersionInfo[];
  /** How many versions a diagram may keep. */
  limit: number;
}

/** Today's date as the user sees it, YYYY-MM-DD. */
export function localDate(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The tag to suggest: today's date, or `<date>.2`, `.3` … when that is taken (deleted tags stay taken too). */
export function suggestTag(taken: Iterable<string>, today: string): string {
  const used = new Set(taken);
  if (!used.has(today)) return today;
  let n = 2;
  while (used.has(`${today}.${n}`)) n++;
  return `${today}.${n}`;
}

/** Why a tag cannot be used, or null when it can (the backend's rule, V2 and V3). */
export function tagProblem(tag: string): string | null {
  if (!tag) return 'Give the version a tag, e.g. a date.';
  if (tag.toLowerCase() === LATEST_TAG) return '“latest” is reserved: it always means the newest version.';
  if (!VERSION_TAG.test(tag)) return 'Use up to 64 letters, digits, “.”, “_” and “-”, starting with a letter or digit.';
  return null;
}

/**
 * The `cloud:` reference to a version of the diagram saved as `fileName`, or
 * null when the file name cannot be referenced (a space or a ':', say).
 */
export function versionReference(fileName: string, tag: string): string | null {
  const name = fileName.endsWith('.proschi') ? fileName.slice(0, -'.proschi'.length) : fileName;
  const spec = `cloud:${name}:${tag}`;
  try {
    // Only a name that parses back to exactly this diagram and tag: not one that reads as a path or another tag.
    const parsed = parseRemoteSpec(spec);
    return parsed?.kind === 'cloud' && parsed.path === undefined && formatRemoteSpec(parsed) === spec ? spec : null;
  } catch {
    return null;
  }
}

const base = (docId: string) => `/api/me/documents/${encodeURIComponent(docId)}/versions`;

export const listVersions = (docId: string) => api<VersionList>(base(docId));

export const getVersion = async (docId: string, tag: string) => (await api<{ version: VersionContent }>(`${base(docId)}/${encodeURIComponent(tag)}`)).version;

export const createVersion = async (docId: string, body: { tag: string; note?: string; documentVersion: number }) =>
  (await api<{ version: VersionInfo }>(base(docId), { method: 'POST', body })).version;

export const deleteVersion = (docId: string, tag: string) => api<void>(`${base(docId)}/${encodeURIComponent(tag)}`, { method: 'DELETE' });
