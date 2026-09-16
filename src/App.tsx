import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  FileText,
  FileJson,
  FileSpreadsheet,
  Folder,
  FolderOpen,
  LoaderCircle,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  X,
} from 'lucide-react';
import { api } from './lib/api';
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

interface HeaderMenuState {
  index: number;
  x: number;
  y: number;
}

interface ColumnDialogState {
  mode: 'edit' | 'add';
  index: number;
}

function cloneDocument(document: TableDocument): TableDocument {
  return {
    ...document,
    schema: { ...document.schema, columns: document.schema.columns.map((column) => ({ ...column })) },
    rows: document.rows.map((row) => [...row]),
  };
}

export default function App() {
  const [document, setDocument] = useState<TableDocument | null>(null);
  const [savedSnapshot, setSavedSnapshot] = useState('');
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const [folderRoots, setFolderRoots] = useState<FolderTreeRoot[]>([]);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [activeCsvPath, setActiveCsvPath] = useState<string | null>(null);
  const [notice, setNotice] = useState('打开一个 CSV 文件开始编辑。');
  const [isBusy, setIsBusy] = useState(false);
  const [isFolderTreeLoading, setIsFolderTreeLoading] = useState(true);
  const [isFolderActionBusy, setIsFolderActionBusy] = useState(false);
  const [headerMenu, setHeaderMenu] = useState<HeaderMenuState | null>(null);
  const [columnDialog, setColumnDialog] = useState<ColumnDialogState | null>(null);
  const knownFolderRoots = useRef(new Set<string>());

  const isDirty = document !== null && JSON.stringify(document) !== savedSnapshot;
  const issueByCell = useMemo(() => {
    const index = new Map<string, ValidationIssue[]>();
    issues.forEach((issue) => {
      if (issue.rowIndex === null || issue.column === null) return;
      const key = `${issue.rowIndex}:${issue.column}`;
      index.set(key, [...(index.get(key) ?? []), issue]);
    });
    return index;
  }, [issues]);

  useEffect(() => {
    if (!document) {
      setIssues([]);
      return;
    }

    const timeout = window.setTimeout(async () => {
      try {
        setIssues(await api.validate(document));
      } catch (error) {
        setNotice(`校验失败：${messageFrom(error)}`);
      }
    }, 250);

    return () => window.clearTimeout(timeout);
  }, [document]);

  useEffect(() => {
    if (!headerMenu) return;
    const closeMenu = () => setHeaderMenu(null);
    window.addEventListener('mousedown', closeMenu);
    return () => window.removeEventListener('mousedown', closeMenu);
  }, [headerMenu]);

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

  const openDocument = useCallback(async (
    loader: () => Promise<TableDocument | null>,
    sourcePath: string | null,
  ) => {
    if (isDirty && !window.confirm('当前有未保存修改，继续打开其他文件将丢失这些修改。')) return;
    setIsBusy(true);
    try {
      const opened = await loader();
      if (!opened) return;
      setDocument(opened);
      setSavedSnapshot(JSON.stringify(opened));
      setSelectedRows(new Set());
      setActiveCsvPath(sourcePath);
      setNotice(opened.schemaWasMissing ? '未找到 Schema，已按文本列加载；首次保存会生成 Schema。' : '文件已加载。');
    } catch (error) {
      setNotice(`无法打开 CSV：${messageFrom(error)}`);
    } finally {
      setIsBusy(false);
    }
  }, [isDirty]);

  const openCsv = () => openDocument(() => api.openCsv(), null);

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
    if (isDirty && !window.confirm('当前有未保存修改，继续新建文件将丢失这些修改。')) return;
    setIsBusy(true);
    try {
      const created = await api.createCsv();
      if (!created) return;
      setDocument(created);
      setSavedSnapshot(JSON.stringify(created));
      setSelectedRows(new Set());
      setActiveCsvPath(null);
      setNotice('已新建 CSV 数据包，请添加列和数据行。');
    } catch (error) {
      setNotice(`无法新建 CSV：${messageFrom(error)}`);
    } finally {
      setIsBusy(false);
    }
  };

  const save = async () => {
    if (!document) return;
    const documentToSave = { ...document, schemaWasMissing: false };
    setIsBusy(true);
    try {
      const result = await api.save(documentToSave);
      setIssues(result.issues);
      if (!result.saved) {
        setNotice(result.message ?? '保存前校验未通过。');
        return;
      }
      setDocument(documentToSave);
      setSavedSnapshot(JSON.stringify(documentToSave));
      setNotice('已安全保存 CSV 与 Schema。');
    } catch (error) {
      setNotice(`保存失败：${messageFrom(error)}`);
    } finally {
      setIsBusy(false);
    }
  };

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
    setDocument((current) => {
      if (!current) return current;
      const next = cloneDocument(current);
      next.rows[rowIndex][columnIndex] = value;
      return next;
    });
  };

  const addRow = () => {
    setDocument((current) => {
      if (!current) return current;
      const next = cloneDocument(current);
      next.rows.push(makeRow(next.schema.columns.length));
      return next;
    });
    setNotice('已新增空行，请填写唯一 id。');
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
      setDocument((current) => {
        if (!current) return current;
        const next = cloneDocument(current);
        next.rows.splice(rowIndex + 1, 0, copy);
        return next;
      });
      setSelectedRows(new Set([rowIndex + 1]));
      setNotice('已复制该行及其 JSON 引用；请填写新的 id。');
    } catch (error) {
      setNotice(`复制失败：${messageFrom(error)}`);
    } finally {
      setIsBusy(false);
    }
  };

  const deleteSelected = () => {
    if (!document || selectedRows.size === 0) return;
    if (!window.confirm(`删除选中的 ${selectedRows.size} 行？关联 JSON 会保留为未引用文件，可稍后清理。`)) return;
    setDocument((current) => {
      if (!current) return current;
      const next = cloneDocument(current);
      next.rows = next.rows.filter((_, index) => !selectedRows.has(index));
      return next;
    });
    setSelectedRows(new Set());
    setNotice('行已删除，关联 JSON 没有自动删除。');
  };

  const saveColumnDialog = (name: string, type: ColumnType) => {
    if (!document || !columnDialog) return;
    const trimmed = name.trim();
    if (!trimmed || document.schema.columns.some((column, index) => index !== columnDialog.index && column.name === trimmed)) {
      setNotice('列名不能为空且不能重复。');
      return;
    }
    setDocument((current) => {
      if (!current) return current;
      const next = cloneDocument(current);
      if (columnDialog.mode === 'edit') {
        if (columnDialog.index === 0) return current;
        next.schema.columns[columnDialog.index] = { name: trimmed, type };
      } else {
        next.schema.columns.splice(columnDialog.index, 0, { name: trimmed, type });
        next.rows.forEach((row) => row.splice(columnDialog.index, 0, ''));
      }
      return next;
    });
    setNotice(columnDialog.mode === 'edit' ? `已更新 ${trimmed} 列。` : `已在右侧新增 ${trimmed} 列。`);
    setColumnDialog(null);
  };

  const moveColumn = (index: number, direction: -1 | 1) => {
    if (!document || index === 0 || index + direction <= 0 || index + direction >= document.schema.columns.length) return;
    setDocument((current) => {
      if (!current) return current;
      const next = cloneDocument(current);
      const target = index + direction;
      [next.schema.columns[index], next.schema.columns[target]] = [next.schema.columns[target], next.schema.columns[index]];
      next.rows.forEach((row) => ([row[index], row[target]] = [row[target], row[index]]));
      return next;
    });
  };

  const deleteColumn = (index: number) => {
    if (!document || index === 0) return;
    const column = document.schema.columns[index];
    if (!window.confirm(`删除 “${column.name}” 列？${column.type === 'json_ref' ? '关联 JSON 会保留为未引用文件。' : ''}`)) return;
    setDocument((current) => {
      if (!current) return current;
      const next = cloneDocument(current);
      next.schema.columns.splice(index, 1);
      next.rows.forEach((row) => row.splice(index, 1));
      return next;
    });
    setNotice(`已删除 ${column.name} 列。`);
  };

  const openHeaderMenu = (event: React.MouseEvent, index: number) => {
    event.preventDefault();
    setHeaderMenu({ index, x: event.clientX, y: event.clientY });
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

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark"><FileSpreadsheet size={20} /></span>
          <div>
            <strong>Game Data Editor</strong>
            <span>{document ? `${document.tableName}.csv` : '本地 CSV 数据包编辑器'}</span>
          </div>
        </div>
        <div className="toolbar">
          <button className="button button-secondary" onClick={createCsv} disabled={isBusy}>
            <Plus size={16} /> 新建 CSV
          </button>
          <button className="button button-secondary" onClick={openCsv} disabled={isBusy}>
            <FolderOpen size={16} /> 打开 CSV
          </button>
          <button className="button button-secondary" onClick={exportPackage} disabled={!document || isBusy}>
            <Download size={16} /> 导出数据包
          </button>
          <button className="button button-primary" onClick={save} disabled={!document || !isDirty || isBusy}>
            {isBusy ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}
            保存{isDirty ? ' *' : ''}
          </button>
        </div>
      </header>

      <section className="statusbar" aria-live="polite">
        <span className={issues.length ? 'status-error' : 'status-neutral'}>
          {issues.length ? <AlertCircle size={15} /> : <FileJson size={15} />}
          {issues.length ? `${issues.length} 个校验问题` : notice}
        </span>
        {document && <span>{document.rows.length} 行 · {document.schema.columns.length} 列</span>}
      </section>

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
        />
        <section className="editor-content">
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
                  <button className="button button-secondary" onClick={addRow}><Plus size={16} />新增行</button>
                  <button className="button button-secondary" onClick={duplicateSelected} disabled={selectedRows.size !== 1 || isBusy}><Copy size={16} />复制行</button>
                  <button className="button button-danger" onClick={deleteSelected} disabled={selectedRows.size === 0}><Trash2 size={16} />删除行</button>
                  <button className="button button-secondary" onClick={cleanOrphans} disabled={isBusy}><Trash2 size={16} />清理未引用 JSON</button>
                  <span className="grid-hint">复制行会复制 JSON 文件并生成新 UUID。</span>
                </div>
                <div className="table-scroll">
                  <table className="data-grid">
                    <thead>
                      <tr>
                        <th className="select-column"><input type="checkbox" aria-label="全选行" checked={document.rows.length > 0 && selectedRows.size === document.rows.length} onChange={(event) => setSelectedRows(event.target.checked ? new Set(document.rows.map((_, index) => index)) : new Set())} /></th>
                        <th className="index-column">#</th>
                        {document.schema.columns.map((column, index) => <th className="header-menu-trigger" onContextMenu={(event) => openHeaderMenu(event, index)} key={column.name}><span>{column.name}</span><small>{typeLabel(column.type)} · 右键操作</small></th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {document.rows.map((row, rowIndex) => (
                        <tr key={rowIndex} className={selectedRows.has(rowIndex) ? 'is-selected' : ''}>
                          <td className="select-column"><input type="checkbox" aria-label={`选择第 ${rowIndex + 1} 行`} checked={selectedRows.has(rowIndex)} onChange={() => setSelectedRows((current) => { const next = new Set(current); next.has(rowIndex) ? next.delete(rowIndex) : next.add(rowIndex); return next; })} /></td>
                          <td className="index-column">{rowIndex + 1}</td>
                          {document.schema.columns.map((column, columnIndex) => (
                            <td key={`${rowIndex}-${column.name}`} className={issueByCell.has(`${rowIndex}:${column.name}`) ? 'has-error' : ''} title={issueByCell.get(`${rowIndex}:${column.name}`)?.map((issue) => issue.message).join('\n')}>
                              <CellEditor
                                column={column}
                                value={row[columnIndex] ?? ''}
                                onChange={(value) => updateCell(rowIndex, columnIndex, value)}
                                onCreateReference={() => createReference(rowIndex, columnIndex)}
                                onOpenReference={() => openReference(row[columnIndex])}
                                disabled={isBusy}
                              />
                            </td>
                          ))}
                        </tr>
                      ))}
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
      {document && columnDialog && (
        <ColumnDialog
          mode={columnDialog.mode}
          column={columnDialog.mode === 'edit' ? document.schema.columns[columnDialog.index] : undefined}
          onCancel={() => setColumnDialog(null)}
          onSubmit={saveColumnDialog}
        />
      )}
    </main>
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
}) {
  return <aside className="folder-sidebar" aria-label="文件夹">
    <div className="folder-sidebar-header">
      <div>
        <span className="folder-sidebar-title">Folders</span>
        <span className="folder-sidebar-subtitle">已添加的 CSV 目录</span>
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
  const entryAvailable = (entry as FolderTreeEntry & { available?: boolean }).available !== false;
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

function CellEditor({ column, value, onChange, onCreateReference, onOpenReference, disabled }: {
  column: ColumnSchema;
  value: string;
  onChange: (value: string) => void;
  onCreateReference: () => void;
  onOpenReference: () => void;
  disabled: boolean;
}) {
  if (column.type === 'json_ref') {
    return value ? (
      <div className="json-ref-cell">
        <button className="json-open" onClick={onOpenReference} disabled={disabled} title={value}><FileJson size={15} />打开 JSON</button>
        <button className="icon-button" onClick={() => onChange('')} disabled={disabled} aria-label="清空 JSON 引用"><X size={14} /></button>
      </div>
    ) : <button className="json-create" onClick={onCreateReference} disabled={disabled}><Plus size={14} />新建 JSON</button>;
  }
  if (column.type === 'bool') {
    return <select className="cell-input" value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">—</option><option value="true">true</option><option value="false">false</option>
    </select>;
  }
  if (column.type === 'string') {
    return <TextCellEditor value={value} onChange={onChange} />;
  }
  return <input className="cell-input" value={value} onChange={(event) => onChange(event.target.value)} onFocus={(event) => event.currentTarget.select()} inputMode={column.type === 'int' || column.type === 'float' || column.type === 'vector2int' ? 'decimal' : 'text'} />;
}

function TextCellEditor({ value, onChange }: { value: string; onChange: (value: string) => void }) {
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
    <div className="menu-heading">{column.name} <span>{typeLabel(column.type)}</span></div>
    {isId && <div className="menu-locked">id 是锁定主键列</div>}
    <button className="menu-item" disabled={isId} onClick={onEdit}>编辑名称和类型</button>
    <button className="menu-item" disabled={!canMoveRight} onClick={onMoveRight}>向右移动</button>
    <button className="menu-item" onClick={onAddRight}>在右侧新增一列</button>
    <div className="menu-divider" />
    <button className="menu-item menu-item-danger" disabled={isId} onClick={onDelete}>删除列</button>
  </div>;
}

function ColumnDialog({ mode, column, onCancel, onSubmit }: {
  mode: 'edit' | 'add';
  column?: ColumnSchema;
  onCancel: () => void;
  onSubmit: (name: string, type: ColumnType) => void;
}) {
  const [name, setName] = useState(column?.name ?? 'new_column');
  const [type, setType] = useState<ColumnType>(column?.type ?? 'string');
  return <div className="modal-backdrop" role="presentation" onMouseDown={onCancel}>
    <section className="column-dialog" role="dialog" aria-modal="true" aria-label={mode === 'edit' ? '编辑列' : '新增列'} onMouseDown={(event) => event.stopPropagation()}>
      <h2>{mode === 'edit' ? '编辑列' : '在右侧新增列'}</h2>
      <label>列名<input autoFocus value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && onSubmit(name, type)} /></label>
      <label>类型<select value={type} onChange={(event) => setType(event.target.value as ColumnType)}>{columnTypes.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}</select></label>
      <div className="dialog-actions"><button className="button button-secondary" onClick={onCancel}>取消</button><button className="button button-primary" onClick={() => onSubmit(name, type)}>确定</button></div>
    </section>
  </div>;
}

function typeLabel(type: ColumnType) {
  return columnTypes.find((entry) => entry.value === type)?.label ?? type;
}

function messageFrom(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
