import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { IconButton, Theme } from '@radix-ui/themes';
import {
  columnFilteringFeature,
  createColumnHelper,
  createFilteredRowModel,
  createSortedRowModel,
  filterFn_includesString,
  globalFilteringFeature,
  rowSortingFeature,
  tableFeatures,
  useTable,
} from '@tanstack/react-table';
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  Copy,
  FileText,
  FileJson,
  FileSpreadsheet,
  Folder,
  FolderOpen,
  LoaderCircle,
  Moon,
  Plus,
  RefreshCw,
  Sun,
  Trash2,
  X,
} from 'lucide-react';
import { version } from '../package.json';
import { api } from './lib/api';
import { encodeClipboardCell, parseClipboardText } from './lib/clipboard';
import type {
  ColumnSchema,
  ColumnType,
  FolderTreeEntry,
  FolderTreeRoot,
  TableDocument,
  ValidationIssue,
} from './types';

const columnTypes: Array<{ value: ColumnType; label: string }> = [
  { value: 'string', label: 'String' },
  { value: 'int', label: 'Int' },
  { value: 'float', label: 'Float' },
  { value: 'bool', label: 'Bool' },
  { value: 'json_ref', label: 'JSON Ref' },
  { value: 'enum', label: 'Enum' },
  { value: 'string_array', label: 'String Array' },
  { value: 'vector2int', label: 'Vector2Int' },
  { value: 'string_dictionary', label: 'String Dictionary' },
];

const makeRow = (columnCount: number) => Array.from({ length: columnCount }, () => '');

const dataGridFeatures = tableFeatures({
  columnFilteringFeature,
  globalFilteringFeature,
  rowSortingFeature,
  filteredRowModel: createFilteredRowModel(),
  sortedRowModel: createSortedRowModel(),
});

interface DataGridRow {
  sourceIndex: number;
  values: string[];
}

const dataGridColumnHelper = createColumnHelper<typeof dataGridFeatures, DataGridRow>();

function compareCellValues(type: ColumnType, left: unknown, right: unknown) {
  const leftText = String(left ?? '');
  const rightText = String(right ?? '');

  if (type === 'int' || type === 'float') {
    const leftNumber = Number(leftText);
    const rightNumber = Number(rightText);
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber;
  }

  if (type === 'bool') {
    const rank = (value: string) => value.toLowerCase() === 'true' ? 1 : value.toLowerCase() === 'false' ? 0 : -1;
    const difference = rank(leftText) - rank(rightText);
    if (difference !== 0) return difference;
  }

  return leftText.localeCompare(rightText, undefined, { numeric: true, sensitivity: 'base' });
}

interface HeaderMenuState {
  index: number;
  x: number;
  y: number;
}

interface RowMenuState {
  rowIndex: number;
  x: number;
  y: number;
}

interface ColumnDialogState {
  mode: 'edit' | 'add';
  index: number;
}

interface CellPosition {
  rowPosition: number;
  columnIndex: number;
}

interface DocumentTab {
  id: string;
  title: string;
  path: string;
  dirty: boolean;
}

interface DocumentTabSession {
  document: TableDocument;
  savedSnapshot: string;
  issues: ValidationIssue[];
  undoHistory: TableDocument[];
}

const cellKey = (rowIndex: number, columnIndex: number) => `${rowIndex}:${columnIndex}`;
const undoHistoryLimit = 100;

type AppAppearance = 'light' | 'dark';

function initialAppearance(): AppAppearance {
  const stored = window.localStorage.getItem('game-data-editor-appearance');
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function cloneDocument(document: TableDocument): TableDocument {
  return {
    ...document,
    schema: { ...document.schema, columns: document.schema.columns.map((column) => ({ ...column })) },
    rows: document.rows.map((row) => [...row]),
  };
}

export default function App() {
  const [appearance, setAppearance] = useState<AppAppearance>(initialAppearance);
  const [document, setDocumentState] = useState<TableDocument | null>(null);
  const [savedSnapshot, setSavedSnapshot] = useState('');
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const [selectedCells, setSelectedCells] = useState<Set<string>>(new Set());
  const [editingCell, setEditingCell] = useState<string | null>(null);
  const [folderRoots, setFolderRoots] = useState<FolderTreeRoot[]>([]);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [activeCsvPath, setActiveCsvPath] = useState<string | null>(null);
  const [tabs, setTabs] = useState<DocumentTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [, setNotice] = useState('打开一个 CSV 文件开始编辑。');
  const [isBusy, setIsBusy] = useState(false);
  const [isFolderTreeLoading, setIsFolderTreeLoading] = useState(true);
  const [isFolderActionBusy, setIsFolderActionBusy] = useState(false);
  const [headerMenu, setHeaderMenu] = useState<HeaderMenuState | null>(null);
  const [rowMenu, setRowMenu] = useState<RowMenuState | null>(null);
  const [columnDialog, setColumnDialog] = useState<ColumnDialogState | null>(null);
  const [siblingSheets, setSiblingSheets] = useState<string[]>([]);
  const [linkTargetRowIndex, setLinkTargetRowIndex] = useState<number | null>(null);
  const fileMenuActions = useRef<Record<string, () => void>>({});
  const saveInProgress = useRef(false);
  const knownFolderRoots = useRef(new Set<string>());
  const dragSelectionStart = useRef<CellPosition | null>(null);
  const documentRef = useRef<TableDocument | null>(null);
  const savedSnapshotRef = useRef('');
  const issuesRef = useRef<ValidationIssue[]>([]);
  const tabSessions = useRef(new Map<string, DocumentTabSession>());
  const activeTabIdRef = useRef<string | null>(null);
  const nextTabId = useRef(1);
  const undoHistory = useRef<TableDocument[]>([]);
  const activeHistoryGroup = useRef<string | null>(null);

  const syncActiveTab = useCallback((nextDocument: TableDocument) => {
    const tabId = activeTabIdRef.current;
    if (!tabId) return;
    const session = tabSessions.current.get(tabId);
    if (!session) return;
    session.document = nextDocument;
    session.undoHistory = undoHistory.current;
    const dirty = JSON.stringify(nextDocument) !== session.savedSnapshot;
    setTabs((current) => current.map((tab) => tab.id === tabId
      ? { ...tab, title: `${nextDocument.tableName}.csv`, dirty }
      : tab));
  }, []);

  const replaceDocument = useCallback((next: TableDocument, clearUndoHistory = false) => {
    if (clearUndoHistory) undoHistory.current = [];
    activeHistoryGroup.current = null;
    documentRef.current = next;
    setDocumentState(next);
    syncActiveTab(next);
  }, [syncActiveTab]);

  const changeDocument = useCallback((
    updater: (current: TableDocument) => TableDocument,
    historyGroup?: string,
  ) => {
    const current = documentRef.current;
    if (!current) return;
    const next = updater(current);
    if (next === current) return;

    if (!historyGroup || activeHistoryGroup.current !== historyGroup) {
      if (undoHistory.current.length >= undoHistoryLimit) undoHistory.current.shift();
      undoHistory.current.push(cloneDocument(current));
    }
    activeHistoryGroup.current = historyGroup ?? null;
    documentRef.current = next;
    setDocumentState(next);
    syncActiveTab(next);
  }, [syncActiveTab]);

  const undoDocument = useCallback(() => {
    const previous = undoHistory.current.pop();
    if (!previous) return;
    activeHistoryGroup.current = null;
    documentRef.current = previous;
    setDocumentState(previous);
    syncActiveTab(previous);
    setSelectedRows(new Set());
    setSelectedCells(new Set());
    setEditingCell(null);
    setNotice('已撤销上一步修改。');
  }, [syncActiveTab]);

  const isDirty = document !== null && JSON.stringify(document) !== savedSnapshot;

  const displayTab = useCallback((tabId: string) => {
    const session = tabSessions.current.get(tabId);
    if (!session) return;
    activeTabIdRef.current = tabId;
    setActiveTabId(tabId);
    documentRef.current = session.document;
    setDocumentState(session.document);
    savedSnapshotRef.current = session.savedSnapshot;
    setSavedSnapshot(session.savedSnapshot);
    issuesRef.current = session.issues;
    setIssues(session.issues);
    undoHistory.current = session.undoHistory;
    activeHistoryGroup.current = null;
    setActiveCsvPath(session.document.sourcePath);
    setSelectedRows(new Set());
    setSelectedCells(new Set());
    setEditingCell(null);
    setHeaderMenu(null);
    setRowMenu(null);
    setColumnDialog(null);
    setLinkTargetRowIndex(null);
  }, []);

  const activateTab = useCallback(async (tabId: string, activateBackend = true) => {
    if (tabId === activeTabIdRef.current) return;
    const session = tabSessions.current.get(tabId);
    if (!session) return;
    setIsBusy(true);
    try {
      if (activateBackend) await api.activateCsvSession(session.document.sourcePath);
      displayTab(tabId);
    } catch (error) {
      setNotice(`无法切换 Sheet：${messageFrom(error)}`);
    } finally {
      setIsBusy(false);
    }
  }, [displayTab]);

  const addDocumentTab = useCallback((opened: TableDocument, initialIssues: ValidationIssue[] = []) => {
    const existing = [...tabSessions.current.entries()]
      .find(([, session]) => session.document.sourcePath.toLowerCase() === opened.sourcePath.toLowerCase());
    if (existing) {
      displayTab(existing[0]);
      return existing[0];
    }

    const id = `sheet-${nextTabId.current++}`;
    const snapshot = JSON.stringify(opened);
    const session: DocumentTabSession = {
      document: opened,
      savedSnapshot: snapshot,
      issues: initialIssues,
      undoHistory: [],
    };
    tabSessions.current.set(id, session);
    setTabs((current) => [...current, {
      id,
      title: `${opened.tableName}.csv`,
      path: opened.sourcePath,
      dirty: false,
    }]);
    displayTab(id);
    return id;
  }, [displayTab]);

  const closeTab = useCallback((tabId: string) => {
    const closingIndex = tabs.findIndex((tab) => tab.id === tabId);
    if (closingIndex < 0) return;
    const closingTab = tabs[closingIndex];
    if (closingTab.dirty && !window.confirm(`“${closingTab.title}” 有未保存修改，仍要关闭吗？`)) return;

    const nextTabs = tabs.filter((tab) => tab.id !== tabId);
    tabSessions.current.delete(tabId);
    setTabs(nextTabs);
    if (tabId !== activeTabIdRef.current) return;

    const nextTab = nextTabs[Math.min(closingIndex, nextTabs.length - 1)];
    if (nextTab) {
      activeTabIdRef.current = null;
      void activateTab(nextTab.id);
      return;
    }

    activeTabIdRef.current = null;
    setActiveTabId(null);
    documentRef.current = null;
    setDocumentState(null);
    setSavedSnapshot('');
    savedSnapshotRef.current = '';
    setIssues([]);
    issuesRef.current = [];
    undoHistory.current = [];
    setActiveCsvPath(null);
  }, [activateTab, tabs]);

  useEffect(() => {
    window.localStorage.setItem('game-data-editor-appearance', appearance);
    window.document.documentElement.style.colorScheme = appearance;
  }, [appearance]);
  const issueByCell = useMemo(() => {
    const index = new Map<string, ValidationIssue[]>();
    issues.forEach((issue) => {
      if (issue.rowIndex === null || issue.column === null) return;
      const key = `${issue.rowIndex}:${issue.column}`;
      index.set(key, [...(index.get(key) ?? []), issue]);
    });
    return index;
  }, [issues]);
  const tableRows = useMemo<DataGridRow[]>(
    () => document?.rows.map((values, sourceIndex) => ({ sourceIndex, values })) ?? [],
    [document?.rows],
  );
  const columnSchemaSignature = JSON.stringify(document?.schema.columns ?? []);
  const tableColumns = useMemo(() => dataGridColumnHelper.columns(
    (document?.schema.columns ?? []).map((column, columnIndex) => dataGridColumnHelper.accessor(
      (row) => row.values[columnIndex] || undefined,
      {
        id: column.name,
        header: column.name,
        filterFn: filterFn_includesString,
        sortDescFirst: false,
        sortUndefined: 'last',
        sortFn: (rowA, rowB, columnId) => compareCellValues(
          column.type,
          rowA.getValue(columnId),
          rowB.getValue(columnId),
        ),
      },
    )),
  ), [columnSchemaSignature]);
  const dataTable = useTable({
    features: dataGridFeatures,
    columns: tableColumns,
    data: tableRows,
    globalFilterFn: filterFn_includesString,
    getRowId: (row) => String(row.sourceIndex),
  });
  const folderWatchNeedsRetry = useMemo(
    () => folderRoots.some((root) => !root.available || Boolean(root.error)),
    [folderRoots],
  );

  useEffect(() => {
    if (!document) {
      setIssues([]);
      issuesRef.current = [];
      return;
    }

    const validatingTabId = activeTabIdRef.current;
    const timeout = window.setTimeout(async () => {
      try {
        const nextIssues = await api.validate(document);
        const session = validatingTabId ? tabSessions.current.get(validatingTabId) : undefined;
        if (session) session.issues = nextIssues;
        if (validatingTabId === activeTabIdRef.current) {
          issuesRef.current = nextIssues;
          setIssues(nextIssues);
        }
      } catch (error) {
        setNotice(`校验失败：${messageFrom(error)}`);
      }
    }, 250);

    return () => window.clearTimeout(timeout);
  }, [document]);

  useEffect(() => {
    dataTable.resetSorting(true);
    dataTable.resetColumnFilters(true);
    dataTable.resetGlobalFilter(true);
  }, [activeTabId, document?.tableName, columnSchemaSignature]);

  useEffect(() => {
    const warnOnClose = (event: BeforeUnloadEvent) => {
      if (!tabs.some((tab) => tab.dirty)) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnOnClose);
    return () => window.removeEventListener('beforeunload', warnOnClose);
  }, [tabs]);

  useEffect(() => {
    if (!headerMenu && !rowMenu) return;
    const closeMenu = () => {
      setHeaderMenu(null);
      setRowMenu(null);
    };
    window.addEventListener('mousedown', closeMenu);
    return () => window.removeEventListener('mousedown', closeMenu);
  }, [headerMenu, rowMenu]);

  useEffect(() => {
    if (!columnDialog) return;
    let active = true;
    void api.listSiblingSheets()
      .then((sheets) => { if (active) setSiblingSheets(sheets); })
      .catch((error) => {
        if (active) {
          setSiblingSheets([]);
          setNotice(`无法读取同目录 Sheet：${messageFrom(error)}`);
        }
      });
    return () => { active = false; };
  }, [columnDialog]);

  useEffect(() => {
    if (linkTargetRowIndex === null) return;
    const frame = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        window.document.querySelector(`[data-row-index="${linkTargetRowIndex}"]`)
          ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [document?.tableName, linkTargetRowIndex]);

  useEffect(() => {
    const csvName = document ? `${document.tableName}.csv` : null;
    const appTitle = `Game Data Editor v${version}`;
    const title = csvName ? `${appTitle} - ${csvName}${isDirty ? '*' : ''}` : appTitle;
    window.document.title = title;
    try {
      void getCurrentWindow().setTitle(title).catch(() => {
        // The browser-only development preview has no native Tauri window.
      });
    } catch {
      // The browser-only development preview has no native Tauri window.
    }
  }, [document?.tableName, isDirty]);

  const refreshFolderTree = useCallback(async (showLoading = false) => {
    if (showLoading) setIsFolderTreeLoading(true);
    try {
      setFolderRoots(await api.listFolderTree());
      return true;
    } catch (error) {
      setNotice(`无法读取文件夹列表：${messageFrom(error)}`);
      return false;
    } finally {
      if (showLoading) setIsFolderTreeLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshFolderTree(true);
  }, [refreshFolderTree]);

  useEffect(() => {
    const activeRootPaths = new Set(folderRoots.map((root) => root.path));
    knownFolderRoots.current.forEach((path) => {
      if (!activeRootPaths.has(path)) knownFolderRoots.current.delete(path);
    });
    setExpandedFolders((current) => {
      let changed = false;
      const next = new Set(current);
      folderRoots.forEach((root) => {
        if (!knownFolderRoots.current.has(root.path)) {
          knownFolderRoots.current.add(root.path);
          next.add(root.path);
          changed = true;
        }
      });
      return changed ? next : current;
    });
  }, [folderRoots]);

  useEffect(() => {
    let active = true;
    let timeout: number | undefined;
    let unlisten: UnlistenFn | undefined;

    const registerListener = async () => {
      try {
        const removeListener = await listen('folder-tree-changed', () => {
          if (timeout !== undefined) window.clearTimeout(timeout);
          timeout = window.setTimeout(() => {
            void refreshFolderTree();
          }, 180);
        });
        if (active) unlisten = removeListener;
        else removeListener();
      } catch (error) {
        // The tree remains usable through its manual refresh control if events are unavailable.
        console.warn('Unable to listen for folder tree updates:', error);
      }
    };

    void registerListener();
    return () => {
      active = false;
      if (timeout !== undefined) window.clearTimeout(timeout);
      unlisten?.();
    };
  }, [refreshFolderTree]);

  useEffect(() => {
    if (!folderWatchNeedsRetry) return;
    const interval = window.setInterval(() => {
      void refreshFolderTree();
    }, 5_000);
    return () => window.clearInterval(interval);
  }, [folderWatchNeedsRetry, refreshFolderTree]);

  const openDocument = useCallback(async (
    loader: () => Promise<TableDocument | null>,
    requestedPath?: string,
  ) => {
    if (requestedPath) {
      const existing = [...tabSessions.current.entries()]
        .find(([, session]) => session.document.sourcePath.toLowerCase() === requestedPath.toLowerCase());
      if (existing) {
        await activateTab(existing[0]);
        return;
      }
    }
    setIsBusy(true);
    try {
      const opened = await loader();
      if (!opened) return;
      addDocumentTab(opened);
      setNotice(opened.schemaWasMissing ? '未找到 Schema，已按文本列加载；首次保存会生成 Schema。' : '文件已加载。');
    } catch (error) {
      setNotice(`无法打开 CSV：${messageFrom(error)}`);
    } finally {
      setIsBusy(false);
    }
  }, [activateTab, addDocumentTab]);

  const openCsv = () => openDocument(() => api.openCsv());

  const openCsvAtPath = (path: string) => openDocument(
    () => api.openCsvAtPath(path),
    path,
  );

  const addFolder = async () => {
    setIsFolderActionBusy(true);
    try {
      const roots = await api.chooseAndAddFolder();
      if (!roots) return;
      setFolderRoots(roots);
      setNotice('文件夹列表已更新。');
    } catch (error) {
      setNotice(`无法添加文件夹：${messageFrom(error)}`);
    } finally {
      setIsFolderActionBusy(false);
    }
  };

  const refreshFolders = async () => {
    if (await refreshFolderTree(true)) setNotice('文件夹列表已刷新。');
  };

  const removeFolder = async (root: FolderTreeRoot) => {
    if (!window.confirm(`将 “${root.name}” 从左侧文件夹列表移除？这不会删除磁盘上的任何文件。`)) return;
    setIsFolderActionBusy(true);
    try {
      setFolderRoots(await api.removeManagedFolder(root.path));
      knownFolderRoots.current.delete(root.path);
      setExpandedFolders((current) => {
        const next = new Set(current);
        next.delete(root.path);
        return next;
      });
      setNotice(`已从文件夹列表移除 “${root.name}”。`);
    } catch (error) {
      setNotice(`无法移除文件夹：${messageFrom(error)}`);
    } finally {
      setIsFolderActionBusy(false);
    }
  };

  const toggleFolder = (path: string) => {
    setExpandedFolders((current) => {
      const next = new Set(current);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
  };

  const createCsv = async () => {
    setIsBusy(true);
    try {
      const created = await api.createCsv();
      if (!created) return;
      addDocumentTab(created);
      setNotice('已新建 CSV 数据包，请添加列和数据行。');
    } catch (error) {
      setNotice(`无法新建 CSV：${messageFrom(error)}`);
    } finally {
      setIsBusy(false);
    }
  };

  const save = useCallback(async () => {
    if (!document || isBusy || saveInProgress.current) return;
    saveInProgress.current = true;
    const documentToSave = { ...document, schemaWasMissing: false };
    setIsBusy(true);
    try {
      const result = await api.save(documentToSave);
      issuesRef.current = result.issues;
      setIssues(result.issues);
      const savingTabId = activeTabIdRef.current;
      const savingSession = savingTabId ? tabSessions.current.get(savingTabId) : undefined;
      if (savingSession) savingSession.issues = result.issues;
      if (!result.saved) {
        setNotice(result.message ?? '保存前校验未通过。');
        return;
      }
      replaceDocument(documentToSave);
      const snapshot = JSON.stringify(documentToSave);
      savedSnapshotRef.current = snapshot;
      setSavedSnapshot(snapshot);
      if (savingSession) savingSession.savedSnapshot = snapshot;
      if (savingTabId) setTabs((current) => current.map((tab) => tab.id === savingTabId ? { ...tab, dirty: false } : tab));
      setNotice('已安全保存 CSV 与 Schema。');
    } catch (error) {
      setNotice(`保存失败：${messageFrom(error)}`);
    } finally {
      saveInProgress.current = false;
      setIsBusy(false);
    }
  }, [document, isBusy, replaceDocument]);

  const exportPackage = async () => {
    if (!document) return;
    setIsBusy(true);
    try {
      const destination = await api.exportPackage(document);
      setNotice(`已导出完整数据包：${destination}`);
    } catch (error) {
      setNotice(`导出失败：${messageFrom(error)}`);
    } finally {
      setIsBusy(false);
    }
  };

  const updateCell = (rowIndex: number, columnIndex: number, value: string) => {
    changeDocument((current) => {
      const next = cloneDocument(current);
      next.rows[rowIndex][columnIndex] = value;
      return next;
    }, `cell:${rowIndex}:${columnIndex}`);
  };

  const addRowAfter = (rowIndex: number) => {
    const insertIndex = rowIndex + 1;
    changeDocument((current) => {
      const next = cloneDocument(current);
      next.rows.splice(insertIndex, 0, makeRow(next.schema.columns.length));
      return next;
    });
    setSelectedRows(new Set([insertIndex]));
    setSelectedCells(new Set());
    setEditingCell(null);
    setLinkTargetRowIndex((current) => current !== null && current >= insertIndex ? current + 1 : current);
    setNotice(`已在第 ${rowIndex + 1} 行后新增空行，请填写唯一 id。`);
  };

  const duplicateSelected = async () => {
    if (!document || selectedRows.size !== 1) {
      setNotice('请选择一行后再复制。');
      return;
    }
    const rowIndex = [...selectedRows][0];
    const source = document.rows[rowIndex];
    setIsBusy(true);
    try {
      const copy = [...source];
      for (const [columnIndex, column] of document.schema.columns.entries()) {
        if (column.type === 'json_ref' && source[columnIndex]) {
          copy[columnIndex] = await api.cloneJsonRef(source[columnIndex]);
        }
      }
      copy[0] = '';
      changeDocument((current) => {
        const next = cloneDocument(current);
        next.rows.splice(rowIndex + 1, 0, copy);
        return next;
      });
      setSelectedRows(new Set([rowIndex + 1]));
      setSelectedCells(new Set());
      setEditingCell(null);
      setNotice('已复制该行及其 JSON 引用；请填写新的 id。');
    } catch (error) {
      setNotice(`复制失败：${messageFrom(error)}`);
    } finally {
      setIsBusy(false);
    }
  };

  const deleteSelected = async () => {
    if (!document || selectedRows.size === 0) return;
    const deletedRowCount = selectedRows.size;
    const jsonColumnIndices = document.schema.columns
      .map((column, index) => column.type === 'json_ref' ? index : -1)
      .filter((index) => index >= 0);
    const deletedReferences = new Set(
      document.rows
        .filter((_, index) => selectedRows.has(index))
        .flatMap((row) => jsonColumnIndices.map((index) => row[index]).filter(Boolean)),
    );
    const nextDocument = cloneDocument(document);
    nextDocument.rows = nextDocument.rows.filter((_, index) => !selectedRows.has(index));

    setIsBusy(true);
    try {
      let deletedReferenceCount = 0;
      if (deletedReferences.size > 0) {
        const existingOrphans = new Set(await api.listOrphans(nextDocument));
        const referencesToDelete = [...deletedReferences].filter((reference) => existingOrphans.has(reference));
        if (referencesToDelete.length > 0) {
          await api.deleteOrphans(nextDocument, referencesToDelete);
          deletedReferenceCount = referencesToDelete.length;
        }
      }
      changeDocument(() => nextDocument);
      setSelectedRows(new Set());
      setSelectedCells(new Set());
      setEditingCell(null);
      setNotice(`已删除 ${deletedRowCount} 行${deletedReferenceCount > 0 ? `及 ${deletedReferenceCount} 个 JSON Ref 文件` : ''}。`);
    } catch (error) {
      setNotice(`删除失败：${messageFrom(error)}`);
    } finally {
      setIsBusy(false);
    }
  };

  const saveColumnDialog = (name: string, type: ColumnType, linkSheet?: string) => {
    if (!document || !columnDialog) return;
    const trimmed = name.trim();
    if (!trimmed || document.schema.columns.some((column, index) => index !== columnDialog.index && column.name === trimmed)) {
      setNotice('列名不能为空且不能重复。');
      return;
    }
    if (linkSheet !== undefined && !linkSheet) {
      setNotice('Link 列必须选择一个关联表。');
      return;
    }
    const nextColumn: ColumnSchema = linkSheet
      ? { name: trimmed, type, editorType: 'link', linkSheet }
      : { name: trimmed, type };
    changeDocument((current) => {
      const next = cloneDocument(current);
      if (columnDialog.mode === 'edit') {
        if (columnDialog.index === 0) return current;
        next.schema.columns[columnDialog.index] = nextColumn;
      } else {
        next.schema.columns.splice(columnDialog.index, 0, nextColumn);
        next.rows.forEach((row) => row.splice(columnDialog.index, 0, ''));
      }
      return next;
    });
    if (columnDialog.mode === 'add') {
      setSelectedCells(new Set());
      setEditingCell(null);
    }
    setNotice(columnDialog.mode === 'edit' ? `已更新 ${trimmed} 列。` : `已在右侧新增 ${trimmed} 列。`);
    setColumnDialog(null);
  };

  const moveColumn = (index: number, direction: -1 | 1) => {
    if (!document || index === 0 || index + direction <= 0 || index + direction >= document.schema.columns.length) return;
    changeDocument((current) => {
      const next = cloneDocument(current);
      const target = index + direction;
      [next.schema.columns[index], next.schema.columns[target]] = [next.schema.columns[target], next.schema.columns[index]];
      next.rows.forEach((row) => ([row[index], row[target]] = [row[target], row[index]]));
      return next;
    });
    setSelectedCells(new Set());
    setEditingCell(null);
  };

  const deleteColumn = (index: number) => {
    if (!document || index === 0) return;
    const column = document.schema.columns[index];
    if (!window.confirm(`删除 “${column.name}” 列？${column.type === 'json_ref' ? '关联 JSON 会保留为未引用文件。' : ''}`)) return;
    changeDocument((current) => {
      const next = cloneDocument(current);
      next.schema.columns.splice(index, 1);
      next.rows.forEach((row) => row.splice(index, 1));
      return next;
    });
    setSelectedCells(new Set());
    setEditingCell(null);
    setNotice(`已删除 ${column.name} 列。`);
  };

  const openHeaderMenu = (event: React.MouseEvent, index: number) => {
    event.preventDefault();
    setRowMenu(null);
    setHeaderMenu({ index, x: event.clientX, y: event.clientY });
  };

  const openRowMenu = (event: React.MouseEvent, rowIndex: number) => {
    event.preventDefault();
    if (!selectedRows.has(rowIndex)) setSelectedRows(new Set([rowIndex]));
    setSelectedCells(new Set());
    setEditingCell(null);
    setHeaderMenu(null);
    setRowMenu({ rowIndex, x: event.clientX, y: event.clientY });
  };

  const createReference = async (rowIndex: number, columnIndex: number) => {
    setIsBusy(true);
    try {
      updateCell(rowIndex, columnIndex, await api.createJsonRef());
      setNotice('已创建 JSON 文件；点击“在 VS Code 中打开”开始编辑。');
    } catch (error) {
      setNotice(`创建 JSON 失败：${messageFrom(error)}`);
    } finally {
      setIsBusy(false);
    }
  };

  const openReference = async (reference: string) => {
    setIsBusy(true);
    try {
      await api.openJsonRef(reference);
      setNotice('已在 VS Code 中打开 JSON。保存 CSV 前会重新校验 JSON。');
    } catch (error) {
      setNotice(`无法打开 JSON：${messageFrom(error)}`);
    } finally {
      setIsBusy(false);
    }
  };

  const openLinkedRow = async (tableName: string, rowId: string) => {
    if (!rowId) return;
    setIsBusy(true);
    try {
      const result = await api.openLinkedRow(tableName, rowId);
      addDocumentTab(result.document);
      setLinkTargetRowIndex(result.rowIndex);
      setNotice(`已跳转到 ${tableName}.${rowId}。`);
    } catch (error) {
      setNotice(`无法跳转关联数据：${messageFrom(error)}`);
    } finally {
      setIsBusy(false);
    }
  };

  const cleanOrphans = async () => {
    if (!document) return;
    setIsBusy(true);
    try {
      const references = await api.listOrphans(document);
      if (references.length === 0) {
        setNotice('没有未引用 JSON 文件。');
        return;
      }
      const preview = references.slice(0, 8).join('\n');
      if (!window.confirm(`发现 ${references.length} 个未引用 JSON 文件：\n${preview}${references.length > 8 ? '\n…' : ''}\n\n确认删除？`)) return;
      await api.deleteOrphans(document, references);
      setNotice(`已删除 ${references.length} 个未引用 JSON 文件。`);
    } catch (error) {
      setNotice(`清理失败：${messageFrom(error)}`);
    } finally {
      setIsBusy(false);
    }
  };

  fileMenuActions.current = {
    'file-new': () => { if (!isBusy) void createCsv(); },
    'file-open': () => { if (!isBusy) void openCsv(); },
    'file-save': () => { if (isDirty && !isBusy) void save(); },
    'file-export': () => { if (document && !isBusy) void exportPackage(); },
  };

  useEffect(() => {
    let active = true;
    let unlisten: UnlistenFn | undefined;
    void listen<string>('file-menu-action', (event) => {
      fileMenuActions.current[event.payload]?.();
    }).then((removeListener) => {
      if (active) unlisten = removeListener;
      else removeListener();
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 's') {
        event.preventDefault();
        fileMenuActions.current['file-save']?.();
      } else if (key === 'z' && !event.shiftKey) {
        event.preventDefault();
        if (!event.repeat && !isBusy) undoDocument();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isBusy, undoDocument]);

  const visibleTableRows = dataTable.getRowModel().rows;
  const visibleSourceIndices = visibleTableRows.map((row) => row.original.sourceIndex);
  const selectCellRange = useCallback((start: CellPosition, end: CellPosition) => {
    const next = new Set<string>();
    const firstRow = Math.min(start.rowPosition, end.rowPosition);
    const lastRow = Math.max(start.rowPosition, end.rowPosition);
    const firstColumn = Math.min(start.columnIndex, end.columnIndex);
    const lastColumn = Math.max(start.columnIndex, end.columnIndex);
    for (let rowPosition = firstRow; rowPosition <= lastRow; rowPosition += 1) {
      const rowIndex = visibleSourceIndices[rowPosition];
      if (rowIndex === undefined) continue;
      for (let columnIndex = firstColumn; columnIndex <= lastColumn; columnIndex += 1) {
        next.add(cellKey(rowIndex, columnIndex));
      }
    }
    setSelectedCells(next);
  }, [visibleSourceIndices]);

  const beginCellSelection = (event: React.MouseEvent, rowPosition: number, columnIndex: number) => {
    if (event.button !== 0) return;
    const key = cellKey(visibleSourceIndices[rowPosition], columnIndex);
    const interactiveTarget = (event.target as HTMLElement).closest('input, textarea, select, button');
    if (interactiveTarget && (editingCell === key || interactiveTarget.tagName === 'BUTTON')) return;
    event.preventDefault();
    activeHistoryGroup.current = null;
    setEditingCell(null);
    const start = { rowPosition, columnIndex };
    dragSelectionStart.current = start;
    selectCellRange(start, start);
  };

  const extendCellSelection = (rowPosition: number, columnIndex: number) => {
    if (!dragSelectionStart.current) return;
    selectCellRange(dragSelectionStart.current, { rowPosition, columnIndex });
  };

  useEffect(() => {
    const finishSelection = () => { dragSelectionStart.current = null; };
    window.addEventListener('mouseup', finishSelection);
    window.addEventListener('blur', finishSelection);
    return () => {
      window.removeEventListener('mouseup', finishSelection);
      window.removeEventListener('blur', finishSelection);
    };
  }, []);

  useEffect(() => {
    const handleCopy = (event: ClipboardEvent) => {
      if (!document || editingCell || selectedCells.size === 0) return;

      const visiblePositionBySource = new Map(visibleSourceIndices.map((sourceIndex, position) => [sourceIndex, position]));
      const selected = [...selectedCells].map((key) => {
        const [rowIndex, columnIndex] = key.split(':').map(Number);
        return { rowIndex, columnIndex, rowPosition: visiblePositionBySource.get(rowIndex) ?? rowIndex };
      });
      const rows = [...new Set(selected.map((cell) => cell.rowPosition))].sort((left, right) => left - right);
      const columns = [...new Set(selected.map((cell) => cell.columnIndex))].sort((left, right) => left - right);
      const sourceByPosition = new Map(selected.map((cell) => [cell.rowPosition, cell.rowIndex]));
      const copiedText = rows.map((rowPosition) => {
        const rowIndex = sourceByPosition.get(rowPosition);
        return columns.map((columnIndex) => encodeClipboardCell(
          rowIndex === undefined ? '' : document.rows[rowIndex]?.[columnIndex] ?? '',
        )).join('\t');
      }).join('\n');

      event.preventDefault();
      event.clipboardData?.setData('text/plain', copiedText);
      setNotice(`已复制 ${selectedCells.size} 个单元格。`);
    };

    window.addEventListener('copy', handleCopy);
    return () => window.removeEventListener('copy', handleCopy);
  }, [document, editingCell, selectedCells, visibleSourceIndices]);

  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      if (!document || editingCell || selectedCells.size === 0) return;
      const clipboardText = event.clipboardData?.getData('text/plain');
      if (clipboardText === undefined) return;
      event.preventDefault();

      const clipboardRows = parseClipboardText(clipboardText);
      const visiblePositionBySource = new Map(visibleSourceIndices.map((sourceIndex, position) => [sourceIndex, position]));
      const selected = [...selectedCells].map((key) => {
        const [rowIndex, columnIndex] = key.split(':').map(Number);
        return { rowIndex, columnIndex, rowPosition: visiblePositionBySource.get(rowIndex) ?? rowIndex };
      });
      const firstRow = Math.min(...selected.map((cell) => cell.rowPosition));
      const firstColumn = Math.min(...selected.map((cell) => cell.columnIndex));

      changeDocument((current) => {
        const next = cloneDocument(current);
        selected.forEach(({ rowIndex, columnIndex, rowPosition }) => {
          const clipboardRow = clipboardRows[(rowPosition - firstRow) % clipboardRows.length];
          const value = clipboardRow[(columnIndex - firstColumn) % clipboardRow.length] ?? '';
          if (next.rows[rowIndex]?.[columnIndex] !== undefined) next.rows[rowIndex][columnIndex] = value;
        });
        return next;
      });
      setNotice(`已粘贴到 ${selectedCells.size} 个单元格。`);
    };

    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [document, editingCell, selectedCells, visibleSourceIndices]);

  return (
    <Theme
      appearance={appearance}
      accentColor="gray"
      grayColor="gray"
      panelBackground="solid"
      radius="small"
      scaling="90%"
    >
    <main className="app-shell">
      <div className="app-content">
        <FolderSidebar
          roots={folderRoots}
          expandedFolders={expandedFolders}
          activeCsvPath={activeCsvPath}
          isLoading={isFolderTreeLoading}
          isActionBusy={isFolderActionBusy}
          isOpenBusy={isBusy}
          onAddFolder={addFolder}
          onRefresh={refreshFolders}
          onRemoveFolder={removeFolder}
          onToggleFolder={toggleFolder}
          onOpenCsv={openCsvAtPath}
          appearance={appearance}
          onToggleAppearance={() => setAppearance((current) => current === 'dark' ? 'light' : 'dark')}
        />
        <section className="editor-content">
          {tabs.length > 0 && (
            <div className="sheet-tabs" role="tablist" aria-label="已打开的 Sheet">
              {tabs.map((tab) => (
                <div
                  key={tab.id}
                  className={`sheet-tab${tab.id === activeTabId ? ' is-active' : ''}`}
                  role="presentation"
                >
                  <button
                    type="button"
                    className="sheet-tab-select"
                    role="tab"
                    aria-selected={tab.id === activeTabId}
                    title={tab.path}
                    disabled={isBusy}
                    onClick={() => void activateTab(tab.id)}
                  >
                    <span>{tab.title}</span>{tab.dirty && <span className="sheet-tab-dirty" aria-label="未保存">•</span>}
                  </button>
                  <button
                    type="button"
                    className="sheet-tab-close"
                    aria-label={`关闭 ${tab.title}`}
                    title={`关闭 ${tab.title}`}
                    disabled={isBusy}
                    onClick={() => closeTab(tab.id)}
                  >
                    <X size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
          {!document ? (
        <section className="empty-state">
          <div className="empty-icon"><FileSpreadsheet size={42} /></div>
          <h1>打开一份游戏数据 CSV</h1>
          <p>每张表会与同名 Schema 及 JSON 引用目录一起管理。</p>
          <div className="empty-actions">
            <button className="button button-primary button-large" onClick={createCsv} disabled={isBusy}>
              <Plus size={18} /> 新建 CSV
            </button>
            <button className="button button-secondary button-large" onClick={openCsv} disabled={isBusy}>
              <FolderOpen size={18} /> 打开 CSV
            </button>
          </div>
          <div className="package-example">
            <code>items.csv</code><code>items.schema.json</code><code>items/&lt;uuid&gt;.json</code>
          </div>
        </section>
          ) : (
            <div className="workspace">
              <section className="grid-panel">
                {document.schemaWasMissing && (
                  <div className="info-banner"><AlertCircle size={16} />未找到同名 Schema；首次保存会创建 <code>{document.tableName}.schema.json</code>。</div>
                )}
                <div className="grid-actions">
                  <div className="table-tools">
                    <span className="filtered-row-count">显示 {visibleTableRows.length} / {document.rows.length} 行</span>
                  </div>
                </div>
                <div className="table-scroll">
                  <table className="data-grid">
                    <thead>
                      {dataTable.getHeaderGroups().map((headerGroup) => (
                        <tr key={headerGroup.id}>
                          <th className="index-column" title="CSV 中的原始行号">#</th>
                          {headerGroup.headers.map((header, columnIndex) => {
                            const column = document.schema.columns[columnIndex];
                            const sortDirection = header.column.getIsSorted();
                            return (
                              <th
                                className="header-menu-trigger"
                                onContextMenu={(event) => openHeaderMenu(event, columnIndex)}
                                key={header.id}
                                aria-sort={sortDirection === 'asc' ? 'ascending' : sortDirection === 'desc' ? 'descending' : 'none'}
                              >
                                <button
                                  type="button"
                                  className="column-sort-button"
                                  onClick={header.column.getToggleSortingHandler()}
                                  title="点击排序；Shift + 点击可进行多列排序"
                                >
                                  <span>{column.name}</span>
                                  {sortDirection === 'asc' ? <ArrowUp size={13} /> : sortDirection === 'desc' ? <ArrowDown size={13} /> : <ChevronsUpDown size={13} />}
                                  {sortDirection && dataTable.state.sorting.length > 1 && (
                                    <sup>{header.column.getSortIndex() + 1}</sup>
                                  )}
                                </button>
                                <small>{columnTypeLabel(column)}</small>
                                <input
                                  className="column-filter-input"
                                  value={String(header.column.getFilterValue() ?? '')}
                                  onChange={(event) => header.column.setFilterValue(event.target.value)}
                                  onContextMenu={(event) => event.stopPropagation()}
                                  placeholder="筛选…"
                                  aria-label={`筛选 ${column.name} 列`}
                                />
                              </th>
                            );
                          })}
                        </tr>
                      ))}
                    </thead>
                    <tbody>
                      {visibleTableRows.map((tableRow, rowPosition) => {
                        const rowIndex = tableRow.original.sourceIndex;
                        const row = tableRow.original.values;
                        return (
                          <tr
                            key={tableRow.id}
                            data-row-index={rowIndex}
                            onContextMenu={(event) => openRowMenu(event, rowIndex)}
                            className={[
                              selectedRows.has(rowIndex) ? 'is-selected' : '',
                              linkTargetRowIndex === rowIndex ? 'is-link-target' : '',
                            ].filter(Boolean).join(' ')}
                          >
                            <td className="index-column">{rowIndex + 1}</td>
                            {document.schema.columns.map((column, columnIndex) => {
                              const key = cellKey(rowIndex, columnIndex);
                              const isEditing = editingCell === key;
                              const classNames = [
                                issueByCell.has(`${rowIndex}:${column.name}`) ? 'has-error' : '',
                                selectedCells.has(key) ? 'is-cell-selected' : '',
                                isEditing ? 'is-cell-editing' : '',
                              ].filter(Boolean).join(' ');
                              return (
                                <td
                                  key={`${rowIndex}-${column.name}`}
                                  className={classNames}
                                  title={issueByCell.get(`${rowIndex}:${column.name}`)?.map((issue) => issue.message).join('\n')}
                                  onMouseDown={(event) => beginCellSelection(event, rowPosition, columnIndex)}
                                  onMouseEnter={() => extendCellSelection(rowPosition, columnIndex)}
                                  onDoubleClick={(event) => {
                                    event.preventDefault();
                                    setSelectedCells(new Set([key]));
                                    if (column.type !== 'json_ref') setEditingCell(key);
                                  }}
                                  onBlur={(event) => {
                                    if (isEditing && !event.currentTarget.contains(event.relatedTarget as Node | null)) {
                                      activeHistoryGroup.current = null;
                                      setEditingCell(null);
                                    }
                                  }}
                                >
                                  {column.type === 'json_ref' ? (
                                    <CellEditor
                                      column={column}
                                      value={row[columnIndex] ?? ''}
                                      onChange={(value) => updateCell(rowIndex, columnIndex, value)}
                                      onCreateReference={() => createReference(rowIndex, columnIndex)}
                                      onOpenReference={() => openReference(row[columnIndex])}
                                      disabled={isBusy}
                                      autoFocus
                                    />
                                  ) : column.editorType === 'link' && column.linkSheet ? (
                                    <LinkCell
                                      value={row[columnIndex]}
                                      tableName={column.linkSheet}
                                      isArray={column.type === 'string_array'}
                                      disabled={isBusy}
                                      onOpen={(value) => openLinkedRow(column.linkSheet!, value)}
                                      onChange={(value) => updateCell(rowIndex, columnIndex, value)}
                                      onFocus={() => setEditingCell(key)}
                                    />
                                  ) : isEditing ? (
                                    <CellEditor
                                      column={column}
                                      value={row[columnIndex] ?? ''}
                                      onChange={(value) => updateCell(rowIndex, columnIndex, value)}
                                      onCreateReference={() => createReference(rowIndex, columnIndex)}
                                      onOpenReference={() => openReference(row[columnIndex])}
                                      disabled={isBusy}
                                      autoFocus
                                    />
                                  ) : (
                                    <div className={`cell-value${row[columnIndex] ? '' : ' is-empty'}`}>
                                      {row[columnIndex] || ''}
                                    </div>
                                  )}
                                </td>
                              );
                            })}
                          </tr>
                        );
                      })}
                      {visibleTableRows.length === 0 && (
                        <tr><td className="no-filter-results" colSpan={document.schema.columns.length + 1}>没有符合当前筛选条件的数据</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </section>
            </div>
          )}
        </section>
      </div>
      {document && headerMenu && (
        <HeaderContextMenu
          column={document.schema.columns[headerMenu.index]}
          isId={headerMenu.index === 0}
          canMoveRight={headerMenu.index > 0 && headerMenu.index < document.schema.columns.length - 1}
          style={{ left: Math.min(headerMenu.x, window.innerWidth - 220), top: Math.min(headerMenu.y, window.innerHeight - 220) }}
          onEdit={() => { setColumnDialog({ mode: 'edit', index: headerMenu.index }); setHeaderMenu(null); }}
          onDelete={() => { deleteColumn(headerMenu.index); setHeaderMenu(null); }}
          onMoveRight={() => { moveColumn(headerMenu.index, 1); setHeaderMenu(null); }}
          onAddRight={() => { setColumnDialog({ mode: 'add', index: headerMenu.index + 1 }); setHeaderMenu(null); }}
        />
      )}
      {document && rowMenu && (
        <RowContextMenu
          selectionCount={selectedRows.has(rowMenu.rowIndex) ? selectedRows.size : 1}
          disabled={isBusy}
          style={{ left: Math.min(rowMenu.x, window.innerWidth - 220), top: Math.min(rowMenu.y, window.innerHeight - 190) }}
          onAdd={() => { const rowIndex = rowMenu.rowIndex; setRowMenu(null); addRowAfter(rowIndex); }}
          onDuplicate={() => { setRowMenu(null); void duplicateSelected(); }}
          onDelete={() => { setRowMenu(null); void deleteSelected(); }}
          onCleanOrphans={() => { setRowMenu(null); void cleanOrphans(); }}
        />
      )}
      {document && columnDialog && (
        <ColumnDialog
          mode={columnDialog.mode}
          column={columnDialog.mode === 'edit' ? document.schema.columns[columnDialog.index] : undefined}
          siblingSheets={siblingSheets}
          onCancel={() => setColumnDialog(null)}
          onSubmit={saveColumnDialog}
        />
      )}
    </main>
    </Theme>
  );
}

function FolderSidebar({
  roots,
  expandedFolders,
  activeCsvPath,
  isLoading,
  isActionBusy,
  isOpenBusy,
  onAddFolder,
  onRefresh,
  onRemoveFolder,
  onToggleFolder,
  onOpenCsv,
  appearance,
  onToggleAppearance,
}: {
  roots: FolderTreeRoot[];
  expandedFolders: Set<string>;
  activeCsvPath: string | null;
  isLoading: boolean;
  isActionBusy: boolean;
  isOpenBusy: boolean;
  onAddFolder: () => Promise<void>;
  onRefresh: () => Promise<void>;
  onRemoveFolder: (root: FolderTreeRoot) => Promise<void>;
  onToggleFolder: (path: string) => void;
  onOpenCsv: (path: string) => Promise<void | undefined>;
  appearance: AppAppearance;
  onToggleAppearance: () => void;
}) {
  return <aside className="folder-sidebar" aria-label="文件夹">
    <div className="folder-sidebar-header">
      <div>
        <span className="folder-sidebar-title">Folders</span>
      </div>
      <div className="folder-sidebar-actions">
        <button
          type="button"
          className="sidebar-icon-button"
          onClick={() => void onAddFolder()}
          disabled={isActionBusy || isOpenBusy}
          aria-label="添加文件夹"
          title="添加文件夹"
        >
          <Plus size={16} />
        </button>
        <button
          type="button"
          className="sidebar-icon-button"
          onClick={() => void onRefresh()}
          disabled={isActionBusy || isOpenBusy || isLoading}
          aria-label="刷新文件夹列表"
          title="刷新文件夹列表"
        >
          <RefreshCw className={isLoading ? 'spin' : undefined} size={15} />
        </button>
        <IconButton
          type="button"
          className="sidebar-icon-button theme-toggle"
          size="1"
          variant="ghost"
          color="gray"
          highContrast
          onClick={onToggleAppearance}
          aria-label={appearance === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
          title={appearance === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
        >
          {appearance === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
        </IconButton>
      </div>
    </div>

    <div className="folder-tree" role="tree" aria-label="CSV 文件夹树">
      {isLoading && roots.length === 0 && (
        <div className="folder-tree-placeholder"><LoaderCircle className="spin" size={16} />正在读取文件夹…</div>
      )}
      {!isLoading && roots.length === 0 && (
        <div className="folder-tree-placeholder">
          <FolderOpen size={20} />
          <span>添加一个文件夹后，这里会显示其中的 CSV 文件。</span>
        </div>
      )}
      {roots.map((root) => (
        <FolderRootItem
          key={root.path}
          root={root}
          expanded={expandedFolders.has(root.path)}
          expandedFolders={expandedFolders}
          activeCsvPath={activeCsvPath}
          isActionBusy={isActionBusy}
          isOpenBusy={isOpenBusy}
          onToggleFolder={onToggleFolder}
          onRemoveFolder={onRemoveFolder}
          onOpenCsv={onOpenCsv}
        />
      ))}
    </div>
  </aside>;
}

function FolderRootItem({
  root,
  expanded,
  expandedFolders,
  activeCsvPath,
  isActionBusy,
  isOpenBusy,
  onToggleFolder,
  onRemoveFolder,
  onOpenCsv,
}: {
  root: FolderTreeRoot;
  expanded: boolean;
  expandedFolders: Set<string>;
  activeCsvPath: string | null;
  isActionBusy: boolean;
  isOpenBusy: boolean;
  onToggleFolder: (path: string) => void;
  onRemoveFolder: (root: FolderTreeRoot) => Promise<void>;
  onOpenCsv: (path: string) => Promise<void | undefined>;
}) {
  const rootError = root.error ?? (root.available ? null : '该文件夹当前不可访问。');
  return <div className={`folder-root${root.available ? '' : ' is-unavailable'}`}>
    <div className="folder-root-row">
      <button
        type="button"
        className="folder-tree-row folder-root-toggle"
        onClick={() => onToggleFolder(root.path)}
        disabled={!root.available}
        role="treeitem"
        aria-level={1}
        aria-expanded={root.available ? expanded : undefined}
        title={root.path}
      >
        {root.available ? (expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />) : <AlertCircle size={14} />}
        <FolderOpen size={16} />
        <span className="tree-label">{root.name}</span>
      </button>
      <button
        type="button"
        className="sidebar-icon-button sidebar-remove-button"
        onClick={() => void onRemoveFolder(root)}
        disabled={isActionBusy || isOpenBusy}
        aria-label={`移除文件夹 ${root.name}`}
        title="从左侧列表移除（不删除磁盘文件）"
      >
        <X size={15} />
      </button>
    </div>
    {rootError && <TreeError message={rootError} depth={1} />}
    {root.available && expanded && (
      <div role="group">
        {root.children.length === 0 ? (
          <div className="empty-folder" style={{ paddingLeft: 37 }}>未找到 CSV 文件</div>
        ) : root.children.map((entry) => (
          <FolderTreeItem
            key={entry.path}
            entry={entry}
            depth={1}
            expandedFolders={expandedFolders}
            activeCsvPath={activeCsvPath}
            isOpenBusy={isOpenBusy}
            onToggleFolder={onToggleFolder}
            onOpenCsv={onOpenCsv}
          />
        ))}
      </div>
    )}
  </div>;
}

function FolderTreeItem({
  entry,
  depth,
  expandedFolders,
  activeCsvPath,
  isOpenBusy,
  onToggleFolder,
  onOpenCsv,
}: {
  entry: FolderTreeEntry;
  depth: number;
  expandedFolders: Set<string>;
  activeCsvPath: string | null;
  isOpenBusy: boolean;
  onToggleFolder: (path: string) => void;
  onOpenCsv: (path: string) => Promise<void | undefined>;
}) {
  const indent = 13 + depth * 16;
  const entryAvailable = entry.available;
  if (entry.kind === 'csv') {
    return <>
      <button
        type="button"
        className={`folder-tree-row csv-tree-item${activeCsvPath === entry.path ? ' is-active' : ''}${entryAvailable ? '' : ' is-unavailable'}`}
        style={{ paddingLeft: indent }}
        onClick={() => void onOpenCsv(entry.path)}
        disabled={isOpenBusy || !entryAvailable}
        role="treeitem"
        aria-level={depth + 1}
        aria-current={activeCsvPath === entry.path ? 'page' : undefined}
        title={entry.path}
      >
        <span className="tree-indent" />
        <FileText size={15} />
        <span className="tree-label">{entry.name}</span>
      </button>
      {entry.error && <TreeError message={entry.error} depth={depth + 1} />}
    </>;
  }

  const expanded = expandedFolders.has(entry.path);
  const children = entry.children ?? [];
  return <div className={`folder-tree-node${entryAvailable ? '' : ' is-unavailable'}`}>
    <button
      type="button"
      className="folder-tree-row nested-folder-row"
      style={{ paddingLeft: indent }}
      onClick={() => onToggleFolder(entry.path)}
      disabled={!entryAvailable}
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={entryAvailable ? expanded : undefined}
      title={entry.path}
    >
      {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
      <Folder size={15} />
      <span className="tree-label">{entry.name}</span>
    </button>
    {entry.error && <TreeError message={entry.error} depth={depth + 1} />}
    {entryAvailable && expanded && children.length > 0 && (
      <div role="group">
        {children.map((child) => (
          <FolderTreeItem
            key={child.path}
            entry={child}
            depth={depth + 1}
            expandedFolders={expandedFolders}
            activeCsvPath={activeCsvPath}
            isOpenBusy={isOpenBusy}
            onToggleFolder={onToggleFolder}
            onOpenCsv={onOpenCsv}
          />
        ))}
      </div>
    )}
  </div>;
}

function TreeError({ message, depth }: { message: string; depth: number }) {
  return <div className="folder-tree-error" style={{ paddingLeft: 18 + depth * 16 }} title={message}>
    <AlertCircle size={13} />
    <span>{message}</span>
  </div>;
}

function CellEditor({ column, value, onChange, onCreateReference, onOpenReference, disabled, autoFocus = false }: {
  column: ColumnSchema;
  value: string;
  onChange: (value: string) => void;
  onCreateReference: () => void;
  onOpenReference: () => void;
  disabled: boolean;
  autoFocus?: boolean;
}) {
  if (column.type === 'json_ref') {
    return value ? (
      <div className="json-ref-cell">
        <button className="json-open" onClick={onOpenReference} disabled={disabled} title={value} autoFocus={autoFocus}><FileJson size={15} />打开 JSON</button>
        <button className="icon-button" onClick={() => onChange('')} disabled={disabled} aria-label="清空 JSON 引用"><X size={14} /></button>
      </div>
    ) : <button className="json-create" onClick={onCreateReference} disabled={disabled} autoFocus={autoFocus}><Plus size={14} />新建 JSON</button>;
  }
  if (column.type === 'bool') {
    return <select className="cell-input" value={value} onChange={(event) => onChange(event.target.value)} autoFocus={autoFocus}>
      <option value="">—</option><option value="true">true</option><option value="false">false</option>
    </select>;
  }
  if (column.type === 'string') {
    return <TextCellEditor value={value} onChange={onChange} autoFocus={autoFocus} />;
  }
  return <input className="cell-input" value={value} onChange={(event) => onChange(event.target.value)} onFocus={(event) => event.currentTarget.select()} inputMode={column.type === 'int' || column.type === 'float' || column.type === 'vector2int' ? 'decimal' : 'text'} autoFocus={autoFocus} />;
}

function LinkCell({ value, tableName, isArray, disabled, onOpen, onChange, onFocus }: {
  value: string;
  tableName: string;
  isArray: boolean;
  disabled: boolean;
  onOpen: (value: string) => void;
  onChange: (value: string) => void;
  onFocus: () => void;
}) {
  const [input, setInput] = useState('');
  const values = value
    ? (isArray ? value.split('|').filter((entry) => entry.length > 0) : [value])
    : [];
  const removeValue = (index: number) => {
    const next = values.filter((_, valueIndex) => valueIndex !== index);
    onChange(isArray ? next.join('|') : '');
  };
  const addValue = () => {
    const nextValue = input.trim();
    if (!nextValue || (!isArray && values.length > 0)) return;
    if (!values.includes(nextValue)) {
      onChange(isArray ? [...values, nextValue].join('|') : nextValue);
    }
    setInput('');
  };
  return <div className="link-tags" onMouseDown={(event) => event.stopPropagation()}>
    {values.map((entry, index) => (
      <span className="link-tag" key={`${entry}-${index}`}>
        <button className="link-tag-label" onClick={() => onOpen(entry)} disabled={disabled} title={`跳转到 ${tableName}.${entry}`}>{entry}</button>
        <button className="link-tag-remove" onClick={() => removeValue(index)} disabled={disabled} aria-label={`删除关联值 ${entry}`}><X size={14} /></button>
      </span>
    ))}
    {(isArray || values.length === 0) && (
      <input
        className="link-tags-input"
        value={input}
        disabled={disabled}
        placeholder="按回车键 Enter 创建标签"
        onFocus={onFocus}
        onChange={(event) => setInput(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          addValue();
        }}
      />
    )}
  </div>;
}

function TextCellEditor({ value, onChange, autoFocus }: { value: string; onChange: (value: string) => void; autoFocus: boolean }) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const fitHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = '0px';
    const borderHeight = textarea.offsetHeight - textarea.clientHeight;
    textarea.style.height = `${textarea.scrollHeight + borderHeight}px`;
  }, []);

  useLayoutEffect(() => {
    fitHeight();
  }, [fitHeight, value]);

  useEffect(() => {
    const textarea = textareaRef.current;
    const cell = textarea?.closest('td');
    if (!cell) return;

    let previousWidth = cell.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const nextWidth = cell.getBoundingClientRect().width;
      if (nextWidth === previousWidth) return;
      previousWidth = nextWidth;
      fitHeight();
    });
    observer.observe(cell);
    return () => observer.disconnect();
  }, [fitHeight]);

  return <textarea
    ref={textareaRef}
    className="cell-input cell-textarea"
    rows={1}
    wrap="soft"
    value={value}
    autoFocus={autoFocus}
    onChange={(event) => onChange(event.currentTarget.value)}
    onFocus={(event) => event.currentTarget.select()}
  />;
}

function HeaderContextMenu({ column, isId, canMoveRight, style, onEdit, onDelete, onMoveRight, onAddRight }: {
  column: ColumnSchema;
  isId: boolean;
  canMoveRight: boolean;
  style: React.CSSProperties;
  onEdit: () => void;
  onDelete: () => void;
  onMoveRight: () => void;
  onAddRight: () => void;
}) {
  return <div className="header-context-menu" style={style} onMouseDown={(event) => event.stopPropagation()}>
    <div className="menu-heading">{column.name} <span>{columnTypeLabel(column)}</span></div>
    {isId && <div className="menu-locked">id 是锁定主键列</div>}
    <button className="menu-item" disabled={isId} onClick={onEdit}>编辑名称和类型</button>
    <button className="menu-item" disabled={!canMoveRight} onClick={onMoveRight}>向右移动</button>
    <button className="menu-item" onClick={onAddRight}>在右侧新增一列</button>
    <div className="menu-divider" />
    <button className="menu-item menu-item-danger" disabled={isId} onClick={onDelete}>删除列</button>
  </div>;
}

function RowContextMenu({ selectionCount, disabled, style, onAdd, onDuplicate, onDelete, onCleanOrphans }: {
  selectionCount: number;
  disabled: boolean;
  style: React.CSSProperties;
  onAdd: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onCleanOrphans: () => void;
}) {
  return <div className="row-context-menu" style={style} onMouseDown={(event) => event.stopPropagation()}>
    <div className="menu-heading">{selectionCount > 1 ? `已选择 ${selectionCount} 行` : '当前行'}</div>
    <button className="menu-item" disabled={disabled} onClick={onAdd}><Plus size={14} />新增行</button>
    <button className="menu-item" disabled={disabled || selectionCount !== 1} onClick={onDuplicate}><Copy size={14} />复制行</button>
    <button className="menu-item menu-item-danger" disabled={disabled || selectionCount === 0} onClick={onDelete}><Trash2 size={14} />删除行</button>
    <div className="menu-divider" />
    <button className="menu-item" disabled={disabled} onClick={onCleanOrphans}><Trash2 size={14} />清理未引用 JSON</button>
  </div>;
}

function ColumnDialog({ mode, column, siblingSheets, onCancel, onSubmit }: {
  mode: 'edit' | 'add';
  column?: ColumnSchema;
  siblingSheets: string[];
  onCancel: () => void;
  onSubmit: (name: string, type: ColumnType, linkSheet?: string) => void;
}) {
  const [name, setName] = useState(column?.name ?? 'new_column');
  const [type, setType] = useState<ColumnType>(column?.type ?? 'string');
  const [isLink, setIsLink] = useState(column?.editorType === 'link');
  const [linkSheet, setLinkSheet] = useState(column?.linkSheet ?? '');
  const supportsLink = type === 'string' || type === 'string_array';
  useEffect(() => {
    if (!isLink || linkSheet) return;
    setLinkSheet(siblingSheets[0] ?? '');
  }, [isLink, linkSheet, siblingSheets]);
  useEffect(() => {
    if (!supportsLink && isLink) setIsLink(false);
  }, [isLink, supportsLink]);
  const submit = () => onSubmit(
    name,
    type,
    isLink ? linkSheet : undefined,
  );
  return <div className="modal-backdrop" role="presentation" onMouseDown={onCancel}>
    <section className="column-dialog" role="dialog" aria-modal="true" aria-label={mode === 'edit' ? '编辑列' : '新增列'} onMouseDown={(event) => event.stopPropagation()}>
      <h2>{mode === 'edit' ? '编辑列' : '在右侧新增列'}</h2>
      <label>列名<input autoFocus value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && submit()} /></label>
      <label>类型<select value={type} onChange={(event) => setType(event.target.value as ColumnType)}>
        {columnTypes.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
      </select></label>
      <label className={`link-option${supportsLink ? '' : ' is-disabled'}`}>
        <input type="checkbox" checked={isLink} disabled={!supportsLink} onChange={(event) => setIsLink(event.target.checked)} />
        <span>Link（点击标签跳转到关联表的 id）</span>
      </label>
      {isLink && (
        <label>关联表<select value={linkSheet} onChange={(event) => setLinkSheet(event.target.value)}>
          {siblingSheets.length === 0 && <option value="">当前文件夹没有其他 Sheet</option>}
          {siblingSheets.map((sheet) => <option key={sheet} value={sheet}>{sheet}</option>)}
        </select></label>
      )}
      <div className="dialog-actions"><button className="button button-secondary" onClick={onCancel}>取消</button><button className="button button-primary" disabled={isLink && !linkSheet} onClick={submit}>确定</button></div>
    </section>
  </div>;
}

function typeLabel(type: ColumnType) {
  return columnTypes.find((entry) => entry.value === type)?.label ?? type;
}

function columnTypeLabel(column: ColumnSchema) {
  const baseType = typeLabel(column.type);
  return column.editorType === 'link'
    ? `${baseType} · Link → ${column.linkSheet ?? '?'}`
    : baseType;
}

function messageFrom(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
