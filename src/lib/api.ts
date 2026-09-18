import { invoke } from '@tauri-apps/api/core';
import type {
  FolderTreeRoot,
  LinkedRowResult,
  SaveResult,
  TableDocument,
  ValidationIssue,
} from '../types';

export const api = {
  openCsv: () => invoke<TableDocument | null>('open_csv_dialog'),
  chooseAndAddFolder: () =>
    invoke<FolderTreeRoot[] | null>('add_folder_dialog'),
  listFolderTree: () => invoke<FolderTreeRoot[]>('list_folder_tree'),
  removeManagedFolder: (path: string) =>
    invoke<FolderTreeRoot[]>('remove_folder_root', { path }),
  openCsvAtPath: (path: string) =>
    invoke<TableDocument>('open_csv_from_folder', { path }),
  activateCsvSession: (path: string) =>
    invoke<void>('activate_csv_session', { path }),
  listSiblingSheets: () => invoke<string[]>('list_sibling_sheets'),
  openLinkedRow: (tableName: string, rowId: string) =>
    invoke<LinkedRowResult>('open_linked_row', { tableName, rowId }),
  createCsv: () => invoke<TableDocument | null>('create_csv_dialog'),
  validate: (document: TableDocument) =>
    invoke<ValidationIssue[]>('validate_document', { document }),
  save: (document: TableDocument) =>
    invoke<SaveResult>('save_document', { document }),
  exportPackage: (document: TableDocument) =>
    invoke<string>('export_table_package', { document }),
  createJsonRef: () => invoke<string>('create_json_ref'),
  cloneJsonRef: (reference: string) =>
    invoke<string>('clone_json_ref', { reference }),
  openJsonRef: (reference: string) =>
    invoke<void>('open_json_ref', { reference }),
  listOrphans: (document: TableDocument) =>
    invoke<string[]>('list_orphan_json_refs', { document }),
  deleteOrphans: (document: TableDocument, references: string[]) =>
    invoke<void>('delete_orphan_json_refs', { document, references }),
};
