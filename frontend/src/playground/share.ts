import { compressToEncodedURIComponent } from 'lz-string';
import { TooLargeError, decompressBounded } from './lzBounded';
import { isImportKey } from '../dsl/imports';
import { fileMap } from './sanitize';

const PREFIX = '#code=';

/**
 * Most text a share link may expand to (document and imported files together).
 * LZ-string can expand a short hash enormously, so decoding stops here rather
 * than freezing the tab on a crafted link.
 */
export const MAX_SHARE_CHARS = 2_000_000;

/** Above this length, a copied link warns that chat apps may cut it. */
export const LONG_LINK_CHARS = 8_000;

export const LONG_LINK_MESSAGE =
  'This link is long; some chat apps cut links over ~2 000–8 000 characters. Signed in, Share → Short link gives a short one with a preview; or download the .proschi file.';

/** The long-link warning for someone signed in, whose Share menu offers a short link. */
export const LONG_LINK_SHORTEN_MESSAGE =
  'This link is long; some chat apps cut links over ~2 000–8 000 characters. A short link with a preview is safer to paste.';

export const TOO_LARGE_MESSAGE = 'This link holds a diagram larger than 2 MB, so it was not opened. Ask for the .proschi file instead.';

/** Which use case, scenario and 1-based step a link should open in playback. */
export interface PlaybackTarget {
  useCase: string;
  /** Scenario id; left out for use cases without alt branches. */
  scenario?: string;
  step: number;
}

export interface ShareLink {
  source: string;
  playback?: PlaybackTarget;
  /** Imported files (path → source), so the link renders without them. */
  imports?: Record<string, string>;
}

/** A link that could not be opened, with a message for the person who followed it. */
export interface ShareLinkError {
  error: string;
}

/**
 * Encodes a document (and optionally a playback position) into a URL hash, like
 * mermaid.live. Nothing leaves the browser. The compressed alphabet never
 * contains '&', so extra parameters can follow it. Imported files travel along
 * as compressed JSON in `&imports=`, keeping the link self-contained.
 */
export function encodeShareHash(source: string, playback?: PlaybackTarget, imports?: Record<string, string>): string {
  let code = PREFIX + compressToEncodedURIComponent(source);
  if (imports && Object.keys(imports).length) code += `&imports=${compressToEncodedURIComponent(JSON.stringify(imports))}`;
  if (!playback) return code;
  const scenario = playback.scenario ? `&alt=${encodeURIComponent(playback.scenario)}` : '';
  return `${code}&uc=${encodeURIComponent(playback.useCase)}${scenario}&step=${playback.step}`;
}

/**
 * Reads a `#code=` hash: null if there is none or it is corrupt, an error when
 * it is too large to open. Malformed imports are dropped; the document still opens.
 */
export function readShareLink(hash: string): ShareLink | ShareLinkError | null {
  if (!hash.startsWith(PREFIX)) return null;
  if (hash.length > MAX_SHARE_CHARS) return { error: TOO_LARGE_MESSAGE };
  const [code, ...rest] = hash.slice(PREFIX.length).split('&');
  let source: string | null;
  try {
    source = decompressBounded(code, MAX_SHARE_CHARS);
  } catch (error) {
    return error instanceof TooLargeError ? { error: TOO_LARGE_MESSAGE } : null;
  }
  if (!source) return null;

  // Read before URLSearchParams, which would turn the '+' of the compressed alphabet into spaces.
  const importsParam = rest.find((p) => p.startsWith('imports='))?.slice('imports='.length);
  let imports: Record<string, string> | undefined;
  try {
    imports = decodeImports(importsParam, MAX_SHARE_CHARS - source.length);
  } catch {
    return { error: TOO_LARGE_MESSAGE };
  }
  const params = new URLSearchParams(rest.filter((p) => !p.startsWith('imports=')).join('&'));
  const useCase = params.get('uc');
  const step = Number(params.get('step') ?? '1');
  const extra = imports ? { imports } : {};
  if (!useCase) return { source, ...extra };
  const scenario = params.get('alt');
  return {
    source,
    ...extra,
    playback: { useCase, ...(scenario ? { scenario } : {}), step: Number.isInteger(step) && step > 0 ? step : 1 },
  };
}

/** Reads a `#code=` hash; returns null if there is none, it is corrupt or too large. */
export function decodeShareLink(hash: string): ShareLink | null {
  const link = readShareLink(hash);
  return link && 'source' in link ? link : null;
}

/**
 * Imported files from `&imports=`; throws TooLargeError past `budget` characters.
 * Keys that no import could resolve to (absolute paths, malformed remote specs) are dropped.
 */
function decodeImports(value: string | undefined, budget: number): Record<string, string> | undefined {
  if (!value) return undefined;
  const json = decompressBounded(value, budget);
  let files: Record<string, string> | undefined;
  try {
    files = fileMap(JSON.parse(json ?? ''));
  } catch {
    return undefined;
  }
  const kept = Object.entries(files ?? {}).filter(([path]) => isImportKey(path));
  return kept.length ? Object.fromEntries(kept) : undefined;
}

export function decodeShareHash(hash: string): string | null {
  return decodeShareLink(hash)?.source ?? null;
}

export function shareUrl(
  source: string,
  // Not Pick<Location, …>: the CLI (tooling, no DOM types) imports this module too.
  location: { origin: string; pathname: string; search: string },
  playback?: PlaybackTarget,
  imports?: Record<string, string>,
): string {
  return `${location.origin}${location.pathname}${location.search}${encodeShareHash(source, playback, imports)}`;
}

/** Whether a copied link should come with the "may be cut" warning. */
export const isLongLink = (url: string): boolean => url.length > LONG_LINK_CHARS;
