import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, apiEnabled, loginUrl, type ProviderId } from '../../services/api';
import { loadJson, saveJson } from '../../services/storage';
import type { DocStore } from '../../playground/docStore';
import type { DocSync, SyncStatus } from '../../playground/cloudSync';
import { DOCS_KEY, SYNC_KEY } from '../../playground/documents';

export type CloudState =
  /** A build without accounts: the editor saves in this browser only. */
  | { kind: 'unavailable' }
  | { kind: 'signed-out'; providers: ProviderId[] }
  | Exclude<SyncStatus, { kind: 'signed-out' }>;

export interface CloudSync {
  state: CloudState;
  enabled: boolean;
  signIn: (provider: ProviderId) => void;
  setEnabled: (on: boolean) => void;
  deleteCloudCopies: () => Promise<void>;
  /** "Add N diagrams from this browser to your account?": N, 0 when not asking. */
  ask: number;
  /** Diagrams in this browser held back from the account. */
  held: number;
  /** Adds the held diagrams to the account (true), or keeps them in this browser only. */
  answer: (add: boolean) => void;
  /** Signs out; `removeSynced` also removes the account's synced diagrams from this browser. */
  signOut: (removeSynced: boolean) => Promise<void>;
  /** While syncing: the diagrams that stay in this browser only (past the account's limit, moved here, held back). */
  local: ReadonlySet<string>;
  /** Whether the account has a free slot for "Keep in cloud". */
  canKeep: boolean;
  /** How many diagrams the account may keep; null while unknown. */
  limit: number | null;
  /** "Move to this browser only": stops syncing the diagram and deletes its cloud copy. */
  moveToBrowser: (id: string) => void;
  /** "Keep in cloud": syncs the diagram again, when a slot is free. */
  keepInCloud: (id: string) => void;
  /** The account's version of a diagram once its edits are pushed (DocSync.pushedVersion); null when it is not in the account. */
  pushedVersion: (id: string) => Promise<number | null>;
  /** Pulls the account's changes now. */
  pull: () => Promise<void>;
}

const NONE: ReadonlySet<string> = new Set();

/**
 * Cloud sync for the editor, in the build with accounts only: asks the API
 * who is signed in, lazily, and then keeps the diagrams in `store` synced
 * with the account (src/playground/cloudSync.ts). Signed out, or in a build
 * without accounts, nothing is sent anywhere.
 */
export function useCloudSync(store: DocStore, onConflict: (titles: string[]) => void): CloudSync {
  const [state, setState] = useState<CloudState>(apiEnabled ? { kind: 'loading' } : { kind: 'unavailable' });
  const [enabled, setEnabledState] = useState(true);
  const [ask, setAsk] = useState(0);
  const [held, setHeld] = useState(0);
  const [placement, setPlacement] = useState<{ local: ReadonlySet<string>; canKeep: boolean; limit: number | null }>({ local: NONE, canKeep: false, limit: null });
  const syncRef = useRef<DocSync | null>(null);
  const signedOutRef = useRef<() => Promise<void>>(async () => undefined);
  const onConflictRef = useRef(onConflict);
  onConflictRef.current = onConflict;

  useEffect(() => {
    if (!apiEnabled) return;
    let cancelled = false;
    let sync: DocSync | null = null;
    let unsubscribePlace: (() => void) | undefined;
    const signedOut = async () => {
      const { providers } = await api<{ providers: ProviderId[] }>('/auth/providers').catch(() => ({ providers: [] as ProviderId[] }));
      if (!cancelled) setState({ kind: 'signed-out', providers });
    };
    signedOutRef.current = signedOut;

    const boot = async () => {
      let userId: string;
      try {
        userId = (await api<{ user: { id: string } }>('/api/me')).user.id;
      } catch (e) {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 401) await signedOut();
        else {
          setState({ kind: 'offline' });
          window.addEventListener('online', () => !cancelled && void boot(), { once: true });
        }
        return;
      }
      const { DocSync, fetchTransport } = await import('../../playground/cloudSync');
      if (cancelled) return;
      sync = new DocSync({
        store,
        transport: fetchTransport,
        userId,
        storage: {
          load: () => loadJson<unknown>(SYNC_KEY, null),
          save: (value, docs) => {
            saveJson(DOCS_KEY, docs);
            saveJson(SYNC_KEY, value);
          },
        },
        onConflict: (titles) => onConflictRef.current(titles),
        onSignedOut: () => void signedOut(),
      });
      syncRef.current = sync;
      setEnabledState(sync.enabled);
      const live = sync;
      const place = () => {
        if (!live.enabled) return setPlacement({ local: NONE, canKeep: false, limit: null });
        const plan = live.plan();
        setPlacement((before) => {
          const same = before.canKeep === plan.free > 0 && before.limit === plan.limit && before.local.size === plan.local.size && [...plan.local].every((id) => before.local.has(id));
          return same ? before : { local: plan.local, canKeep: plan.free > 0, limit: plan.limit };
        });
      };
      sync.onStatus((status) => {
        if (status.kind !== 'signed-out') setState(status);
        setAsk(live.askCount());
        setHeld(live.heldCount());
        place();
      });
      // A new diagram, or a deleted one, can change which ones fit in the account.
      unsubscribePlace = store.subscribe(place);
      const first = sync.getStatus();
      if (first.kind !== 'signed-out') setState(first);
      sync.start();
      setAsk(sync.askCount());
      setHeld(sync.heldCount());
      place();
    };
    void boot();

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') void syncRef.current?.flush(true);
      else void syncRef.current?.sync();
    };
    const onHide = () => void syncRef.current?.flush(true);
    const onOnline = () => void syncRef.current?.sync();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onHide);
    window.addEventListener('online', onOnline);
    return () => {
      cancelled = true;
      unsubscribePlace?.();
      sync?.stop();
      syncRef.current = null;
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onHide);
      window.removeEventListener('online', onOnline);
    };
  }, [store]);

  const signIn = useCallback((provider: ProviderId) => {
    const { pathname, search, hash } = window.location;
    window.location.assign(loginUrl(provider, `${pathname}${search}${hash}`));
  }, []);

  const setEnabled = useCallback((on: boolean) => {
    syncRef.current?.setEnabled(on);
    setEnabledState(on);
  }, []);

  const deleteCloudCopies = useCallback(async () => {
    const sync = syncRef.current;
    if (!sync) return;
    setEnabledState(false);
    try {
      await sync.deleteCloudCopies();
    } catch (e) {
      setState({ kind: 'error', message: `Could not delete your cloud copies: ${e instanceof Error ? e.message : String(e)}` });
    }
  }, []);

  const answer = useCallback((add: boolean) => {
    syncRef.current?.answer(add);
    setAsk(0);
  }, []);

  const signOut = useCallback(async (removeSynced: boolean) => {
    const sync = syncRef.current;
    if (removeSynced) sync?.forgetSynced();
    else sync?.stop();
    syncRef.current = null;
    setAsk(0);
    setHeld(0);
    setPlacement({ local: NONE, canKeep: false, limit: null });
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    await signedOutRef.current();
  }, []);

  const moveToBrowser = useCallback((id: string) => syncRef.current?.moveToBrowser(id), []);
  const keepInCloud = useCallback((id: string) => syncRef.current?.keepInCloud(id), []);

  const pushedVersion = useCallback(async (id: string) => (syncRef.current ? syncRef.current.pushedVersion(id) : null), []);
  const pull = useCallback(async () => {
    await syncRef.current?.sync();
  }, []);

  return { state, enabled, signIn, setEnabled, deleteCloudCopies, ask, held, answer, signOut, ...placement, moveToBrowser, keepInCloud, pushedVersion, pull };
}

/** The sync status in words, for the File menu and the diagrams sidebar. */
export function cloudLabel(state: CloudState): string {
  switch (state.kind) {
    case 'unavailable':
      return 'Saved in this browser only — export a backup.';
    case 'loading':
      return 'Saved in this browser';
    case 'signed-out':
      return 'Sign in to keep your diagrams on every device';
    case 'off':
      return 'Cloud sync is off — saved in this browser only';
    case 'saving':
      return 'Saving…';
    case 'saved':
      if (state.limit === undefined || state.used === undefined) return 'Saved to your account';
      return state.used >= state.limit
        ? `Cloud full: ${state.used} of ${state.limit} — new diagrams stay in this browser`
        : `Saved to your account (${state.used} of ${state.limit})`;
    case 'offline':
      return 'Offline — saved in this browser';
    case 'error':
      return `Saved in this browser; not in your account yet: ${state.message}`;
  }
}
