import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { ChevronRight, Cloud, Copy, FilePlus, FolderInput, FolderPlus, HardDrive, LogIn, MoreHorizontal, PanelLeftClose, Pencil, Search, Trash2, X } from 'lucide-react';
import { fileNameOf, titleOf, type SavedDiagram } from '../../playground/documents';
import { allFolders, baseOf, buildTree, cleanFolder, folderOf, matchesQuery, type FolderNode } from '../../playground/folders';
import { PROVIDER_LABEL } from '../../practice/account';
import { loadJson, saveJson } from '../../services/storage';
import { MenuItem } from './Menu';
import { cloudLabel, type CloudSync } from './useCloudSync';
import { eyebrow, field } from './ui';

/** Folders closed in the tree, in localStorage: every folder starts open. */
const COLLAPSED_KEY = 'proschi.playground.collapsed';
const DOC_TYPE = 'application/x-proschi-doc';
const FOLDER_TYPE = 'application/x-proschi-folder';

export interface FileActions {
  open: (id: string) => void;
  /** A new blank diagram in `folder` ('' at the top), opened. */
  create: (folder: string) => void;
  /** Gives a diagram a new file base name, keeping its folder. */
  renameFile: (id: string, fileName: string) => void;
  move: (id: string, folder: string) => void;
  duplicate: (id: string) => void;
  remove: (id: string) => void;
  renameFolder: (from: string, to: string) => void;
  removeFolder: (folder: string) => void;
}

interface FileSidebarProps {
  docs: SavedDiagram[];
  currentId: string;
  actions: FileActions;
  cloud: CloudSync;
  /** Phones: the drawer's close button. */
  onClose?: () => void;
  /** Wide screens: folds the sidebar into a rail. */
  onCollapse?: () => void;
}

type Editing = { kind: 'file'; id: string } | { kind: 'folder'; path: string } | { kind: 'new-folder'; parent: string } | null;

interface RowMenuState {
  x: number;
  y: number;
  items: (close: () => void) => ReactNode;
}

const rowBase = 'group flex items-center gap-1 rounded pr-1 text-sm';
const actionButton = 'p-1 rounded text-muted hover:text-ink hover:bg-ink/10 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 max-md:opacity-100';

/** The editor's diagrams as a folder tree: open, add, rename, move (drag or "Move to"), duplicate and delete them. */
export default function FileSidebar({ docs, currentId, actions, cloud, onClose, onCollapse }: FileSidebarProps) {
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set(loadJson<string[]>(COLLAPSED_KEY, [])));
  const [editing, setEditing] = useState<Editing>(null);
  const [menu, setMenu] = useState<RowMenuState | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  const tree = useMemo(() => buildTree(docs), [docs]);
  const folders = useMemo(() => allFolders(docs), [docs]);
  const current = docs.find((d) => d.id === currentId);
  const syncing = cloud.enabled && (cloud.state.kind === 'saved' || cloud.state.kind === 'saving');

  // The open diagram's folders open with it.
  const currentFolder = current ? folderOf(fileNameOf(current)) : '';
  useEffect(() => {
    if (!currentFolder) return;
    setCollapsed((c) => {
      const open = [...c].filter((f) => !(currentFolder === f || currentFolder.startsWith(`${f}/`)));
      return open.length === c.size ? c : new Set(open);
    });
  }, [currentFolder]);

  const toggle = (path: string) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (!next.delete(path)) next.add(path);
      saveJson(COLLAPSED_KEY, [...next]);
      return next;
    });

  const openMenu = (button: HTMLElement, items: RowMenuState['items']) => {
    const r = button.getBoundingClientRect();
    setMenu({ x: r.right, y: r.bottom + 4, items });
  };

  const dragProps = (type: string, value: string) => ({
    draggable: editing === null,
    onDragStart: (e: DragEvent) => {
      e.dataTransfer.setData(type, value);
      e.dataTransfer.effectAllowed = 'move';
    },
  });

  /** Drop a diagram or folder on `folder` ('' for the top). */
  const dropProps = (folder: string) => ({
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes(DOC_TYPE) && !e.dataTransfer.types.includes(FOLDER_TYPE)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      setDropTarget(folder);
    },
    onDragLeave: (e: DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as globalThis.Node | null)) setDropTarget((t) => (t === folder ? null : t));
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDropTarget(null);
      const id = e.dataTransfer.getData(DOC_TYPE);
      const path = e.dataTransfer.getData(FOLDER_TYPE);
      if (id) actions.move(id, folder);
      else if (path) actions.renameFolder(path, folder ? `${folder}/${baseOf(path)}` : baseOf(path));
    },
  });

  /** The "Move to" list, without the folders `skip` rules out. */
  const moveItems = (skip: (folder: string) => boolean, run: (folder: string) => void) => (close: () => void) => {
    const targets = ['', ...folders].filter((f) => !skip(f));
    return (
      <>
        <div className={`px-3 pt-1 pb-1 ${eyebrow}`}>Move to</div>
        {targets.length === 0 && <p className="px-3 py-1 text-sm text-muted">No other folder to move it to.</p>}
        {targets.map((f) => (
          <MenuItem
            key={f || '/'}
            icon={<FolderInput size={14} />}
            onSelect={() => {
              close();
              run(f);
            }}
          >
            <span className="truncate">{f || 'Top level'}</span>
          </MenuItem>
        ))}
      </>
    );
  };

  const fileMenu = (doc: SavedDiagram) => (close: () => void) => {
    const title = titleOf(doc.source);
    const browserOnly = cloud.local.has(doc.id);
    const folder = folderOf(fileNameOf(doc));
    return (
      <>
        <MenuItem
          icon={<Pencil size={14} />}
          onSelect={() => {
            close();
            setEditing({ kind: 'file', id: doc.id });
          }}
        >
          Rename file
        </MenuItem>
        <MenuItem
          icon={<FolderInput size={14} />}
          onSelect={() => setMenu((m) => m && { ...m, items: moveItems((f) => f === folder, (f) => actions.move(doc.id, f)) })}
        >
          Move to…
        </MenuItem>
        <MenuItem
          icon={<Copy size={14} />}
          onSelect={() => {
            close();
            actions.duplicate(doc.id);
          }}
        >
          Duplicate
        </MenuItem>
        {syncing &&
          (browserOnly ? (
            <MenuItem
              icon={<Cloud size={14} />}
              disabled={!cloud.canKeep}
              onSelect={() => {
                close();
                cloud.keepInCloud(doc.id);
              }}
            >
              {cloud.canKeep ? 'Keep in your account' : 'Account full: keep in your account'}
            </MenuItem>
          ) : (
            <MenuItem
              icon={<HardDrive size={14} />}
              onSelect={() => {
                close();
                if (window.confirm(`Move "${title}" to this browser only? It is removed from your account and your other devices, and stays here.`)) cloud.moveToBrowser(doc.id);
              }}
            >
              Move to this browser only
            </MenuItem>
          ))}
        <div className="my-1 border-t border-ink/10" />
        <MenuItem
          icon={<Trash2 size={14} />}
          onSelect={() => {
            close();
            actions.remove(doc.id);
          }}
        >
          Delete
        </MenuItem>
      </>
    );
  };

  const folderMenu = (node: FolderNode) => (close: () => void) => (
    <>
      <MenuItem
        icon={<FilePlus size={14} />}
        onSelect={() => {
          close();
          actions.create(node.path);
        }}
      >
        New diagram here
      </MenuItem>
      <MenuItem
        icon={<FolderPlus size={14} />}
        onSelect={() => {
          close();
          // A folded folder opens, so the name field shows inside it.
          setCollapsed((c) => {
            if (!c.has(node.path)) return c;
            const next = new Set(c);
            next.delete(node.path);
            saveJson(COLLAPSED_KEY, [...next]);
            return next;
          });
          setEditing({ kind: 'new-folder', parent: node.path });
        }}
      >
        New folder here
      </MenuItem>
      <MenuItem
        icon={<Pencil size={14} />}
        onSelect={() => {
          close();
          setEditing({ kind: 'folder', path: node.path });
        }}
      >
        Rename folder
      </MenuItem>
      <MenuItem
        icon={<FolderInput size={14} />}
        onSelect={() => {
          const parent = folderOf(node.path);
          setMenu((m) => m && { ...m, items: moveItems((f) => f === parent || f === node.path || f.startsWith(`${node.path}/`), (f) => actions.renameFolder(node.path, f ? `${f}/${node.name}` : node.name)) });
        }}
      >
        Move to…
      </MenuItem>
      <div className="my-1 border-t border-ink/10" />
      <MenuItem
        icon={<Trash2 size={14} />}
        onSelect={() => {
          close();
          actions.removeFolder(node.path);
        }}
      >
        Delete folder
      </MenuItem>
    </>
  );

  const fileRow = (doc: SavedDiagram, depth: number, showPath: boolean) => {
    const title = titleOf(doc.source);
    const name = fileNameOf(doc);
    const active = doc.id === currentId;
    const browserOnly = syncing && cloud.local.has(doc.id);
    if (editing?.kind === 'file' && editing.id === doc.id) {
      return (
        <li key={doc.id} style={{ paddingLeft: depth * 12 + 22 }} className="pr-1 py-0.5">
          <NameInput
            label={`New file name for ${title}`}
            initial={baseOf(name)}
            onDone={(value) => {
              setEditing(null);
              if (value && value !== baseOf(name)) actions.renameFile(doc.id, value);
            }}
          />
        </li>
      );
    }
    return (
      // Dropped on a diagram, a file or folder goes into that diagram's folder.
      <li key={doc.id} className={`${rowBase} ${active ? 'bg-ink/10' : 'hover:bg-ink/5'}`} {...dragProps(DOC_TYPE, doc.id)} {...dropProps(folderOf(name))}>
        <button
          type="button"
          data-testid="file"
          aria-current={active ? 'true' : undefined}
          title={`${name} · ${new Date(doc.updatedAt).toLocaleString()}`}
          onClick={() => actions.open(doc.id)}
          onDoubleClick={() => setEditing({ kind: 'file', id: doc.id })}
          style={{ paddingLeft: depth * 12 + 22 }}
          className={`flex-1 min-w-0 py-1 text-left ${active ? 'font-bold text-ink shadow-[inset_3px_0_0_rgb(var(--c-pink))]' : 'text-ink/85'}`}
        >
          <span className="block truncate">{title}</span>
          {showPath && <span className="block truncate text-xs font-normal text-muted">{name}</span>}
        </button>
        {browserOnly && (
          <span data-testid="browser-only" title="This browser only: not in your account" className="text-muted">
            <HardDrive size={12} aria-label="This browser only" />
          </span>
        )}
        <button type="button" aria-label={`Actions for ${title}`} className={actionButton} onClick={(e) => openMenu(e.currentTarget, fileMenu(doc))}>
          <MoreHorizontal size={14} />
        </button>
      </li>
    );
  };

  const newFolderRow = (parent: string, depth: number) =>
    editing?.kind === 'new-folder' &&
    editing.parent === parent && (
      <li style={{ paddingLeft: depth * 12 + 8 }} className="pr-1 py-0.5">
        <NameInput
          label="New folder name"
          initial=""
          placeholder="Folder name"
          onDone={(value) => {
            setEditing(null);
            if (cleanFolder(value)) actions.create(parent ? `${parent}/${value}` : value);
          }}
        />
      </li>
    );

  const folderRows = (node: FolderNode, depth: number): ReactNode => (
    <>
      {node.folders.map((f) => {
        const open = !collapsed.has(f.path);
        return (
          <li key={`folder:${f.path}`} role="none">
            {editing?.kind === 'folder' && editing.path === f.path ? (
              <div style={{ paddingLeft: depth * 12 + 8 }} className="pr-1 py-0.5">
                <NameInput
                  label={`New name for folder ${f.name}`}
                  initial={f.name}
                  onDone={(value) => {
                    setEditing(null);
                    const parent = folderOf(f.path);
                    if (value && value !== f.name) actions.renameFolder(f.path, parent ? `${parent}/${value}` : value);
                  }}
                />
              </div>
            ) : (
              <div className={`${rowBase} ${dropTarget === f.path ? 'bg-pop-yellow/40' : 'hover:bg-ink/5'}`} {...dragProps(FOLDER_TYPE, f.path)} {...dropProps(f.path)}>
                <button
                  type="button"
                  data-testid="folder"
                  aria-expanded={open}
                  onClick={() => toggle(f.path)}
                  onDoubleClick={() => setEditing({ kind: 'folder', path: f.path })}
                  style={{ paddingLeft: depth * 12 + 4 }}
                  className="flex-1 min-w-0 flex items-center gap-1 py-1 text-left font-semibold text-ink"
                >
                  <ChevronRight size={14} className={`shrink-0 text-muted transition-transform ${open ? 'rotate-90' : ''}`} />
                  <span className="truncate">{f.name}</span>
                </button>
                <button type="button" aria-label={`Actions for folder ${f.name}`} className={actionButton} onClick={(e) => openMenu(e.currentTarget, folderMenu(f))}>
                  <MoreHorizontal size={14} />
                </button>
              </div>
            )}
            {open && <ul>{folderRows(f, depth + 1)}</ul>}
          </li>
        );
      })}
      {newFolderRow(node.path, depth)}
      {node.docs.map((d) => fileRow(d, depth, false))}
    </>
  );

  const found = query.trim() ? [...docs].filter((d) => matchesQuery(d, query)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) : null;

  return (
    <aside aria-label="Diagrams" className="flex h-full w-full flex-col bg-surface text-ink">
      <div className="flex items-center gap-1 px-2 pt-2">
        <span className={`flex-1 pl-1 ${eyebrow}`}>Diagrams</span>
        <button type="button" aria-label="New diagram" title="New diagram" onClick={() => actions.create(currentFolder)} className="p-1.5 rounded text-muted hover:text-ink hover:bg-ink/10">
          <FilePlus size={15} />
        </button>
        <button
          type="button"
          aria-label="New folder"
          title="New folder"
          onClick={() => {
            setQuery('');
            setEditing({ kind: 'new-folder', parent: '' });
          }}
          className="p-1.5 rounded text-muted hover:text-ink hover:bg-ink/10"
        >
          <FolderPlus size={15} />
        </button>
        {onCollapse && (
          <button type="button" aria-label="Hide sidebar" title="Hide sidebar" onClick={onCollapse} className="p-1.5 rounded text-muted hover:text-ink hover:bg-ink/10">
            <PanelLeftClose size={15} />
          </button>
        )}
        {onClose && (
          <button type="button" aria-label="Close diagrams" onClick={onClose} className="p-1.5 rounded text-muted hover:text-ink hover:bg-ink/10">
            <X size={15} />
          </button>
        )}
      </div>
      <div className="relative px-2 py-2">
        <Search size={14} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted" />
        <input
          type="search"
          aria-label="Search diagrams"
          placeholder="Search"
          value={query}
          onChange={(e) => {
            // The tree swaps for the results, so a half-typed name would vanish unsaved.
            setEditing(null);
            setQuery(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setQuery('');
            if (e.key === 'Enter' && found?.[0]) actions.open(found[0].id);
          }}
          className={`w-full !py-1 pl-7 ${field}`}
        />
      </div>
      <div className={`flex-1 min-h-0 overflow-y-auto px-1 pb-2 ${dropTarget === '' ? 'bg-pop-yellow/20' : ''}`} {...dropProps('')}>
        {found ? (
          found.length ? (
            <ul aria-label="Search results">{found.map((d) => fileRow(d, 0, true))}</ul>
          ) : (
            <p className="px-3 py-2 text-sm text-muted">No diagram matches "{query.trim()}".</p>
          )
        ) : (
          <ul aria-label="Files">{folderRows(tree, 0)}</ul>
        )}
      </div>
      <StorageFooter cloud={cloud} />
      {menu && <RowMenu menu={menu} onClose={closeMenu} />}
    </aside>
  );
}

/** Where the diagrams are kept, at the bottom of the sidebar; signed out, the way to keep them on every device. */
function StorageFooter({ cloud }: { cloud: CloudSync }) {
  const { state } = cloud;
  const local = state.kind === 'unavailable' || state.kind === 'signed-out' || state.kind === 'off' || state.kind === 'offline' || state.kind === 'error';
  return (
    <div className="border-t-bw-1 border-ink/20 px-3 py-2 text-xs text-muted">
      <p data-testid="files-storage" className="flex items-start gap-1.5">
        {local ? <HardDrive size={13} className="mt-px shrink-0" aria-hidden="true" /> : <Cloud size={13} className="mt-px shrink-0" aria-hidden="true" />}
        <span>{state.kind === 'signed-out' ? 'Saved in this browser only' : cloudLabel(state)}</span>
      </p>
      {state.kind === 'signed-out' && state.providers.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {state.providers.map((provider) => (
            <button
              key={provider}
              type="button"
              onClick={() => cloud.signIn(provider)}
              className="inline-flex items-center gap-1 rounded border-bw-1 border-ink bg-surface px-2 py-1 font-semibold text-ink hover:bg-pop-yellow hover:text-on-accent"
            >
              <LogIn size={12} />
              Sync with {PROVIDER_LABEL[provider]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** An inline name field: Enter or leaving it saves, Escape cancels (an empty answer). */
function NameInput({ label, initial, placeholder, onDone }: { label: string; initial: string; placeholder?: string; onDone: (value: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.focus();
    const dot = initial.lastIndexOf('.proschi');
    input.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial]);
  const finish = (value: string) => {
    if (done.current) return;
    done.current = true;
    onDone(value.trim());
  };
  return (
    <input
      ref={ref}
      aria-label={label}
      defaultValue={initial}
      placeholder={placeholder}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(e.currentTarget.value);
        if (e.key === 'Escape') finish('');
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
      className={`w-full !py-0.5 ${field}`}
    />
  );
}

/** A row's actions, fixed on the screen so the scrolling tree does not clip it. */
function RowMenu({ menu, onClose }: { menu: RowMenuState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onPointer = (e: MouseEvent) => !ref.current?.contains(e.target as globalThis.Node) && onClose();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose, menu]);
  const width = 224;
  const left = Math.max(8, Math.min(menu.x - width, window.innerWidth - width - 8));
  return (
    <div
      ref={ref}
      role="menu"
      style={{ left, top: Math.min(menu.y, window.innerHeight - 48), width }}
      className="fixed z-50 max-h-[60vh] overflow-y-auto rounded-brutal border-bw-2 border-ink bg-surface py-1.5 text-ink shadow-brutal-md"
    >
      {menu.items(onClose)}
    </div>
  );
}
