import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import ReactFlow, {
  Background,
  BackgroundVariant,
  Controls,
  Panel,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
} from 'reactflow';
import type { Edge, EdgeChange, Node, NodeChange } from 'reactflow';
import 'reactflow/dist/style.css';
import { Group, Panel as SplitPanel, Separator, type Layout } from 'react-resizable-panels';
import {
  AlignLeft,
  ArrowLeft,
  ChevronRight,
  AlertCircle,
  AlertTriangle,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  FilePlus,
  LayoutGrid,
  Link,
  Link2,
  Code,
  LogIn,
  List,
  Play,
  Trash2,
  Upload,
  Code2,
  Pencil,
  Plus,
  Gauge,
  Network,
  ArchiveRestore,
  Cloud,
  CloudOff,
  Import,
  RefreshCw,
  History,
} from 'lucide-react';
import { examples, parse, type Diagnostic, type DiagramScenario, type DiagramUseCase, type SourceLoc } from '../../dsl';
import { toFlowEdges } from '../../dsl/layout';
import { withEdgeStyles } from '../../dsl/toCanvas';
import Legend from '../Canvas/Legend';
import { useAutoLayout } from '../Diagram/useDiagramLayout';
import { FIT_VIEW_OPTIONS, useFitOnChange } from '../Diagram/useFitOnChange';
import { loadJson, saveJson } from '../../services/storage';
import { FIRST_RUN_SOURCE, exampleFromSearch, withoutExample } from '../../playground/exampleLink';
import {
  BLANK_SOURCE,
  DOCS_KEY,
  addDoc,
  addFile,
  addFiles,
  cloudImports,
  currentDoc,
  fileNameOf,
  initialState,
  isBlank,
  openShared,
  removeDoc,
  renameFile,
  selectDoc,
  titleOf,
  updateCurrent,
  updateDoc,
  type DocumentState,
} from '../../playground/documents';
import { createDocStore } from '../../playground/docStore';
import { groupByEndpoint } from '../../playground/useCaseGroups';
import { filesResolver, importableFiles, teamFileOf, usedImports, type TeamFile } from '../../playground/imports';
import { LONG_LINK_MESSAGE, LONG_LINK_SHORTEN_MESSAGE, decodeShareLink, encodeShareHash, isLongLink, readShareLink, shareUrl, type PlaybackTarget } from '../../playground/share';
import { applyMerge, backupFileName, buildBackup, mergeSummary, planMerge, readBackup } from '../../playground/backup';
import { loadProgress, mergeProgress, saveProgress } from '../../practice/progress';
import { addConnection, addNode, clearPositions, removeConnections, removeNode, renameNode, setNodePosition } from '../../dsl/edit';
import type { Diagram } from '../../dsl/types';
import Palette, { TECH_DRAG_TYPE } from '../Diagram/Palette';
import Inspector from '../Diagram/Inspector';
import FlowParticles from '../Overlay/FlowParticles';
import type { SimOverlay } from '../../sim/overlay';
import ComponentNode from '../Canvas/ComponentNode';
import GroupNode from '../Canvas/GroupNode';
import SystemNode from '../Canvas/SystemNode';
import TextNode from '../Canvas/TextNode';
import { SystemActionsContext, type SystemActions, type SystemNodeData } from '../Canvas/systemActions';
import { useSystemView, type Crumb } from './useSystemView';
import PaneLoading from '../PaneLoading';
import ViewTabs from '../Analysis/ViewTabs';
import { parseView, type View } from '../Analysis/view';
import { useSimulation } from '../Analysis/useSimulation';
import { editorReviewInput } from '../../review/editor';
import CodeEditor, { type CodeEditorHandle } from './CodeEditor';
import Menu, { MenuItem } from './Menu';
import { downloadBlob, downloadText, exportImage, fileNameFor, renderPreviewPng } from './exportDiagram';
import { MAX_PREVIEW_BYTES, createShare, embedSnippet, embedUrl, fetchShare, shareIdFromSearch } from '../../services/shares';
import { ApiError } from '../../services/api';
import { useAccount } from '../../practice/useAccount';
import AccountMenu from '../../practice/AccountMenu';
import { track } from '../../services/metrics';
import Banner, { type BannerMessage } from './Banner';
import ExportMenu from './ExportMenu';
import { useZenMode } from './useZenMode';
import { useKeyboardViewport } from './useKeyboardViewport';
import { ZenButton, ZenCollapse, ZenStatus } from './Zen';
import EditorZone from './EditorZone';
import CloudSection, { CloudIcon } from './CloudStatus';
import { useCloudSync } from './useCloudSync';
import { useCloudFiles } from './useCloudFiles';
import { withCloudErrors } from '../../playground/cloudRefs';
import type { VersionInfo } from '../../playground/versions';
import type { VersionMode } from './VersionViewer';
import { eyebrow, field, iconButton, outlineButton, primaryButton, subBar, toolButton } from './ui';
import Tabs from '../../design/Tabs';
import HelpMenu from '../../onboarding/HelpMenu';
import Header from '../../design/Header';
import { markSeen, startMode, type StartMode } from '../../onboarding/seen';
import type { CoverBand } from '../../onboarding/Tour';
import type { FitInset } from '../Diagram/useFitOnChange';
import { PlaybackMiniMap, UseCasePlayback } from '../UseCases/UseCasePlayback';
import { PLAYBACK_EDGE_TYPES, type PlaybackView } from '../UseCases/playbackView';

// Panes that are not visible at start load on first use.
const HldView = lazy(() => import('../Hld/HldView'));
const ResultsPanel = lazy(() => import('../Analysis/ResultsPanel'));
const ReviewPanel = lazy(() => import('../../review/ReviewPanel'));
const ExamplesGallery = lazy(() => import('./ExamplesGallery'));
const ShortLinksDialog = lazy(() => import('./ShortLinksDialog'));
const ImportDialog = lazy(() => import('./ImportDialog'));
const VersionsDialog = lazy(() => import('./VersionsDialog'));
const VersionViewer = lazy(() => import('./VersionViewer'));
// First-run help costs nothing until it is shown.
const EditorTour = lazy(() => import('../../onboarding/EditorTour'));
const TourHint = lazy(() => import('../../onboarding/TourHint'));
const StarterCard = lazy(() => import('../../onboarding/StarterCard'));

const noop = () => {};
const LEGACY_SOURCE_KEY = 'proschi.playground.source';
/** The splitter's position between the code and diagram panes. */
const SPLIT_KEY = 'proschi.playground.split';
const PARSE_DELAY_MS = 150;
const VIEW_LABEL: Record<View, string> = { diagram: 'Diagram', results: 'Results', hld: 'HLD' };

const nodeTypes = {
  componentNode: ComponentNode,
  groupNode: GroupNode,
  systemNode: SystemNode,
  textNode: TextNode,
};

function loadInitialState(): DocumentState {
  // A share link wins over `?example=`: once an example is edited, the address bar holds the edits.
  const link = decodeShareLink(window.location.hash);
  const example = link ? undefined : exampleFromSearch(window.location.search)?.example;
  return initialState({
    stored: loadJson<unknown>(DOCS_KEY, null),
    legacySource: loadJson<unknown>(LEGACY_SOURCE_KEY, null),
    sharedSource: link?.source ?? example?.source ?? null,
    sharedImports: link?.imports,
    fallbackSource: FIRST_RUN_SOURCE,
  });
}

/** Whether the page opened on a shared diagram or an example link (`?example=<id>`), which should be seen first. */
function isDeepLink(): boolean {
  return (
    readShareLink(window.location.hash) !== null ||
    exampleFromSearch(window.location.search) !== null ||
    new URLSearchParams(window.location.search).has('s')
  );
}

/** Whether this browser has saved diagrams from an earlier visit. */
function isReturning(): boolean {
  return loadJson<unknown>(DOCS_KEY, null) !== null || loadJson<unknown>(LEGACY_SOURCE_KEY, null) !== null;
}

/** The view a link asks for with `?view=` (old names such as `tests` included), else the diagram. */
function initialView(): View {
  return parseView(new URLSearchParams(window.location.search).get('view')) ?? 'diagram';
}

/** The tour on a first visit; only a hint over a shared diagram or example link. */
function initialTourMode(): StartMode {
  return startMode('editor', { deepLink: isDeepLink(), returning: isReturning() });
}

/** The pane a phone opens on: the code on a first visit, where it all starts; the diagram for a link or a returning visitor. */
function initialMobilePane(): 'code' | 'diagram' {
  return !isDeepLink() && !isReturning() ? 'code' : 'diagram';
}

export default function Playground() {
  // An external store, so cloud sync can merge into the latest diagrams (src/playground/docStore.ts).
  const [docStore] = useState(() => createDocStore(loadInitialState()));
  const docState = useSyncExternalStore(docStore.subscribe, docStore.get);
  const setDocState = docStore.set;
  const current = currentDoc(docState);
  /**
   * The `cloud:` files a share link bundled, for the diagram it opened. They are never
   * saved with it (storedImports): only used, while open, where a version cannot be fetched.
   */
  const [linkCloud, setLinkCloud] = useState(() => ({ docId: docStore.get().currentId, files: cloudImports(decodeShareLink(window.location.hash)?.imports) }));
  const linkCloudFiles = linkCloud.docId === current.id ? linkCloud.files : {};
  const source = current.source;
  const rootPath = fileNameOf(current);
  const setSource = useCallback((next: string) => setDocState((s) => updateCurrent(s, next)), [setDocState]);
  /** The reader's own edit in the code pane (not a value set from outside, which the editor echoes back). */
  const typeSource = (next: string) => {
    if (next !== source) track('editor_first_edit', { once: 'browser' });
    setSource(next);
  };
  /** Applies a canvas edit to the current document's text. */
  const editSource = useCallback(
    (edit: (source: string) => string) => {
      track('editor_first_edit', { once: 'browser' });
      setDocState((s) => updateCurrent(s, edit(currentDoc(s).source)));
    },
    [setDocState],
  );

  // A link may point at a use case step; open straight into playback there.
  const [linkPlayback] = useState(() => decodeShareLink(window.location.hash)?.playback);
  const [parsedSource, setParsedSource] = useState(source);
  /** Short links and cloud sources, signed in on a build with accounts; `off` elsewhere. */
  const account = useAccount(noop);
  const [selectedUseCaseId, setSelectedUseCaseId] = useState<string | undefined>(linkPlayback?.useCase);
  const [selectedScenarioId, setSelectedScenarioId] = useState<string | undefined>(linkPlayback?.scenario);
  const [playing, setPlaying] = useState(!!linkPlayback);
  const [initialStep, setInitialStep] = useState(linkPlayback ? linkPlayback.step - 1 : undefined);
  const [playStep, setPlayStep] = useState(0);
  const [showExamples, setShowExamples] = useState(false);
  const [showShortLinks, setShowShortLinks] = useState(false);
  /** The short link made for a document and its imports, so asking again reuses it. */
  const shortLinkRef = useRef<{ key: string; id: string; url: string } | null>(null);
  const [shortening, setShortening] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  /** A saved version open read-only, or two compared, over the editor. */
  const [versionView, setVersionView] = useState<{ mode: VersionMode; versions: VersionInfo[] } | null>(null);
  /** The code and diagram panes' sizes, as last set with the splitter. */
  const [splitLayout] = useState(() => loadJson<Layout | undefined>(SPLIT_KEY, undefined));
  /** Bumped when the splitter is let go, so the diagram re-fits its new width. */
  const [splitMoves, setSplitMoves] = useState(0);
  // Phones show one pane at a time.
  const [mobilePane, setMobilePane] = useState<'code' | 'diagram'>(initialMobilePane);
  const [view, setView] = useState<View>(initialView);
  const [copied, setCopied] = useState(false);
  const [tour, setTour] = useState<StartMode>(initialTourMode);
  /** Bumped by Help → Take the tour, so a replay starts at the first step. */
  const [tourRun, setTourRun] = useState(0);
  /** The screen band a phone tour card covers; the canvas fits the diagram around it. */
  const [tourCover, setTourCover] = useState<CoverBand | null>(null);
  const editorRef = useRef<CodeEditorHandle>(null);
  const teamEditorRef = useRef<CodeEditorHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const backupInputRef = useRef<HTMLInputElement>(null);
  const zen = useZenMode();
  const keyboard = useKeyboardViewport();

  useEffect(() => track('editor_open', { once: 'session' }), []);

  // Re-parse and save shortly after typing stops.
  useEffect(() => {
    const timer = setTimeout(() => {
      setParsedSource(source);
      saveJson(DOCS_KEY, docState);
    }, PARSE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [source, docState]);

  // Imports resolve against the other diagrams saved in this browser. Comparing them
  // by value keeps typing in the current diagram from re-parsing before the debounce.
  // `cloud:` sources are versions in the signed-in account, fetched before the parse (V6).
  const accountStatus = account.state.status;
  const cloudRefs = useCloudFiles(parsedSource, rootPath, { ...current.imports, ...linkCloudFiles }, accountStatus === 'loading' ? null : accountStatus === 'signed-in');
  const importableKey = JSON.stringify({ ...importableFiles(docState.docs, current), ...linkCloudFiles, ...cloudRefs.files });
  const cloudErrorsKey = JSON.stringify(cloudRefs.errors);
  const parsed = useMemo(
    () =>
      parse(parsedSource, {
        path: rootPath,
        resolve: withCloudErrors(filesResolver(JSON.parse(importableKey), rootPath), JSON.parse(cloudErrorsKey), cloudRefs.loading),
      }),
    [parsedSource, rootPath, importableKey, cloudErrorsKey, cloudRefs.loading],
  );
  const { diagram, diagnostics } = parsed;
  const simulation = useSimulation(diagram);
  /** What the canvas shows of the document's systems: collapsed, expanded in place, or navigated into. */
  const systems = useSystemView(current.id, diagram, simulation.analysis, simulation.results);
  const { shown } = systems;
  /** Navigated into a system: its team file, which the code pane shows instead of the document. */
  const team = useMemo(() => (systems.focusFile ? teamFileOf(docState.docs, current, systems.focusFile, cloudRefs.files) : undefined), [systems.focusFile, docState.docs, current, cloudRefs.files]);
  const teamDiagnostics = useMemo(() => (team ? diagnostics.filter((d) => d.file === team.path) : []), [team, diagnostics]);
  const editTeam = (next: string) => {
    if (team?.docId) setDocState((s) => updateDoc(s, team.docId!, next));
  };
  const imports = useMemo(() => usedImports(parsed, JSON.parse(importableKey), rootPath), [parsed, importableKey, rootPath]);
  const importsKey = JSON.stringify(imports);
  const rootDiagnostics = useMemo(() => diagnostics.filter((d) => d.file === undefined), [diagnostics]);
  /** Nodes declared in imported files or team designs (id → file); canvas edits leave them alone. */
  const importedNodes = useMemo(() => new Map(shown.nodes.flatMap((n) => (n.loc.file ? [[n.id, n.loc.file] as const] : []))), [shown]);
  const [notice, setNotice] = useState<string | null>(null);
  // A link that could not be opened says so; the banner also carries long-link and backup messages.
  const [banner, setBanner] = useState<BannerMessage | null>(() => {
    const link = readShareLink(window.location.hash);
    if (link && 'error' in link) return { message: link.error, tone: 'warning' };
    const example = link ? null : exampleFromSearch(window.location.search);
    return example && !example.example ? { message: `There is no example called “${example.id}”; Examples in the top bar lists them all.`, tone: 'warning' } : null;
  });
  const cloud = useCloudSync(docStore, (titles) =>
    setBanner({
      message: `Changed on another device as well, so both versions are kept: yours is now ${titles.map((t) => `"${t}"`).join(', ')}.`,
      tone: 'warning',
    }),
  );
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);
  const nodeIds = useMemo(() => diagram.nodes.map((n) => n.id), [diagram]);
  // Use cases play on what the canvas shows, so navigated into a team design they are that team's.
  const useCase = shown.useCases.find((u) => u.id === selectedUseCaseId) ?? shown.useCases[0];
  const scenario = useCase?.scenarios.find((s) => s.id === selectedScenarioId) ?? useCase?.scenarios[0];
  const hasScenarios = (useCase?.scenarios.length ?? 0) > 1;
  const playback: PlaybackTarget | undefined =
    playing && useCase ? { useCase: useCase.id, ...(hasScenarios && scenario ? { scenario: scenario.id } : {}), step: playStep + 1 } : undefined;
  const playbackKey = playback ? `${playback.useCase}/${playback.scenario ?? ''}#${playback.step}` : '';
  const useCaseGroups = useMemo(() => groupByEndpoint(shown.useCases), [shown]);
  // The player restarts when this changes, so each scenario starts at its first step.
  const playedUseCase = useMemo(
    () => (useCase && scenario ? { id: `${useCase.id}/${scenario.id}`, name: useCase.name, steps: scenario.steps, condition: scenario.condition } : undefined),
    [useCase, scenario],
  );

  // A short link (/s/<id>) sends people here with ?s=<id>: open its diagram, then drop the parameter.
  useEffect(() => {
    const id = shareIdFromSearch(window.location.search);
    if (!id) return;
    let cancelled = false;
    const dropParam = (hash: string) => {
      const params = new URLSearchParams(window.location.search);
      params.delete('s');
      const query = params.toString();
      window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${hash}`);
    };
    fetchShare(id).then(
      (share) => {
        if (cancelled) return;
        openDoc((s) => openShared(s, share.source, share.imports));
        setLinkCloud({ docId: docStore.get().currentId, files: cloudImports(share.imports) });
        dropParam(encodeShareHash(share.source, undefined, share.imports));
      },
      (error: unknown) => {
        if (cancelled) return;
        const gone = error instanceof ApiError && error.status === 404;
        setBanner({ message: gone ? 'This short link no longer exists: its owner deleted it.' : 'Could not open the short link; try again in a moment.', tone: 'warning' });
        if (gone) dropParam(window.location.hash);
      },
    );
    return () => {
      cancelled = true;
    };
    // Once, on load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // An example link has done its job once the example is open: the address bar becomes a share link like any other.
  useEffect(() => {
    const { pathname, search, hash } = window.location;
    if (exampleFromSearch(search) !== null) window.history.replaceState(null, '', `${pathname}${withoutExample(search)}${hash}`);
  }, []);

  // Keep the address bar a shareable link to the diagram, and to the current step while playing.
  useEffect(() => {
    const timer = setTimeout(() => {
      window.history.replaceState(null, '', encodeShareHash(source, playback, imports));
    }, PARSE_DELAY_MS);
    return () => clearTimeout(timer);
    // playbackKey and importsKey capture playback and imports by value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, playbackKey, importsKey]);

  const [nodes, setNodes] = useState<Node[]>([]);
  /** "Overlay: load": the analysis drawn on the diagram, for documents with a traffic block. */
  const [overlayOn, setOverlayOn] = useState(false);
  const canOverlay = (shown.traffic?.length ?? 0) > 0;
  const { overlayOf, summaries } = systems;
  const overlay = useMemo(() => (overlayOn && canOverlay ? overlayOf() : undefined), [overlayOn, canOverlay, overlayOf]);
  const shownNodes = useMemo(
    () =>
      nodes.map((n) => {
        const load = overlay?.nodes[n.id];
        const system = summaries.get(n.id);
        return load || system ? { ...n, data: { ...n.data, ...(load ? { overlay: load } : {}), ...(system ? { system } : {}) } } : n;
      }),
    [nodes, overlay, summaries],
  );
  const systemActions = useMemo<SystemActions>(() => ({ open: systems.open, toggle: systems.toggle }), [systems.open, systems.toggle]);
  const [edges, setEdges] = useState<Edge[]>([]);

  // Usage counts: the first look at the simulation's numbers (the Results or
  // HLD tab, or the load overlay) and at the tests (Results), once per session each.
  useEffect(() => {
    if (view === 'results' || view === 'hld' || (overlayOn && canOverlay)) track('simulation_run', { once: 'session' });
    if (view === 'results') track('test_run', { once: 'session', key: 'test_run:editor' });
  }, [view, overlayOn, canOverlay]);

  // Edges are local state so selection works; keep it across re-parses.
  useEffect(() => {
    setEdges((previous) => {
      const selected = new Set(previous.filter((e) => e.selected).map((e) => e.id));
      return withEdgeStyles(shown, toFlowEdges(shown)).map((e) => (selected.has(e.id) ? { ...e, selected: true } : e));
    });
  }, [shown]);

  // Keep what the user had selected across re-layouts, and the size React Flow measured: a node
  // without one is hidden until measured again, and a re-measure can be lost while the layout glides.
  const showLaidOut = useCallback((laidOut: Node[]) => {
    setNodes((previous) => {
      const before = new Map(previous.map((n) => [n.id, n]));
      return laidOut.map((n) => {
        const p = before.get(n.id);
        if (!p) return n;
        const measured = p.type === n.type && p.width && p.height ? { width: p.width, height: p.height } : {};
        return p.selected || measured.width ? { ...n, ...measured, ...(p.selected ? { selected: true } : {}) } : n;
      });
    });
  }, []);
  const layoutSettled = useAutoLayout(shown, showLaidOut);

  const stopPlaying = () => {
    setPlaying(false);
    setInitialStep(undefined);
  };

  const openDoc = (update: (s: DocumentState) => DocumentState) => {
    setDocState(update);
    stopPlaying();
    setSelectedUseCaseId(undefined);
    setSelectedScenarioId(undefined);
  };

  const renameDocFile = (id: string, current: string) => {
    const name = window.prompt('File name (used by import "…")', current);
    if (name !== null) setDocState((s) => renameFile(s, id, name));
  };

  const deleteDoc = (id: string, title: string) => {
    if (window.confirm(`Delete "${title}"? This cannot be undone.`)) openDoc((s) => removeDoc(s, id));
  };

  const importFile = async (file: File | undefined) => {
    if (!file) return;
    const text = await file.text();
    openDoc((s) => addFile(s, text, file.name));
  };

  const signedIn = account.state.status === 'signed-in';

  const copyText = async (text: string, prompt: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt(prompt, text);
    }
  };

  /** The short link of this document: the one made already, or a new one with a preview of the diagram on screen. */
  const ensureShortLink = async (): Promise<{ id: string; url: string } | undefined> => {
    const key = JSON.stringify([source, imports]);
    if (shortLinkRef.current?.key === key) return shortLinkRef.current;
    setShortening(true);
    try {
      let image: string | undefined;
      const viewport = document.querySelector<HTMLElement>('#pane-panel-diagram .react-flow__viewport');
      if (viewport) image = await renderPreviewPng(viewport, MAX_PREVIEW_BYTES).catch(() => undefined);
      const share = await createShare(source, imports, image);
      shortLinkRef.current = { key, id: share.id, url: share.url };
      return shortLinkRef.current;
    } catch (error) {
      const message =
        error instanceof ApiError && error.status === 401 ? 'your session expired; sign in again.' : error instanceof Error ? error.message : String(error);
      setBanner({ message: `Could not make a short link: ${message}`, tone: 'warning' });
      return undefined;
    } finally {
      setShortening(false);
    }
  };

  const copyShortLink = async () => {
    const share = await ensureShortLink();
    if (!share) return;
    track('share_link_created');
    await copyText(share.url, 'Copy this short link:');
    setBanner({ message: `Short link copied: ${share.url}. Anyone with it can open the diagram; delete it under Share → Your short links.` });
  };

  const copyShareLink = async () => {
    const url = shareUrl(source, window.location, playback, imports);
    track('share_link_created');
    await copyText(url, 'Copy this link:');
    if (isLongLink(url)) {
      setBanner(
        signedIn
          ? { message: LONG_LINK_SHORTEN_MESSAGE, tone: 'warning', action: { label: 'Copy a short link', run: () => void copyShortLink() } }
          : { message: LONG_LINK_MESSAGE, tone: 'warning', action: { label: 'Download .proschi', run: () => downloadText(source, rootPath) } },
      );
    }
  };

  /** An <iframe> of the read-only embed page: a short link signed in, else the diagram in the address. */
  const copyEmbed = async () => {
    const share = signedIn ? await ensureShortLink() : undefined;
    if (signedIn && !share) return;
    const url = embedUrl(window.location.href, share ? { id: share.id } : { hash: encodeShareHash(source, undefined, imports) });
    await copyText(embedSnippet(url, titleOf(source)), 'Copy this embed code:');
    setBanner(
      isLongLink(url)
        ? {
            message: `Embed code copied, but it is long: the diagram is in its address.${account.state.status === 'signed-out' ? ' Signed in, it uses a short link.' : ''}`,
            tone: 'warning',
          }
        : { message: 'Embed code copied: paste the <iframe> into a page, a wiki or a blog post.' },
    );
  };

  const exportAll = () => {
    downloadBlob(new Blob([buildBackup(docState, loadProgress())], { type: 'application/zip' }), backupFileName());
  };

  const importBackup = async (file: File | undefined) => {
    if (!file) return;
    try {
      const backup = readBackup(new Uint8Array(await file.arrayBuffer()));
      const plan = planMerge(docState, backup.docs);
      let replaced = 0;
      const next = applyMerge(docState, plan, ({ existing }) => {
        const yes = window.confirm(`"${titleOf(existing.source)}" (${fileNameOf(existing)}) differs from the copy in the backup. Replace it with the backup's version?`);
        if (yes) replaced++;
        return yes;
      });
      openDoc(() => next);
      saveProgress(mergeProgress(loadProgress(), backup.progress));
      setBanner({ message: mergeSummary(plan, replaced, Object.keys(backup.progress).length) });
    } catch (error) {
      setBanner({ message: `Could not import ${file.name}: ${error instanceof Error ? error.message : String(error)}`, tone: 'warning' });
    }
  };

  const deleteFromCanvas = (nodeIds: string[], edgeIds: string[]) => {
    if (systems.focusFile) {
      setNotice(`This is the design in ${systems.focusFile}; delete it there.`);
      return;
    }
    const selectedEdges = shown.edges.filter((e) => edgeIds.includes(e.id));
    const importedNode = nodeIds.find((id) => importedNodes.has(id));
    const importedEdge = selectedEdges.find((e) => e.loc.file);
    if (importedNode || importedEdge) {
      setNotice(`Declared in ${importedNode ? importedNodes.get(importedNode) : importedEdge!.loc.file}; delete it there.`);
      return;
    }
    // removeNode only sees this document's use cases.
    const usedElsewhere = diagram.useCases.find(
      (u) => u.loc.file && u.scenarios.some((sc) => sc.steps.some((s) => nodeIds.includes(s.fromServiceId) || nodeIds.includes(s.toServiceId))),
    );
    if (usedElsewhere) {
      setNotice(`Used in the use case "${usedElsewhere.name}" in ${usedElsewhere.loc.file}; remove those steps first.`);
      return;
    }
    // Edge ids count duplicates across every file; the text edit needs this document's own ids.
    const rootEdges = parse(source).diagram.edges;
    const rootIds = selectedEdges.flatMap((e) => rootEdges.filter((r) => r.loc.line === e.loc.line).map((r) => r.id));
    let next = removeConnections(source, rootIds);
    for (const id of nodeIds) {
      const result = removeNode(next, id);
      if (result.error !== undefined) {
        window.alert(result.error);
        return;
      }
      next = result.source;
    }
    setSource(next);
  };

  const startPlaying = () => {
    setPlaying(true);
    setView('diagram');
    setMobilePane('diagram');
  };

  /** An image of the diagram asked for in the Export menu; the canvas makes it once it is on screen. */
  const [imageRequest, setImageRequest] = useState<ImageRequest | null>(null);
  const requestImage = (format: ImageRequest['format']) => {
    stopPlaying();
    setView('diagram');
    setMobilePane('diagram');
    setImageRequest({ format });
  };

  const pickScenario = (id: string) => {
    setSelectedScenarioId(id);
    setInitialStep(undefined);
    if (!playing) startPlaying();
  };

  const moveNodes = (moved: { id: string; position: { x: number; y: number } }[]) => {
    const own = moved.filter((n) => !importedNodes.has(n.id));
    if (own.length > 0) editSource((src) => own.reduce((acc, n) => setNodePosition(acc, n.id, n.position), src));
  };

  const renameFromCanvas = (id: string, name: string) => {
    const file = importedNodes.get(id);
    if (file) setNotice(`'${id}' is declared in ${file}; rename it there.`);
    else editSource((src) => renameNode(src, id, name));
  };

  /** Adds a catalog component; one dropped on the canvas is pinned where it fell, a clicked one is laid out. */
  const addFromCanvas = (tech: string, position?: { x: number; y: number }) => {
    if (systems.focusFile) return setNotice(`This is the design in ${systems.focusFile}; add components there.`);
    editSource((src) => addNode(src, { name: tech, tech, position }).source);
  };

  const connectNodes = (from: string, to: string) => {
    if (systems.focusFile || importedNodes.has(from) || importedNodes.has(to)) return setNotice(`Declared in ${systems.focusFile ?? importedNodes.get(from) ?? importedNodes.get(to)}; connect it there.`);
    // The connection may already exist in an imported file.
    if (diagram.edges.some((e) => e.source === from && e.target === to)) return;
    editSource((src) => addConnection(src, from, to));
  };

  /** A problem (or test) in an imported file opens that file, if it is saved in this browser. */
  const selectDiagnostic = (d: SourceLoc) => {
    if (team && d.file === team.path) {
      teamEditorRef.current?.goTo(d.line, d.col);
      return;
    }
    if (d.file === undefined) {
      if (team) systems.goTo('');
      editorRef.current?.goTo(d.line, d.col);
      return;
    }
    const target = docState.docs.find((doc) => doc.id !== current.id && fileNameOf(doc) === d.file);
    if (target && !current.imports?.[d.file]) openDoc((s) => selectDoc(s, target.id));
  };

  const selectInEditor = useCallback((line: number, col: number, length: number, focus: boolean) => editorRef.current?.select(line, col, length, focus), []);
  const diagramKey = useMemo(() => `${diagram.nodes.map((n) => `${n.id}:${n.name}`).join('|')}#${diagram.edges.length}`, [diagram]);
  /** Opens a diagram as a new document, with the files it imports (`files`, path → source) saved beside it. */
  const openExample = (exampleSource: string, files?: Readonly<Record<string, string>>) =>
    openDoc((s) => {
      // An example picked while the current diagram is still empty takes its place instead of piling up "Untitled".
      const next = isBlank(currentDoc(s).source) ? removeDoc(addDoc(s, exampleSource), s.currentId) : addDoc(s, exampleSource);
      return files ? addFiles(next, files) : next;
    });
  const openHldExample = () => {
    const example = examples.find((e) => e.id === 'url-shortener');
    if (!example) return;
    openExample(example.source);
    setView('results');
    setMobilePane('diagram');
  };

  /** Why this diagram has no versions (they live in the account), with what to do; null when it can have them. */
  const versionsHint = ((): { message: string; actions: { label: string; run: () => void }[] } | null => {
    const state = cloud.state;
    if (state.kind === 'unavailable') return { message: 'Versions are saved in a Proschi account, which this copy of the editor does not have.', actions: [] };
    if (state.kind === 'signed-out') {
      return {
        message: 'Versions live in your Proschi account. Sign in, and this diagram syncs there; then you can save versions of it and use them in other diagrams.',
        actions: state.providers.map((p) => ({ label: `Sign in with ${p === 'github' ? 'GitHub' : 'Google'}`, run: () => cloud.signIn(p) })),
      };
    }
    if (state.kind === 'off' || !cloud.enabled) return { message: 'Versions live in your account, and cloud sync is off in this browser.', actions: [{ label: 'Turn on cloud sync', run: () => cloud.setEnabled(true) }] };
    if (cloud.local.has(current.id)) {
      return {
        message: 'This diagram stays in this browser only, so it has no versions. Keep it in your account to save versions of it.',
        actions: cloud.canKeep ? [{ label: 'Keep in cloud', run: () => cloud.keepInCloud(current.id) }] : [],
      };
    }
    if (state.kind === 'loading') return { message: 'Connecting to your account…', actions: [] };
    if (state.kind === 'offline') return { message: 'Offline: versions are in your account, so they need a connection.', actions: [] };
    return null;
  })();
  const versionDraft = useMemo(() => ({ source, files: JSON.parse(importableKey) as Record<string, string> }), [source, importableKey]);
  /** "Restore into draft": the version's text replaces the draft's; the version stays as it is, and Undo puts the draft back. */
  const restoreVersion = (text: string, tag: string) => {
    const before = source;
    setSource(text);
    setVersionView(null);
    setBanner({
      message: `Restored version ${tag} into the draft. The version itself is unchanged.`,
      action: {
        label: 'Undo',
        run: () => {
          setSource(before);
          setBanner(null);
        },
      },
    });
  };

  const canPlay = !!scenario && scenario.steps.length > 0;
  const problemCount = diagnostics.length;
  const sortedDocs = [...docState.docs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return (
    <div
      className="h-[100dvh] flex flex-col bg-paper text-ink"
      style={keyboard.style}
      data-zen={zen.zen || undefined}
      data-keyboard={keyboard.open || undefined}
    >
      <ZenCollapse zen={zen.zen}>
        <Header base="../" current="editor" compact actions={<AccountMenu account={account} />}>
        <div className="flex items-center gap-1 min-w-0 flex-1 sm:flex-none">
          <Menu
            label="Diagrams"
            trigger={
              <>
                <span className="max-w-[7.5rem] sm:max-w-[14rem] truncate">{titleOf(source)}</span>
                <CloudIcon state={cloud.state} />
                <ChevronDown size={14} />
              </>
            }
          >
            {(close) => (
              <>
                <div className={`px-3 pt-1 pb-1.5 ${eyebrow}`}>{cloud.state.kind === 'saved' || cloud.state.kind === 'saving' ? 'Your diagrams' : 'Saved in this browser'}</div>
                <ul className="max-h-72 overflow-y-auto">
                  {sortedDocs.map((doc) => {
                    const title = titleOf(doc.source);
                    const syncing = cloud.enabled && (cloud.state.kind === 'saved' || cloud.state.kind === 'saving');
                    const browserOnly = syncing && cloud.local.has(doc.id);
                    return (
                      <li key={doc.id} className="group flex items-center">
                        <button
                          role="menuitem"
                          onClick={() => {
                            openDoc((s) => selectDoc(s, doc.id));
                            close();
                          }}
                          className={`flex-1 min-w-0 px-3 py-1.5 text-left text-sm hover:bg-ink/10 ${doc.id === docState.currentId ? 'font-bold text-ink shadow-[inset_4px_0_0_rgb(var(--c-pink))]' : 'text-ink/85'}`}
                        >
                          <span className="block truncate">{title}</span>
                          <span className="block truncate text-xs font-normal text-muted">
                            {browserOnly && (
                              <span data-testid="browser-only" className="mr-1 rounded bg-ink/10 px-1 text-ink/80">
                                This browser only
                              </span>
                            )}
                            {fileNameOf(doc)} · {new Date(doc.updatedAt).toLocaleString()}
                          </span>
                        </button>
                        {syncing &&
                          (browserOnly ? (
                            <button
                              aria-label={`Keep ${title} in your account`}
                              title={cloud.canKeep ? 'Keep in cloud' : 'Cloud full: move another diagram to this browser only first'}
                              disabled={!cloud.canKeep}
                              onClick={() => cloud.keepInCloud(doc.id)}
                              className="p-1.5 rounded text-muted hover:text-ink hover:bg-ink/10 disabled:opacity-40 disabled:hover:bg-transparent"
                            >
                              <Cloud size={14} />
                            </button>
                          ) : (
                            <button
                              aria-label={`Move ${title} to this browser only`}
                              title="Move to this browser only (frees a cloud slot)"
                              onClick={() => {
                                if (window.confirm(`Move "${title}" to this browser only? It is removed from your account and your other devices, and stays here.`)) cloud.moveToBrowser(doc.id);
                              }}
                              className="p-1.5 rounded text-muted hover:text-ink hover:bg-ink/10"
                            >
                              <CloudOff size={14} />
                            </button>
                          ))}
                        <button
                          aria-label={`Rename file ${fileNameOf(doc)}`}
                          title="Rename the file imports refer to"
                          onClick={() => renameDocFile(doc.id, fileNameOf(doc))}
                          className="p-1.5 rounded text-muted hover:text-ink hover:bg-ink/10"
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          aria-label={`Delete ${title}`}
                          onClick={() => deleteDoc(doc.id, title)}
                          className="mr-1 p-1.5 rounded text-muted hover:text-fail hover:bg-fail/10"
                        >
                          <Trash2 size={14} />
                        </button>
                      </li>
                    );
                  })}
                </ul>
                <div className="my-1 border-t border-ink/10" />
                <MenuItem
                  icon={<FilePlus size={14} />}
                  onSelect={() => {
                    openDoc((s) => addDoc(s, BLANK_SOURCE));
                    close();
                  }}
                >
                  New diagram
                </MenuItem>
                <MenuItem
                  icon={<BookOpen size={14} />}
                  onSelect={() => {
                    setShowExamples(true);
                    close();
                  }}
                >
                  Examples…
                </MenuItem>
                <MenuItem
                  icon={<Upload size={14} />}
                  onSelect={() => {
                    fileInputRef.current?.click();
                    close();
                  }}
                >
                  Open .proschi file…
                </MenuItem>
                <MenuItem
                  icon={<Import size={14} />}
                  onSelect={() => {
                    setShowImport(true);
                    close();
                  }}
                >
                  Import Mermaid or OpenAPI…
                </MenuItem>
                <MenuItem
                  icon={<AlignLeft size={14} />}
                  onSelect={() => {
                    close();
                    editorRef.current?.format();
                  }}
                >
                  Format code <span className="ml-auto text-xs text-muted">Shift+Alt+F</span>
                </MenuItem>
                {cloudRefs.any && (
                  <MenuItem
                    icon={<RefreshCw size={14} />}
                    onSelect={() => {
                      cloudRefs.refresh();
                      close();
                    }}
                  >
                    Refresh cloud references
                  </MenuItem>
                )}
                <MenuItem
                  icon={<History size={14} />}
                  onSelect={() => {
                    setShowVersions(true);
                    close();
                  }}
                >
                  Versions…
                </MenuItem>
                <div className="my-1 border-t border-ink/10" />
                <MenuItem
                  icon={<ArchiveRestore size={14} />}
                  onSelect={() => {
                    backupInputRef.current?.click();
                    close();
                  }}
                >
                  Import backup…
                </MenuItem>
                <CloudSection cloud={cloud} close={close} />
              </>
            )}
          </Menu>
        </div>
        <HelpMenu
          className="sm:order-last"
          onTour={() => {
            setTourRun((n) => n + 1);
            setTour('tour');
          }}
        />
        <input
          ref={fileInputRef}
          type="file"
          accept=".proschi,.txt,text/plain"
          className="hidden"
          onChange={(e) => {
            importFile(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
        <input
          ref={backupInputRef}
          type="file"
          accept=".zip,application/zip"
          className="hidden"
          aria-label="Import backup"
          onChange={(e) => {
            importBackup(e.target.files?.[0]);
            e.target.value = '';
          }}
        />

        <div className="ps-header__wrap flex items-center gap-2 w-full sm:w-auto sm:min-w-0 sm:flex-wrap sm:ml-auto">
          <button
            onClick={() => setShowExamples(true)}
            aria-label="Examples"
            // Phones keep the room for the use case picker; Examples… is in the Diagrams menu there.
            className={`${toolButton} max-sm:hidden`}
          >
            <BookOpen size={16} />
            <span className="hidden sm:inline">Examples</span>
          </button>

          <select
            aria-label="Use case"
            value={useCase?.id ?? ''}
            onChange={(e) => {
              setSelectedUseCaseId(e.target.value);
              setSelectedScenarioId(undefined);
              setInitialStep(undefined);
            }}
            title={useCase?.name}
            disabled={shown.useCases.length === 0}
            className={`flex-1 min-w-0 sm:flex-none sm:max-w-[11rem] truncate ${field}`}
          >
            {shown.useCases.length === 0 && <option value="">No use cases</option>}
            {useCaseGroups.map((group) =>
              group.label ? (
                <optgroup key={group.label} label={group.label}>
                  {group.useCases.map((u) => (
                    <UseCaseOption key={u.id} useCase={u} />
                  ))}
                </optgroup>
              ) : (
                group.useCases.map((u) => <UseCaseOption key={u.id} useCase={u} />)
              ),
            )}
          </select>

          {playing ? (
            <button
              onClick={stopPlaying}
              aria-label="Back to diagram"
              className={outlineButton}
            >
              <LayoutGrid size={16} />
              <span className="hidden sm:inline">Diagram</span>
            </button>
          ) : (
            <button
              onClick={startPlaying}
              disabled={!canPlay}
              data-tour="play"
              aria-label="Play"
              title={canPlay ? 'Play this use case' : 'Add a usecase with steps to play it'}
              className={primaryButton}
            >
              <Play size={16} />
              <span className="hidden sm:inline">Play</span>
            </button>
          )}

          <ZenButton zen={zen} className={iconButton} />

          <div data-tour="export">
            <ExportMenu
              canImage={nodes.length > 0}
              exporting={imageRequest !== null}
              onImage={requestImage}
              mermaid={{ diagram, useCaseId: useCase?.id, scenarioId: scenario?.id }}
              onDownloadSource={() => downloadText(source, rootPath)}
              onExportAll={exportAll}
            />
          </div>

          <div data-tour="share">
            <Menu
              label={copied ? 'Copied' : 'Share'}
              align="right"
              buttonClassName={outlineButton}
              trigger={
                <>
                  {copied ? <Check size={16} className="text-pass" /> : <Link size={16} />}
                  <span className="hidden sm:inline">{copied ? 'Copied' : shortening ? 'Sharing…' : 'Share'}</span>
                </>
              }
            >
              {(close) => (
                <>
                  <MenuItem
                    icon={<Link size={16} />}
                    onSelect={() => {
                      close();
                      void copyShareLink();
                    }}
                  >
                    {playing ? 'Copy link to this step' : 'Copy link'}
                  </MenuItem>
                  {signedIn && (
                    <MenuItem
                      icon={<Link2 size={16} />}
                      disabled={shortening}
                      onSelect={() => {
                        close();
                        void copyShortLink();
                      }}
                    >
                      Short link with preview
                    </MenuItem>
                  )}
                  <MenuItem
                    icon={<Code size={16} />}
                    disabled={shortening}
                    onSelect={() => {
                      close();
                      void copyEmbed();
                    }}
                  >
                    Embed
                  </MenuItem>
                  {signedIn && (
                    <MenuItem
                      icon={<List size={16} />}
                      onSelect={() => {
                        close();
                        setShowShortLinks(true);
                      }}
                    >
                      Your short links…
                    </MenuItem>
                  )}
                  {account.state.status === 'signed-out' && account.state.providers.length > 0 && (
                    <>
                      <p className="mt-1 border-t border-ink/15 px-3 pt-2 pb-1 text-xs text-muted">Sign in for short links with a preview of the diagram.</p>
                      {account.state.providers.map((provider) => (
                        <MenuItem key={provider} icon={<LogIn size={16} />} onSelect={() => account.signIn(provider)}>
                          Sign in with {provider === 'github' ? 'GitHub' : 'Google'}
                        </MenuItem>
                      ))}
                    </>
                  )}
                </>
              )}
            </Menu>
          </div>
        </div>
        </Header>
        {banner && <Banner banner={banner} onClose={() => setBanner(null)} />}
        {cloud.ask > 0 && (
          <Banner
            banner={{
              message:
                `Add ${cloud.ask} ${cloud.ask === 1 ? 'diagram' : 'diagrams'} from this browser to your account?` +
                (cloud.limit !== null ? ` Your account keeps up to ${cloud.limit}; the most recently edited go first, any others stay here.` : ''),
              action: { label: 'Add to my account', run: () => cloud.answer(true) },
              secondary: { label: 'Keep in this browser only', run: () => cloud.answer(false) },
            }}
            onClose={() => cloud.answer(false)}
          />
        )}

        <div data-tour="panes" className="md:hidden bg-surface">
          <Tabs
            label="View"
            idPrefix="pane"
            fill
            value={mobilePane}
            onChange={setMobilePane}
            items={[
              { id: 'code', label: 'Code', icon: <Code2 size={16} />, badge: problemCount > 0 ? problemCount : undefined },
              { id: 'diagram', label: playing ? 'Playback' : VIEW_LABEL[view], icon: <Network size={16} /> },
            ]}
          />
        </div>
      </ZenCollapse>

      {/* Side by side on wider screens, with a splitter between; phones show one pane at a time (the tabs above). */}
      <Group
        id="playground-split"
        className="flex-1 min-h-0 max-md:[&>[data-mobile-hidden]]:!hidden"
        defaultLayout={splitLayout}
        onLayoutChanged={(layout, meta) => {
          if (!meta.isUserInteraction) return;
          saveJson(SPLIT_KEY, layout);
          setSplitMoves((n) => n + 1);
        }}
      >
        <SplitPanel id="code" defaultSize="42%" minSize="240px" maxSize="75%" data-mobile-hidden={mobilePane !== 'code' || undefined} className="flex">
          <EditorZone
            id="pane-panel-code"
            data-tour="code"
            className="flex flex-1 min-h-0 min-w-0 flex-col"
          >
            {team && <TeamFileBar team={team} up={systems.crumbs[systems.crumbs.length - 2]} onBack={systems.goTo} />}
            {/* Hidden, not unmounted, while a team file is shown, so the document keeps its cursor and undo history. */}
            <div className="flex-1 min-h-0" hidden={!!team}>
              <CodeEditor ref={editorRef} value={source} onChange={typeSource} diagnostics={rootDiagnostics} nodeIds={nodeIds} />
            </div>
            {team && (
              <div className="flex-1 min-h-0">
                <CodeEditor
                  key={team.path}
                  ref={teamEditorRef}
                  value={team.source}
                  onChange={editTeam}
                  readOnly={!!team.readOnly}
                  diagnostics={teamDiagnostics}
                  nodeIds={shown.nodes.map((n) => n.id)}
                />
              </div>
            )}
            <DiagnosticsPanel diagnostics={diagnostics} onSelect={selectDiagnostic} />
          </EditorZone>
        </SplitPanel>
        <Separator
          aria-label="Resize the code and diagram panes"
          className="hidden md:block w-[2px] bg-ink outline-none transition-colors hover:bg-pop-pink focus-visible:bg-pop-pink data-[separator=active]:bg-pop-pink"
        />
        <SplitPanel id="diagram" minSize="320px" data-mobile-hidden={mobilePane !== 'diagram' || undefined} className="flex">
          <section id="pane-panel-diagram" className="flex flex-col flex-1 min-h-0 min-w-0">
            <ZenCollapse zen={zen.zen}>
              {!playing && <ViewTabs view={view} onChange={setView} results={simulation.results} />}
              {hasScenarios && useCase && scenario && (view === 'diagram' || playing) && (
                <ScenarioBar useCase={useCase} current={playing ? scenario.id : undefined} onPick={pickScenario} />
              )}
            </ZenCollapse>
            <div id={playing ? undefined : `view-panel-${view}`} className="flex-1 min-h-0 relative">
              <Suspense fallback={<PaneLoading />}>
                {view === 'results' && !playing ? (
                  <ResultsPanel
                    diagram={diagram}
                    analysis={simulation.analysis}
                    results={simulation.results}
                    onSelect={selectDiagnostic}
                    review={<ReviewPanel source={source} input={() => editorReviewInput(parsedSource, parsed, simulation.analysis, simulation.results)} onSelect={selectDiagnostic} />}
                  />
                ) : view === 'hld' && !playing ? (
                  <HldView
                    diagram={diagram}
                    nodes={nodes}
                    edges={edges}
                    analysis={simulation.analysis}
                    results={simulation.results}
                    onOpenResults={() => setView('results')}
                  />
                ) : (
                  // Playback restyles this same canvas, so pressing Play does not swap, re-lay-out or re-fit it.
                  <UseCasePlayback
                    useCase={playing ? playedUseCase : undefined}
                    nodes={shownNodes}
                    edges={edges}
                    onBack={stopPlaying}
                    initialStep={initialStep}
                    onStepChange={setPlayStep}
                    showHeader={false}
                  >
                    {(pv) => (
                      <ReactFlowProvider>
                        <SystemActionsContext.Provider value={systemActions}>
                        <DiagramView
                          nodes={pv.nodes}
                          playback={pv}
                          overlay={overlay}
                          canOverlay={canOverlay}
                          onToggleOverlay={() => setOverlayOn((on) => !on)}
                          edges={pv.edges}
                          onNodesChange={setNodes}
                          onEdgesChange={setEdges}
                          title={shown.title}
                          hasPinnedNodes={!systems.focusFile && shown.nodes.some((n) => n.position)}
                          importedNodes={importedNodes}
                          onMoveNodes={moveNodes}
                          onConnectNodes={connectNodes}
                          onRenameNode={renameFromCanvas}
                          onAddNode={addFromCanvas}
                          onEdit={editSource}
                          diagram={shown}
                          crumbs={systems.crumbs}
                          focusFile={systems.focusFile}
                          focusReadOnly={!team || !!team.readOnly}
                          focusInbound={systems.focusInbound}
                          onCrumb={systems.goTo}
                          onOpenSystem={(id) => (summaries.get(id)?.linked ? systems.open(id) : setNotice(`'${id}' is declared without a design; add from "file" to its block to open it.`))}
                          onResetLayout={() => editSource(clearPositions)}
                          onDelete={deleteFromCanvas}
                          fitKey={`${mobilePane}:${layoutSettled}`}
                        glideKey={String(splitMoves)}
                          imageRequest={imageRequest}
                          onImageDone={() => setImageRequest(null)}
                          notice={notice}
                          onNotice={setNotice}
                          cover={tour === 'tour' ? tourCover : null}
                        />
                        </SystemActionsContext.Provider>
                      </ReactFlowProvider>
                    )}
                  </UseCasePlayback>
                )}
              </Suspense>
              {nodes.length === 0 && !playing && view === 'diagram' &&
                (isBlank(source) ? (
                  <div className="absolute inset-0 flex items-center justify-center overflow-y-auto p-4">
                    <Suspense fallback={null}>
                      <StarterCard onTemplate={setSource} onExamples={() => setShowExamples(true)} />
                    </Suspense>
                  </div>
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <p className="text-sm text-muted">
                      Start typing, e.g. <code className="px-1 bg-ink/5 rounded font-mono">api -&gt; db</code>
                    </p>
                  </div>
                ))}
            </div>
          </section>
        </SplitPanel>
      </Group>

      {showExamples && (
        <Suspense fallback={<PaneLoading overlay />}>
          <ExamplesGallery
            onClose={() => setShowExamples(false)}
            onPick={(picked, files) => {
              openExample(picked, files);
              setShowExamples(false);
            }}
          />
        </Suspense>
      )}

      {showShortLinks && (
        <Suspense fallback={<PaneLoading overlay />}>
          <ShortLinksDialog
            onClose={() => setShowShortLinks(false)}
            onDeleted={(id) => {
              if (shortLinkRef.current?.id === id) shortLinkRef.current = null;
            }}
          />
        </Suspense>
      )}

      {showVersions && (
        <Suspense fallback={<PaneLoading overlay />}>
          <VersionsDialog
            docId={current.id}
            fileName={rootPath}
            hint={versionsHint}
            pushedVersion={cloud.pushedVersion}
            pull={cloud.pull}
            onView={(tag, listing) => {
              setShowVersions(false);
              setVersionView({ mode: { kind: 'view', tag }, versions: listing.versions });
            }}
            onCompare={(tag, listing) => {
              setShowVersions(false);
              setVersionView({ mode: { kind: 'compare', base: tag, target: '' }, versions: listing.versions });
            }}
            onCopy={(text, message) => {
              void copyText(text, 'Copy this:');
              setBanner({ message });
            }}
            onClose={() => setShowVersions(false)}
          />
        </Suspense>
      )}

      {versionView && (
        <Suspense fallback={<PaneLoading overlay />}>
          <VersionViewer
            docId={current.id}
            fileName={rootPath}
            versions={versionView.versions}
            mode={versionView.mode}
            onMode={(mode) => setVersionView((v) => (v ? { ...v, mode } : v))}
            draft={versionDraft}
            cloudFiles={cloudRefs.files}
            onClose={() => setVersionView(null)}
            onRestore={restoreVersion}
          />
        </Suspense>
      )}

      {showImport && (
        <Suspense fallback={<PaneLoading overlay />}>
          <ImportDialog
            onClose={() => setShowImport(false)}
            onOpen={(imported) => {
              openExample(imported);
              setShowImport(false);
            }}
          />
        </Suspense>
      )}

      {tour === 'tour' && (
        <Suspense fallback={null}>
          <EditorTour
            key={tourRun}
            source={source}
            nodes={diagram.nodes}
            diagramKey={diagramKey}
            canPlay={canPlay}
            playing={playing}
            view={view}
            hasTraffic={(diagram.traffic ?? []).length > 0}
            copied={copied}
            setMobilePane={setMobilePane}
            stopPlaying={stopPlaying}
            edit={editSource}
            selectInEditor={selectInEditor}
            openHldExample={openHldExample}
            onClose={() => setTour(null)}
            onCover={setTourCover}
          />
        </Suspense>
      )}
      <ZenStatus zen={zen} />
      {tour === 'hint' && (
        <Suspense fallback={null}>
          <TourHint
            onStart={() => setTour('tour')}
            onDismiss={() => {
              markSeen('editor');
              setTour(null);
            }}
          />
        </Suspense>
      )}
    </div>
  );
}

function UseCaseOption({ useCase }: { useCase: DiagramUseCase }) {
  const count = useCase.scenarios.length;
  return (
    <option value={useCase.id}>
      {count > 1 ? `${useCase.name} · ${count} scenarios` : useCase.name}
    </option>
  );
}

interface ScenarioBarProps {
  useCase: DiagramUseCase;
  /** The scenario being played, if any. */
  current?: string;
  onPick: (id: string) => void;
}

/** One tab per scenario of the selected use case; picking one plays it. */
function ScenarioBar({ useCase, current, onPick }: ScenarioBarProps) {
  const activeRef = useRef<HTMLButtonElement>(null);
  // On narrow screens the bar scrolls sideways; keep the playing scenario in view.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [current]);

  return (
    <div
      role="tablist"
      aria-label={`Scenarios of ${useCase.name}`}
      className={`flex items-center gap-1.5 px-2 py-1.5 overflow-x-auto ${subBar}`}
    >
      <span className={`hidden sm:inline px-1.5 flex-shrink-0 ${eyebrow}`}>Scenarios</span>
      {useCase.scenarios.map((s: DiagramScenario) => {
        const active = s.id === current;
        const error = s.outcome === 'error';
        const status = s.steps[0]?.failed ? 'failed' : s.steps[0]?.statusCode;
        return (
          <button
            key={s.id}
            ref={active ? activeRef : undefined}
            role="tab"
            aria-selected={active}
            onClick={() => onPick(s.id)}
            title={s.condition ? `Play “${s.name}” — when ${s.condition}` : `Play “${s.name}”`}
            className={`flex-shrink-0 inline-flex items-center gap-1.5 rounded-full border-bw-1 px-3 py-1.5 sm:py-1 text-sm font-semibold whitespace-nowrap transition-[transform,box-shadow] duration-d1 ${
              active
                ? `border-ink text-on-accent shadow-brutal-sm ${error ? 'bg-fail' : 'bg-pop-pink'}`
                : 'border-ink/25 text-ink/85 hover:border-ink hover:bg-surface'
            }`}
          >
            <span aria-hidden="true" className={`h-2 w-2 rounded-[2px] border border-current ${error ? 'bg-fail' : 'bg-pass'}`} />
            {s.name}
            {status !== undefined && <span className={`font-mono text-xs tabular-nums ${active ? '' : error ? 'text-fail' : 'text-muted'}`}>{status}</span>}
            <span className="sr-only">{error ? '(error path)' : '(success path)'}</span>
          </button>
        );
      })}
    </div>
  );
}

interface ImageRequest {
  format: 'png' | 'svg';
}

interface DiagramViewProps {
  nodes: Node[];
  edges: Edge[];
  onNodesChange: (update: (nodes: Node[]) => Node[]) => void;
  onEdgesChange: (update: (edges: Edge[]) => Edge[]) => void;
  title?: string;
  hasPinnedNodes: boolean;
  onMoveNodes: (moved: { id: string; position: { x: number; y: number } }[]) => void;
  onConnectNodes: (from: string, to: string) => void;
  onRenameNode: (id: string, name: string) => void;
  /** Adds a component from the palette, at a canvas position when it was dropped. */
  onAddNode: (techStack: string, position?: { x: number; y: number }) => void;
  /** Applies an inspector edit to the text. */
  onEdit: (edit: (source: string) => string) => void;
  /** The parsed diagram, for the inspector. */
  diagram: Diagram;
  /** The simulation drawn on the canvas, when "Overlay: load" is on. */
  overlay?: SimOverlay;
  /** The document has traffic to simulate, so the overlay can be turned on. */
  canOverlay: boolean;
  onToggleOverlay: () => void;
  onResetLayout: () => void;
  onDelete: (nodeIds: string[], edgeIds: string[]) => void;
  /** Changes when the view becomes visible again, so it can re-fit. */
  fitKey: string;
  /** Changes when the pane was resized in place (the splitter), so it can glide to a new fit. */
  glideKey: string;
  /** An image to export (the Export menu in the header), made once the nodes are drawn. */
  imageRequest: ImageRequest | null;
  onImageDone: () => void;
  /** Nodes declared in imported files (id → file); they cannot be moved here. */
  importedNodes: Map<string, string>;
  /** A short message shown over the canvas, e.g. why an edit was refused. */
  notice: string | null;
  onNotice: (message: string) => void;
  /** A band of the screen covered by a floating card; fitting keeps the diagram clear of it. */
  cover?: CoverBand | null;
  /** The use case playing over the diagram, if any; the canvas is read-only meanwhile. */
  playback: PlaybackView;
  /** Where the canvas is among the document's systems, top first; one crumb at the top. */
  crumbs: Crumb[];
  /** The team file shown when navigated into a system; the canvas cannot edit it. */
  focusFile?: string;
  /** The team file cannot be edited in the code pane (it came with a link, or from a remote source). */
  focusReadOnly?: boolean;
  /** What the rest of the document sends into the design navigated into. */
  focusInbound?: string;
  onCrumb: (path: string) => void;
  /** Navigates into a system box (double-click). */
  onOpenSystem: (id: string) => void;
}

/** Renders the parsed diagram. Canvas edits are written back to the text, which stays the source of truth. */
function DiagramView({
  nodes,
  edges,
  onNodesChange,
  onEdgesChange,
  title,
  hasPinnedNodes,
  onMoveNodes,
  onConnectNodes,
  onRenameNode,
  onAddNode,
  onEdit,
  diagram,
  overlay,
  canOverlay,
  onToggleOverlay,
  onResetLayout,
  onDelete,
  fitKey,
  glideKey,
  imageRequest,
  onImageDone,
  importedNodes,
  notice,
  onNotice,
  cover,
  playback,
  crumbs,
  focusFile,
  focusReadOnly,
  focusInbound,
  onCrumb,
  onOpenSystem,
}: DiagramViewProps) {
  const playing = playback.active;
  const { getNodes, screenToFlowPosition } = useReactFlow();
  const [selection, setSelection] = useState<{ nodes: Node[]; edges: Edge[] }>({ nodes: [], edges: [] });
  const [paletteOpen, setPaletteOpen] = useState(false);
  /** The node or connection whose settings were closed, so they stay closed until something else is selected. */
  const [closedSettings, setClosedSettings] = useState<string | null>(null);
  const single = selection.nodes.length + selection.edges.length === 1 ? (selection.nodes[0] ?? selection.edges[0]) : undefined;
  const selectedNode = selection.nodes.length === 1 ? diagram.nodes.find((n) => n.id === selection.nodes[0].id) : undefined;
  const selectedEdge = selection.edges.length === 1 ? diagram.edges.find((e) => e.id === selection.edges[0].id) : undefined;
  const showSettings = !playing && single !== undefined && single.id !== closedSettings && (selectedNode !== undefined || selectedEdge !== undefined);
  const selectionCount = selection.nodes.length + selection.edges.length;
  const hasSelection = !playing && selectionCount > 0;
  const singleNode = selection.nodes.length === 1 && selection.edges.length === 0 ? selection.nodes[0] : undefined;
  const dragStartRef = useRef(new Map<string, { x: number; y: number }>());

  // React Flow re-sends the selection when this handler changes, so it must be stable
  // and must not store an equal selection again.
  const handleSelectionChange = useCallback(({ nodes: selectedNodes, edges: selectedEdges }: { nodes: Node[]; edges: Edge[] }) => {
    setSelection((current) => {
      const same =
        current.nodes.map((n) => n.id).join('|') === selectedNodes.map((n) => n.id).join('|') &&
        current.edges.map((e) => e.id).join('|') === selectedEdges.map((e) => e.id).join('|');
      return same ? current : { nodes: selectedNodes, edges: selectedEdges };
    });
  }, []);

  const promptRename = (node: Node) => {
    // Ask the parent straight away, which explains why a node from an imported file cannot be renamed.
    if (importedNodes.has(node.id)) return onRenameNode(node.id, '');
    const name = window.prompt('Display name', node.data?.name ?? node.id);
    if (name !== null) onRenameNode(node.id, name);
  };

  const deleteSelection = () => {
    if (playing || (selection.nodes.length === 0 && selection.edges.length === 0)) return;
    onDelete(
      selection.nodes.map((n) => n.id),
      selection.edges.map((e) => e.id).filter((id) => !id.startsWith('step:')),
    );
  };
  const wrapperRef = useRef<HTMLDivElement>(null);

  // The canvas may have just been opened for the export (from another tab, the
  // code pane on a phone, or playback): wait until it is shown and its nodes are measured.
  useEffect(() => {
    if (!imageRequest) return;
    let cancelled = false;
    let frame = 0;
    const tick = async () => {
      if (cancelled) return;
      const viewport = wrapperRef.current?.querySelector<HTMLElement>('.react-flow__viewport');
      const drawn = getNodes();
      const ready = !!viewport && viewport.getClientRects().length > 0 && drawn.length > 0 && drawn.every((n) => n.width && n.height);
      if (!ready && frame++ < 120) {
        requestAnimationFrame(() => void tick());
        return;
      }
      try {
        if (!ready || !viewport) throw new Error('the diagram is not on screen');
        const legend = wrapperRef.current?.querySelector<HTMLElement>('.pc-legend') ?? undefined;
        await exportImage(imageRequest.format, drawn, viewport, fileNameFor(title, imageRequest.format), legend);
      } catch (error) {
        console.error('Export failed:', error);
        window.alert('Sorry, the image could not be exported.');
      } finally {
        if (!cancelled) onImageDone();
      }
    };
    requestAnimationFrame(() => void tick());
    return () => {
      cancelled = true;
    };
    // Once per request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageRequest]);
  // Re-fit once nodes are measured after being added or removed, not on every drag.
  // The part of the canvas a covering band hides, measured after layout.
  const [inset, setInset] = useState<FitInset | undefined>(undefined);
  const coverKey = cover ? `${cover.top}:${cover.bottom}` : '';
  useLayoutEffect(() => {
    const rect = wrapperRef.current?.getBoundingClientRect();
    if (!cover || !rect || rect.height === 0) return setInset(undefined);
    // A card docked low hides the bottom of the canvas, one docked high its top.
    const low = cover.top + cover.bottom > rect.top + rect.bottom;
    const top = low ? 0 : Math.max(0, cover.bottom - rect.top);
    const bottom = low ? Math.max(0, rect.bottom - cover.top) : 0;
    setInset((prev) => (prev?.top === top && prev?.bottom === bottom ? prev : { top, bottom }));
    // coverKey captures cover by value; fitKey changes when the pane is shown again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coverKey, fitKey]);
  // No animated fit: d3-zoom reads the pane size on the transition's first tick, and a pane hidden by
  // then (phone Code/Diagram tabs) is 0×0, which interpolates the viewport to NaN. Nodes already glide via settle.
  // The exception: playback and the splitter resize a pane that stays shown, and there the diagram glides to its new fit.
  useFitOnChange(`${nodes.map((n) => n.id).join('|')}#${fitKey}`, { wrapper: wrapperRef, inset, glide: `${playing ? 'playing' : ''}:${glideKey}` });

  const handleEdgesChange = useCallback(
    (changes: EdgeChange[]) => onEdgesChange((current) => applyEdgeChanges(changes, current)),
    [onEdgesChange],
  );

  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => onNodesChange((current) => applyNodeChanges(changes, current)),
    [onNodesChange],
  );

  return (
    <div
      ref={wrapperRef}
      className="relative h-full"
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(TECH_DRAG_TYPE)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDrop={(e) => {
        const tech = e.dataTransfer.getData(TECH_DRAG_TYPE);
        if (!tech || playing) return;
        e.preventDefault();
        setPaletteOpen(false);
        onAddNode(tech, screenToFlowPosition({ x: e.clientX, y: e.clientY }));
      }}
      onKeyDown={(e) => {
        const target = e.target as HTMLElement;
        if ((e.key === 'Delete' || e.key === 'Backspace') && !target.closest('input, textarea, [contenteditable]')) {
          e.preventDefault();
          deleteSelection();
        }
      }}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={PLAYBACK_EDGE_TYPES}
        // Playing a use case shows it over this canvas, read-only.
        nodesDraggable={!playing}
        nodesConnectable={!playing}
        elementsSelectable={!playing}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onNodeDragStart={(_event, _node, dragged) => {
          dragStartRef.current = new Map(dragged.map((n) => [n.id, { ...n.position }]));
        }}
        onNodeDragStop={(_event, _node, dragged) => {
          // A click is a drag that never moved; only real moves are written to the text.
          const moved = dragged.filter((n) => {
            const start = dragStartRef.current.get(n.id);
            return !start || Math.abs(start.x - n.position.x) > 1 || Math.abs(start.y - n.position.y) > 1;
          });
          // Nodes from imported files snap back: their text is in another file.
          const locked = moved.filter((n) => importedNodes.has(n.id));
          if (locked.length > 0) {
            const back = new Map(locked.map((n) => [n.id, dragStartRef.current.get(n.id)]));
            onNodesChange((current) => current.map((n) => {
              const start = back.get(n.id);
              return start ? { ...n, position: start } : n;
            }));
            onNotice(`'${locked[0].id}' is declared in ${importedNodes.get(locked[0].id)}; move it there.`);
          }
          if (moved.length > locked.length) onMoveNodes(moved.map((n) => ({ id: n.id, position: n.position })));
        }}
        onConnect={(connection) => connection.source && connection.target && onConnectNodes(connection.source, connection.target)}
        // A system box opens its team design; renaming it stays in its settings and the selection bar.
        onNodeDoubleClick={(_event, node) => {
          if (playing) return;
          if (node.type === 'systemNode' || node.data?.system) onOpenSystem(node.id);
          else promptRename(node);
        }}
        onSelectionChange={handleSelectionChange}
        // Deleting goes through the text; React Flow's own delete would only hide the node until the next render.
        deleteKeyCode={null}
        zoomOnDoubleClick={false}
        fitView
        fitViewOptions={FIT_VIEW_OPTIONS}
        minZoom={0.1}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
        {overlay && !playing && <FlowParticles flows={overlay.flows} nodes={overlay.nodes} />}
        <Controls showInteractive={false} />
        {playing && <PlaybackMiniMap view={playback} />}
        {!playing && crumbs.length > 1 && (
          <Panel position="top-left">
            <Breadcrumbs crumbs={crumbs} file={focusFile} readOnly={focusReadOnly} inbound={focusInbound} onPick={onCrumb} />
          </Panel>
        )}
        {!playing && crumbs.length === 1 && <Panel position="top-left">
          <div className="relative">
            <button
              type="button"
              onClick={() => setPaletteOpen((o) => !o)}
              aria-label="Add component"
              aria-expanded={paletteOpen}
              aria-haspopup="dialog"
              className={`${toolButton} border-ink bg-surface shadow-brutal-sm aria-expanded:bg-pop-yellow aria-expanded:text-on-accent`}
            >
              <Plus size={16} />
              <span className="whitespace-nowrap">
                Add<span className="hidden sm:inline"> component</span>
              </span>
            </button>
            {paletteOpen && (
              <div className="absolute left-0 top-full z-10 mt-1">
                <Palette
                  onAdd={(tech) => {
                    setPaletteOpen(false);
                    onAddNode(tech);
                  }}
                  onClose={() => setPaletteOpen(false)}
                />
              </div>
            )}
          </div>
        </Panel>}
        {/* With the settings card open, Delete is in its header; this bar covers several items or a closed card. */}
        {(notice || (hasSelection && !showSettings)) && (
          <Panel position="bottom-center" className="flex flex-col items-center gap-2">
            {notice && (
              <p role="status" className="rounded border-bw-1 border-ink bg-ink px-3 py-1.5 text-xs font-semibold text-paper shadow-brutal-sm">
                {notice}
              </p>
            )}
            {hasSelection && !showSettings && (
              <div role="toolbar" aria-label="Selection" className="flex items-center gap-1 rounded-full border-bw-1 border-ink bg-surface py-1 pl-4 pr-1 shadow-brutal-sm">
                <span className="max-w-[10rem] truncate pr-1 text-sm font-semibold text-ink">
                  {singleNode ? (singleNode.data?.name ?? singleNode.id) : `${selectionCount} selected`}
                </span>
                {singleNode && (
                  <button
                    type="button"
                    onClick={() => promptRename(singleNode)}
                    className="inline-flex items-center gap-1 rounded-full px-3 py-2 text-sm font-semibold text-ink hover:bg-ink/10"
                  >
                    <Pencil size={14} />
                    Rename
                  </button>
                )}
                <button
                  type="button"
                  onClick={deleteSelection}
                  className="inline-flex items-center gap-1 rounded-full px-3 py-2 text-sm font-semibold text-red-700 dark:text-red-300 hover:bg-fail/10"
                >
                  <Trash2 size={14} />
                  Delete
                </button>
              </div>
            )}
          </Panel>
        )}
        {nodes.length > 0 && !playing && !(hasSelection && !showSettings) && (
          <Panel position="bottom-right" className="hidden md:block text-xs text-muted bg-paper/85 rounded px-2 py-1">
            Drag to pin · select to edit settings · drag between dots to connect · Delete removes
          </Panel>
        )}
        {nodes.length > 0 && (!playing || diagram.legend) && (
          <Panel position="top-right" className="flex flex-col items-end gap-2">
            {!playing && (
              <div className="flex items-center gap-1">
                {canOverlay && (
                  <button
                    type="button"
                    onClick={onToggleOverlay}
                    aria-pressed={overlay !== undefined}
                    title="Show how busy each node is and the requests flowing, at the traffic block's rates"
                    className={`${toolButton} aria-pressed:border-ink aria-pressed:bg-pop-yellow aria-pressed:text-on-accent aria-pressed:shadow-brutal-sm`}
                  >
                    <Gauge size={16} />
                    <span className="whitespace-nowrap">
                      <span className="hidden sm:inline">Overlay: </span>load
                    </span>
                  </button>
                )}
                {hasPinnedNodes && (
                  <button
                    onClick={onResetLayout}
                    title="Remove every pos x,y and lay the diagram out automatically"
                    className={toolButton}
                  >
                    <LayoutGrid size={16} />
                    Auto-layout
                  </button>
                )}
              </div>
            )}
            {diagram.legend && <Legend entries={diagram.legend} />}
          </Panel>
        )}
      </ReactFlow>
      {showSettings && (
        <div className="pointer-events-none absolute inset-x-2 bottom-2 z-10 flex max-h-[55%] max-md:[[data-keyboard]_&]:max-h-[calc(100%-1rem)] md:inset-x-auto md:bottom-auto md:right-2 md:top-14 md:max-h-[calc(100%-4.5rem)] md:w-72">
          <Inspector
            key={single.id}
            node={selectedNode}
            edge={selectedNode ? undefined : selectedEdge}
            capacity={selectedNode ? diagram.capacity?.find((c) => c.node === selectedNode.id) : undefined}
            importedFrom={selectedNode ? importedNodes.get(selectedNode.id) : selectedEdge?.loc.file}
            system={selectedNode ? (nodes.find((n) => n.id === selectedNode.id)?.data as SystemNodeData | undefined)?.system : undefined}
            onEdit={onEdit}
            onDelete={deleteSelection}
            onClose={() => setClosedSettings(single.id)}
          />
        </div>
      )}
    </div>
  );
}

/** Where the canvas is among the document's systems (Drone startup › Order Processing), with the way back. */
function Breadcrumbs({ crumbs, file, readOnly, inbound, onPick }: { crumbs: Crumb[]; file?: string; readOnly?: boolean; inbound?: string; onPick: (path: string) => void }) {
  const up = crumbs[crumbs.length - 2];
  return (
    <nav aria-label="Breadcrumb" className="flex max-w-[min(calc(100vw-7rem),36rem)] flex-col rounded border-bw-1 border-ink bg-surface py-1 pl-1 pr-3 shadow-brutal-sm">
      <div className="flex min-w-0 items-center gap-1">
        <button type="button" onClick={() => onPick(up.path)} aria-label={`Back to ${up.name}`} title={`Back to ${up.name}`} className={`${iconButton} !h-7 !w-7`}>
          <ArrowLeft size={15} />
        </button>
        <ol className="flex min-w-0 items-center gap-1 text-sm">
          {crumbs.map((c, i) => {
            const last = i === crumbs.length - 1;
            return (
              <li key={c.path} className={`flex items-center gap-1 ${last ? 'min-w-0' : 'flex-none max-sm:[&:not(:first-child)]:hidden'}`}>
                {i > 0 && <ChevronRight size={14} className="flex-none text-muted" aria-hidden="true" />}
                {last ? (
                  <span aria-current="page" className="truncate font-bold text-ink">
                    {c.name}
                  </span>
                ) : (
                  <button type="button" onClick={() => onPick(c.path)} className="max-w-[10rem] truncate rounded px-1 font-semibold text-ink/75 underline-offset-2 hover:text-ink hover:underline">
                    {c.name}
                  </button>
                )}
              </li>
            );
          })}
        </ol>
        {file && (
          <span className="ml-2 hidden flex-none font-mono text-xs text-muted md:inline" title={readOnly ? 'This design is in its own file, which cannot be edited here' : 'This design is in its own file, open in the code pane'}>
            {file}
            {readOnly && ' · read-only'}
          </span>
        )}
      </div>
      {inbound && (
        <span className="min-w-0 truncate pb-0.5 pl-9 text-xs font-semibold text-ink/75" title="The load shown includes what the rest of the document sends into this design">
          {inbound}
        </span>
      )}
    </nav>
  );
}

/** Above the code pane while it shows a team file: which file, whether it can be edited here, and the way back. */
function TeamFileBar({ team, up, onBack }: { team: TeamFile; up: Crumb; onBack: (path: string) => void }) {
  return (
    <div className="border-b border-ink/15 bg-surface py-1 pl-1 pr-3 text-xs" aria-label="Team file" role="group">
      <div className="flex min-w-0 items-center gap-2">
        <button type="button" onClick={() => onBack(up.path)} title={`Back to ${up.name}`} className={`${iconButton} !h-7 !w-auto flex-none gap-1 !px-2 text-xs font-semibold`}>
          <ArrowLeft size={14} aria-hidden="true" />
          <span className="max-w-[8rem] truncate">{up.name}</span>
        </button>
        <span className="min-w-0 truncate font-mono text-ink" title={team.path}>
          {team.path}
        </span>
        <span className={`ml-auto flex-none ${team.readOnly ? 'font-bold text-ink' : 'text-muted'}`}>{team.readOnly ? 'Read-only' : 'Saved in this browser'}</span>
      </div>
      {team.readOnly && <p className="pb-0.5 pl-2 pt-0.5 text-ink/75">{team.readOnly}</p>}
    </div>
  );
}

interface DiagnosticsPanelProps {
  diagnostics: Diagnostic[];
  onSelect: (diagnostic: Diagnostic) => void;
}

function DiagnosticsPanel({ diagnostics, onSelect }: DiagnosticsPanelProps) {
  if (diagnostics.length === 0) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-xs text-pass border-t border-ink/15">
        <CheckCircle2 size={14} />
        No problems
      </div>
    );
  }

  return (
    <ul data-testid="diagnostics" className="max-h-36 overflow-y-auto border-t border-ink/15 text-xs font-mono">
      {diagnostics.map((d, i) => (
        <li key={i}>
          <button onClick={() => onSelect(d)} className="w-full flex items-start gap-2 px-3 py-1.5 text-left hover:bg-ink/10">
            {d.severity === 'error' ? (
              <AlertCircle size={14} className="text-fail flex-shrink-0 mt-px" />
            ) : (
              <AlertTriangle size={14} className="text-pop-yellow flex-shrink-0 mt-px" />
            )}
            <span className="text-muted tabular-nums flex-shrink-0">
              {d.file ? `${d.file}:` : ''}
              {d.line}:{d.col}
            </span>
            <span className="text-ink font-sans">{d.message}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
