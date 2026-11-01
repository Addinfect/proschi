import { Fragment, useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, X } from 'lucide-react';
import { highlightLines, type TokenClass } from '../landing/highlight';
import { ARROWS, CHEAT_SECTIONS } from './cheatSheetSections';
import { DOCS_URL, LANGUAGE_URL, MODEL_URL } from './links';

const TOKEN_CLASS: Record<TokenClass, string> = {
  keyword: 'text-purple-700 dark:text-purple-300',
  string: 'text-red-800 dark:text-red-200',
  tech: 'text-green-700 dark:text-green-300',
  team: 'text-pop-blue',
  arrow: 'font-semibold text-ink',
  comment: 'text-muted',
  status: 'text-amber-700 dark:text-amber-300',
  number: 'text-amber-700 dark:text-amber-300',
};

function Snippet({ code }: { code: string }) {
  return (
    <pre className="overflow-x-auto rounded-md border border-ink/15 bg-paper px-3 py-2 font-mono text-xs leading-relaxed text-ink">
      <code>
        {highlightLines(code.split('\n')).map((segments, i) => (
          <Fragment key={i}>
            {i > 0 && '\n'}
            {segments.map((s, j) =>
              s.cls ? (
                <span key={j} className={TOKEN_CLASS[s.cls]}>
                  {s.text}
                </span>
              ) : (
                s.text
              ),
            )}
          </Fragment>
        ))}
      </code>
    </pre>
  );
}

/** `backticks` → <code>. */
function Note({ text }: { text: string }): ReactNode {
  return text.split(/(`[^`]+`)/).map((part, i) =>
    part.startsWith('`') ? (
      <code key={i} className="rounded bg-ink/5 px-1 font-mono text-[0.75rem] text-ink">
        {part.slice(1, -1)}
      </code>
    ) : (
      part
    ),
  );
}

/** A non-modal panel with the syntax at a glance; the page stays usable next to it. */
export default function CheatSheet({ onClose }: { onClose: () => void }) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return createPortal(
    <section
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      className="fixed z-40 inset-x-0 bottom-0 max-h-[78dvh] rounded-t-2xl md:inset-x-auto md:bottom-auto md:right-3 md:top-14 md:max-h-[calc(100dvh-4.5rem)] md:w-[26rem] md:rounded-xl flex flex-col border border-ink/15 bg-surface shadow-2xl"
    >
      <div className="flex items-center gap-2 border-b border-ink/15 px-4 py-2.5">
        <h2 id={titleId} className="text-base font-semibold text-ink">
          Syntax cheat-sheet
        </h2>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label="Close cheat-sheet"
          className="ml-auto rounded-md p-1.5 text-muted hover:bg-ink/10 hover:text-ink"
        >
          <X size={16} />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-4 text-sm text-ink/75">
        <div>
          <h3 className="font-medium text-ink">Arrows in use cases</h3>
          <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            {ARROWS.map(({ arrow, meaning }) => (
              <Fragment key={arrow}>
                <dt>
                  <code className="font-mono text-xs font-semibold text-ink">{`a ${arrow} b`}</code>
                </dt>
                <dd>{meaning}</dd>
              </Fragment>
            ))}
          </dl>
        </div>
        {CHEAT_SECTIONS.map((section) => (
          <div key={section.id} className="space-y-1.5">
            <h3 className="flex items-baseline gap-2 font-medium text-ink">
              {section.title}
              <a
                href={`${DOCS_URL}${section.ref}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs font-normal text-pop-blue hover:underline"
                aria-label={`${section.title} in the language reference`}
              >
                reference
              </a>
            </h3>
            <p className="text-xs leading-relaxed">
              <Note text={section.note} />
            </p>
            <Snippet code={section.code} />
          </div>
        ))}
        <p className="text-xs leading-relaxed">
          <code className="font-mono"># comments</code> go anywhere. Also: <code className="font-mono">import "file.proschi"</code>,{' '}
          <code className="font-mono">capacity</code>, <code className="font-mono">entity</code> and <code className="font-mono">decision</code>{' '}
          blocks.
        </p>
        <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-ink/10 pt-3 text-sm">
          <a href={LANGUAGE_URL} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-pop-blue hover:underline">
            Language reference <ExternalLink size={12} />
          </a>
          <a href={MODEL_URL} className="text-pop-blue hover:underline">
            How the simulation works
          </a>
        </div>
      </div>
    </section>,
    document.body,
  );
}
