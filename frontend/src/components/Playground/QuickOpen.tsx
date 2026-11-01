import { useEffect, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { fileNameOf, titleOf, type SavedDiagram } from '../../playground/documents';
import { matchesQuery } from '../../playground/folders';

interface QuickOpenProps {
  docs: SavedDiagram[];
  currentId: string;
  onOpen: (id: string) => void;
  onClose: () => void;
}

/** Ctrl/Cmd+P: jump to a diagram by its title or path, the most recently edited first. */
export default function QuickOpen({ docs, currentId, onOpen, onClose }: QuickOpenProps) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const found = useMemo(
    () =>
      docs
        .filter((d) => matchesQuery(d, query))
        .sort((a, b) => Number(a.id === currentId) - Number(b.id === currentId) || b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 50),
    [docs, query, currentId],
  );
  const index = Math.min(active, Math.max(found.length - 1, 0));

  useEffect(() => {
    listRef.current?.children[index]?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  const pick = (doc: SavedDiagram | undefined) => {
    if (doc) onOpen(doc.id);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[12vh]" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-label="Open a diagram"
        className="w-full max-w-lg overflow-hidden rounded-brutal border-bw-2 border-ink bg-surface text-ink shadow-brutal-lg"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b-bw-1 border-ink px-3">
          <Search size={16} className="text-muted" />
          <input
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls="quick-open-list"
            aria-activedescendant={found[index] ? `quick-open-${found[index].id}` : undefined}
            aria-label="Diagram name"
            placeholder="Go to a diagram…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive(Math.min(index + 1, found.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive(Math.max(index - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                pick(found[index]);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                onClose();
              }
            }}
            className="w-full bg-transparent py-3 text-base outline-none placeholder:text-muted"
          />
        </div>
        <ul id="quick-open-list" ref={listRef} role="listbox" aria-label="Diagrams" className="max-h-[50vh] overflow-y-auto py-1">
          {found.map((doc, i) => (
            <li
              key={doc.id}
              id={`quick-open-${doc.id}`}
              role="option"
              aria-selected={i === index}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(doc)}
              className={`cursor-pointer px-3 py-1.5 ${i === index ? 'bg-pop-yellow text-on-accent' : ''}`}
            >
              <span className="block truncate text-sm font-semibold">{titleOf(doc.source)}</span>
              <span className={`block truncate text-xs ${i === index ? 'text-on-accent/80' : 'text-muted'}`}>{fileNameOf(doc)}</span>
            </li>
          ))}
          {found.length === 0 && <li className="px-3 py-2 text-sm text-muted">No diagram matches.</li>}
        </ul>
      </div>
    </div>
  );
}
