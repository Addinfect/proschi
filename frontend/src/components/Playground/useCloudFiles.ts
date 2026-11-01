import { useCallback, useEffect, useMemo, useState } from 'react';
import { cloudSpecsOf } from '../../dsl/imports';
import { fetchCloudFiles, fetchFromAccount, type CloudFiles, type VersionCache } from '../../playground/cloudRefs';

/** Versions fetched in this page's session (V6): a tag never changes, so only `latest` is asked again, on refresh. */
const cache: VersionCache = new Map();

const NONE: CloudFiles = { files: {}, errors: {} };

/**
 * The `cloud:` versions a document reads, fetched from the signed-in account
 * before it is parsed. `signedIn` is null while the account is unknown, so
 * nothing is reported yet. Bundled files (a share link's) are used where a
 * version cannot be fetched.
 */
export function useCloudFiles(source: string, path: string, bundled: Record<string, string>, signedIn: boolean | null) {
  const bundledKey = JSON.stringify(bundled);
  // Only a change in what is referenced starts a fetch, not every keystroke.
  const specsKey = useMemo(() => cloudSpecsOf(source, { path, files: JSON.parse(bundledKey) }).join('\n'), [source, path, bundledKey]);
  const [result, setResult] = useState<{ key: string; files: CloudFiles } | null>(null);
  const [refreshes, setRefreshes] = useState(0);
  const key = `${specsKey}#${signedIn}#${refreshes}`;

  useEffect(() => {
    if (!specsKey || signedIn === null) return;
    let cancelled = false;
    void fetchCloudFiles(source, { path, bundled: JSON.parse(bundledKey) }, signedIn ? fetchFromAccount : null, cache).then((files) => {
      if (!cancelled) setResult({ key, files });
    });
    return () => {
      cancelled = true;
    };
    // `key` covers the specs, the sign-in and refreshes; the source itself only matters through them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  /** "Refresh cloud references": asks again what `latest` is. */
  const refresh = useCallback(() => {
    for (const spec of [...cache.keys()]) if (spec.endsWith(':latest')) cache.delete(spec);
    setRefreshes((n) => n + 1);
  }, []);

  if (!specsKey) return { ...NONE, loading: false, refresh, any: false };
  // The last answer stays in use while a new one is fetched, so the canvas does not flicker.
  const files = result?.files ?? NONE;
  return { ...files, loading: result?.key !== key, refresh, any: true };
}
