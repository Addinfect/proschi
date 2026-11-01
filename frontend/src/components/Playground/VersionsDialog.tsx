import { useCallback, useEffect, useState } from 'react';
import { Copy, Eye, GitCompare, Trash2, X } from 'lucide-react';
import { ApiError } from '../../services/api';
import {
  createVersion,
  deleteVersion,
  listVersions,
  localDate,
  suggestTag,
  tagProblem,
  versionReference,
  type VersionList,
} from '../../playground/versions';
import { field, outlineButton, primaryButton } from './ui';

interface VersionsDialogProps {
  docId: string;
  fileName: string;
  /** Why versions are not available for this diagram, with what to do about it; null when they are. */
  hint: { message: string; actions: { label: string; run: () => void }[] } | null;
  /** The account's version of the diagram once its edits are pushed; null when it is not in the account. */
  pushedVersion: (id: string) => Promise<number | null>;
  /** Pulls the account's changes, after a stale answer. */
  pull: () => Promise<void>;
  onView: (tag: string, versions: VersionList) => void;
  onCompare: (tag: string, versions: VersionList) => void;
  /** Copies text to the clipboard, with a message saying what was copied. */
  onCopy: (text: string, message: string) => void;
  onClose: () => void;
}

const dateOf = (ms: number) => new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

/** The id a `system` block would give a diagram: its file name's last segment, as an identifier. */
function systemId(fileName: string): string {
  const base = fileName.replace(/\.proschi$/, '').split('/').pop() ?? '';
  const id = base.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return /^[A-Za-z_]/.test(id) ? id : `system_${id || 'design'}`;
}

/** What a refused save means, in words. */
function saveError(e: unknown, tag: string): string {
  if (!(e instanceof ApiError)) return e instanceof Error ? e.message : String(e);
  const body = (e.body ?? {}) as { error?: string; message?: string; limit?: number; used?: number };
  if (body.error === 'tag_taken') return `The tag “${tag}” is taken for this diagram (a deleted version's tag stays taken). Pick another.`;
  if (body.error === 'version_limit') return `${body.used ?? body.limit} of ${body.limit} versions used: delete one to save another.`;
  if (body.error === 'bad_tag') return body.message ?? 'That tag is not allowed.';
  if (e.status === 404) return 'This diagram is not in your account yet; wait for it to sync, then try again.';
  if (e.status === 401) return 'Your session expired; sign in again.';
  return body.message ?? e.message;
}

/**
 * The saved versions of the current diagram (backend/README.md "Diagram
 * versions"): save one of what is on screen, and view, compare, reference or
 * delete the others. Versions live in the account, so a diagram that is not
 * synced gets a hint instead.
 */
export default function VersionsDialog({ docId, fileName, hint, pushedVersion, pull, onView, onCompare, onCopy, onClose }: VersionsDialogProps) {
  const [listing, setListing] = useState<VersionList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tag, setTag] = useState(localDate());
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  /** The row's open panel: `copy:<tag>` or `delete:<tag>` (the inline confirmation). */
  const [open, setOpen] = useState<string | null>(null);
  const today = localDate();

  const load = useCallback(async () => {
    const answer = await listVersions(docId);
    setListing(answer);
    return answer;
  }, [docId]);

  useEffect(() => {
    if (hint) return;
    let cancelled = false;
    listVersions(docId).then(
      (answer) => {
        if (cancelled) return;
        setListing(answer);
        setTag(suggestTag(answer.versions.map((v) => v.tag), today));
      },
      (e: unknown) => {
        if (cancelled) return;
        // A diagram the account has not had yet has no versions.
        if (e instanceof ApiError && e.status === 404) setListing({ versions: [], limit: 20 });
        else setError(e instanceof Error ? e.message : String(e));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [docId, hint, today]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const problem = tagProblem(tag);
  const reference = (t: string) => versionReference(fileName, t);

  const save = async () => {
    if (problem || busy) return;
    setBusy(true);
    setError(null);
    setSaved(null);
    const post = async () => {
      const documentVersion = await pushedVersion(docId);
      if (documentVersion === null) throw new Error('This diagram is not in your account yet; wait for it to sync, then try again.');
      return createVersion(docId, { tag, ...(note.trim() ? { note: note.trim() } : {}), documentVersion });
    };
    try {
      try {
        await post();
      } catch (e) {
        // Changed on another device since the last sync: sync, then try once more.
        if (!(e instanceof ApiError && (e.body as { error?: string } | undefined)?.error === 'stale')) throw e;
        await pull();
        await post();
      }
      setSaved(tag);
      setNote('');
      const answer = await load();
      setTag(suggestTag(answer.versions.map((v) => v.tag), today));
    } catch (e) {
      setError(saveError(e, tag));
      if (e instanceof ApiError && (e.body as { error?: string } | undefined)?.error === 'tag_taken') setTag(suggestTag([...(listing?.versions.map((v) => v.tag) ?? []), tag], today));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (t: string) => {
    setOpen(null);
    try {
      await deleteVersion(docId, t);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const count = listing?.versions.length ?? 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-label="Versions"
        className="w-full max-w-2xl max-h-[88vh] overflow-y-auto rounded-brutal border-bw-2 border-ink bg-surface text-ink shadow-brutal-lg"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b-bw-2 border-ink">
          <div className="min-w-0">
            <h2 className="font-display text-2xl font-extrabold tracking-[-0.02em] text-ink">Versions</h2>
            <p className="text-sm text-muted">
              Saved snapshots of <span className="font-mono text-ink">{fileName}</span>. A version never changes; other diagrams can use it with a{' '}
              <code className="font-mono">cloud:</code> reference.
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" className="p-1.5 rounded-md text-muted hover:bg-ink/10">
            <X size={18} />
          </button>
        </div>

        {hint ? (
          <div className="p-5" data-testid="versions-hint">
            <p className="text-sm">{hint.message}</p>
            {hint.actions.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {hint.actions.map((a) => (
                  <button key={a.label} type="button" className={outlineButton} onClick={a.run}>
                    {a.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="p-5">
            <form
              className="grid gap-2 sm:grid-cols-[10rem_1fr_auto] sm:items-start"
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <label className="grid gap-1 text-xs font-semibold text-muted">
                Tag
                <input
                  value={tag}
                  onChange={(e) => {
                    setTag(e.target.value.trim());
                    setError(null);
                  }}
                  aria-invalid={!!problem || undefined}
                  className={`${field} w-full min-w-0 font-mono`}
                  spellCheck={false}
                  maxLength={64}
                />
              </label>
              <label className="grid gap-1 text-xs font-semibold text-muted">
                Note (optional)
                <input value={note} onChange={(e) => setNote(e.target.value)} className={`${field} w-full min-w-0`} maxLength={280} placeholder="What changed, e.g. read replicas for orders" />
              </label>
              <button type="submit" className={`${primaryButton} sm:mt-[1.15rem] justify-center`} disabled={!!problem || busy || listing === null}>
                {busy ? 'Saving…' : 'Save version'}
              </button>
            </form>
            {problem && tag !== '' && <p className="mt-1.5 text-xs text-fail">{problem}</p>}
            {error && (
              <p role="alert" className="mt-2 text-sm text-fail">
                {error}
              </p>
            )}
            {saved && (
              <p role="status" className="mt-2 text-sm text-pass">
                Saved version {saved}.
              </p>
            )}

            <div className="mt-5">
              {!listing && !error && <p className="text-sm text-muted">Loading…</p>}
              {listing && count === 0 && <p className="text-sm text-muted">No versions yet. Save one to mark this design as it is now.</p>}
              {listing && count > 0 && (
                <ul className="divide-y divide-ink/15 border-y border-ink/15" aria-label="Saved versions">
                  {listing.versions.map((v, i) => {
                    const ref = reference(v.tag);
                    return (
                      <li key={v.tag} className="py-2">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-x-2">
                              <span className="whitespace-nowrap font-mono font-bold">{v.tag}</span>
                              {i === 0 && <span className="rounded border border-ink/30 px-1 text-[11px] font-bold uppercase tracking-wide text-muted">latest</span>}
                              <span className="whitespace-nowrap text-xs text-muted">{dateOf(v.createdAt)}</span>
                            </div>
                            {v.note && <div className="truncate text-sm text-ink/80">{v.note}</div>}
                          </div>
                          <button type="button" aria-label={`View ${v.tag}`} title="View" className="p-1.5 rounded-md hover:bg-ink/10" onClick={() => onView(v.tag, listing)}>
                            <Eye size={16} />
                          </button>
                          <button type="button" aria-label={`Compare ${v.tag}`} title="Compare with the draft" className="p-1.5 rounded-md hover:bg-ink/10" onClick={() => onCompare(v.tag, listing)}>
                            <GitCompare size={16} />
                          </button>
                          <button
                            type="button"
                            aria-label={`Copy a reference to ${v.tag}`}
                            aria-expanded={open === `copy:${v.tag}`}
                            title="Copy reference"
                            className="p-1.5 rounded-md hover:bg-ink/10 aria-expanded:bg-ink/10"
                            onClick={() => setOpen(open === `copy:${v.tag}` ? null : `copy:${v.tag}`)}
                          >
                            <Copy size={16} />
                          </button>
                          <button type="button" aria-label={`Delete ${v.tag}`} title="Delete" className="p-1.5 rounded-md hover:bg-fail/10 hover:text-fail" onClick={() => setOpen(`delete:${v.tag}`)}>
                            <Trash2 size={16} />
                          </button>
                        </div>
                        {open === `copy:${v.tag}` && (
                          <div className="mt-2 flex flex-wrap items-center gap-2 rounded border border-ink/20 bg-ink/5 px-3 py-2 text-sm">
                            {ref ? (
                              <>
                                <code className="flex-1 min-w-0 break-all font-mono text-xs">{ref}</code>
                                <button
                                  type="button"
                                  className="rounded border-bw-1 border-ink/40 px-2.5 py-1 font-semibold hover:bg-ink/10"
                                  onClick={() => {
                                    setOpen(null);
                                    onCopy(ref, `Copied ${ref}`);
                                  }}
                                >
                                  Copy reference
                                </button>
                                <button
                                  type="button"
                                  className="rounded px-2.5 py-1 font-semibold hover:bg-ink/10"
                                  onClick={() => {
                                    setOpen(null);
                                    onCopy(`system ${systemId(fileName)} {\n  from "${ref}"\n}\n`, `Copied a system block that uses ${ref}`);
                                  }}
                                >
                                  Copy as system block
                                </button>
                              </>
                            ) : (
                              <span className="text-muted">This diagram's file name can't be used in a cloud: reference. Rename the file under Diagrams (the pencil) to letters, digits, “.”, “_”, “+”, “-” and “/”, without spaces.</span>
                            )}
                          </div>
                        )}
                        {open === `delete:${v.tag}` && (
                          <div role="group" aria-label={`Delete ${v.tag}?`} className="mt-2 flex flex-wrap items-center gap-2 rounded border border-fail/40 bg-fail/5 px-3 py-2 text-sm">
                            <span className="flex-1 min-w-0">
                              Delete version <span className="font-mono">{v.tag}</span>? Diagrams that use it stop resolving, and the tag can't be reused for this diagram.
                            </span>
                            <button type="button" className="rounded border-bw-1 border-fail px-2.5 py-1 font-semibold text-fail hover:bg-fail/10" onClick={() => void remove(v.tag)}>
                              Delete
                            </button>
                            <button type="button" className="rounded px-2.5 py-1 font-semibold hover:bg-ink/10" onClick={() => setOpen(null)}>
                              Cancel
                            </button>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              {listing && (
                <p className="mt-3 text-xs text-muted">
                  {count} of {listing.limit} versions used.
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
