export type ColumnType =
  | 'string'
  | 'int'
  | 'float'
  | 'bool'
  | 'json_ref'
  | 'enum'
  | 'string_array'
  | 'vector2int'
  | 'string_dictionary';

export interface ColumnSchema {
  name: string;
  type: ColumnType;
}

export interface TableSchema {
  version: number;
  primaryKey: string;
  columns: ColumnSchema[];
}

export interface TableDocument {
  tableName: string;
  schema: TableSchema;
  rows: string[][];
  schemaWasMissing: boolean;
}

export interface ValidationIssue {
  rowIndex: number | null;
  rowId: string | null;
  column: string | null;
  message: string;
}

export interface SaveResult {
  saved: boolean;
  issues: ValidationIssue[];
  message?: string;
}

/** A CSV file or directory displayed beneath a managed folder root. */
export interface FolderTreeEntry {
  name: string;
  path: string;
  kind: 'folder' | 'csv';
  available: boolean;
  children?: FolderTreeEntry[];
  error?: string | null;
}

/** A user-managed folder root and its recursively discovered CSV contents. */
export interface FolderTreeRoot {
  name: string;
  path: string;
  available: boolean;
  error?: string | null;
  children: FolderTreeEntry[];
}
