use std::{
    collections::{HashMap, HashSet},
    env,
    fs::{self, OpenOptions},
    io::{Cursor, Write},
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
    time::{Duration, SystemTime},
};

use csv::{ReaderBuilder, WriterBuilder};
use notify_debouncer_mini::{
    new_debouncer,
    notify::{RecommendedWatcher, RecursiveMode},
    DebounceEventResult, Debouncer,
};
use rfd::FileDialog;
use serde::{Deserialize, Serialize};
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder},
    AppHandle, Emitter, Manager,
};
use uuid::Uuid;

#[derive(Default)]
struct AppState {
    session: Mutex<Option<TableSession>>,
    folders: Mutex<FolderState>,
}

#[derive(Default)]
struct FolderState {
    roots: Vec<FolderRootRecord>,
    watcher: Option<Debouncer<RecommendedWatcher>>,
    watch_errors: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct FolderRootRecord {
    path: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct FolderRootsConfig {
    #[serde(default)]
    roots: Vec<FolderRootRecord>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderRoot {
    name: String,
    path: String,
    available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    children: Vec<FolderTreeEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderTreeEntry {
    name: String,
    path: String,
    kind: FolderEntryKind,
    available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    children: Vec<FolderTreeEntry>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FolderEntryKind {
    Folder,
    Csv,
}

#[derive(Clone)]
struct TableSession {
    csv_path: PathBuf,
    schema_path: PathBuf,
    json_dir: PathBuf,
    csv_fingerprint: Option<FileFingerprint>,
    schema_fingerprint: Option<FileFingerprint>,
}

#[derive(Clone, PartialEq, Eq)]
struct FileFingerprint {
    size: u64,
    modified: Option<SystemTime>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableDocument {
    table_name: String,
    schema: TableSchema,
    rows: Vec<Vec<String>>,
    schema_was_missing: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableSchema {
    version: u32,
    primary_key: String,
    columns: Vec<ColumnSchema>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnSchema {
    name: String,
    #[serde(rename = "type")]
    column_type: ColumnType,
    #[serde(
        rename = "editorType",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    editor_type: Option<String>,
    #[serde(rename = "linkSheet", default, skip_serializing_if = "Option::is_none")]
    link_sheet: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ColumnType {
    String,
    Int,
    Float,
    Bool,
    JsonRef,
    Enum,
    StringArray,
    #[serde(rename = "vector2int")]
    Vector2Int,
    StringDictionary,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationIssue {
    row_index: Option<usize>,
    row_id: Option<String>,
    column: Option<String>,
    message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    saved: bool,
    issues: Vec<ValidationIssue>,
    message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedRowResult {
    document: TableDocument,
    path: String,
    row_index: usize,
}

#[tauri::command]
fn open_csv_dialog(state: tauri::State<'_, AppState>) -> Result<Option<TableDocument>, String> {
    let Some(path) = FileDialog::new()
        .set_title("打开游戏数据 CSV")
        .add_filter("CSV 文件", &["csv"])
        .pick_file()
    else {
        return Ok(None);
    };

    let (document, session) = load_table_package(&path)?;
    let mut active_session = state.session.lock().map_err(|_| "无法锁定当前文件会话。")?;
    *active_session = Some(session);
    Ok(Some(document))
}

#[tauri::command]
fn add_folder_dialog(
    state: tauri::State<'_, AppState>,
    app: AppHandle,
) -> Result<Option<Vec<FolderRoot>>, String> {
    let Some(selected_path) = FileDialog::new()
        .set_title("选择包含 CSV 的目录")
        .pick_folder()
    else {
        return Ok(None);
    };
    let canonical_path = canonical_directory_path(&selected_path)?;
    let config_path = folder_roots_config_path()?;

    let was_duplicate = {
        let mut folders = state.folders.lock().map_err(|_| "无法锁定目录收藏。")?;
        if folders
            .roots
            .iter()
            .any(|root| folder_paths_match(&root.path, &canonical_path))
        {
            true
        } else {
            let previous_roots = folders.roots.clone();
            folders.roots.push(FolderRootRecord {
                path: canonical_path,
            });
            if let Err(error) = save_folder_roots_to_path(&config_path, &folders.roots) {
                folders.roots = previous_roots;
                return Err(error);
            }
            sync_folder_watches(&mut folders, &app);
            false
        }
    };

    let snapshot = folder_tree_snapshot(&state)?;
    if !was_duplicate {
        emit_folder_tree_changed(&app);
    }
    Ok(Some(snapshot))
}

#[tauri::command]
fn list_folder_tree(
    state: tauri::State<'_, AppState>,
    app: AppHandle,
) -> Result<Vec<FolderRoot>, String> {
    let snapshot = folder_tree_snapshot(&state)?;
    if snapshot
        .iter()
        .any(|root| !root.available || root.error.is_some())
    {
        let mut folders = state.folders.lock().map_err(|_| "无法锁定目录收藏。")?;
        sync_folder_watches(&mut folders, &app);
        drop(folders);
        return folder_tree_snapshot(&state);
    }
    Ok(snapshot)
}

#[tauri::command]
fn remove_folder_root(
    state: tauri::State<'_, AppState>,
    app: AppHandle,
    path: String,
) -> Result<Vec<FolderRoot>, String> {
    let requested_path = PathBuf::from(path);
    let config_path = folder_roots_config_path()?;

    {
        let mut folders = state.folders.lock().map_err(|_| "无法锁定目录收藏。")?;
        let previous_roots = folders.roots.clone();
        remove_folder_root_record(&mut folders.roots, &requested_path)?;
        if let Err(error) = save_folder_roots_to_path(&config_path, &folders.roots) {
            folders.roots = previous_roots;
            return Err(error);
        }
        sync_folder_watches(&mut folders, &app);
    }

    let snapshot = folder_tree_snapshot(&state)?;
    emit_folder_tree_changed(&app);
    Ok(snapshot)
}

#[tauri::command]
fn open_csv_from_folder(
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<TableDocument, String> {
    let roots = {
        let folders = state.folders.lock().map_err(|_| "无法锁定目录收藏。")?;
        folders.roots.clone()
    };
    let csv_path = validate_csv_path_in_roots(Path::new(&path), &roots)?;
    let (document, session) = load_table_package(&csv_path)?;
    let mut active_session = state.session.lock().map_err(|_| "无法锁定当前文件会话。")?;
    *active_session = Some(session);
    Ok(document)
}

#[tauri::command]
fn list_sibling_sheets(state: tauri::State<'_, AppState>) -> Result<Vec<String>, String> {
    let active_session = state.session.lock().map_err(|_| "无法锁定当前文件会话。")?;
    let session = active_session.as_ref().ok_or("请先打开一个 CSV 文件。")?;
    sibling_sheet_names(&session.csv_path)
}

#[tauri::command]
fn open_linked_row(
    state: tauri::State<'_, AppState>,
    table_name: String,
    row_id: String,
) -> Result<LinkedRowResult, String> {
    let mut active_session = state.session.lock().map_err(|_| "无法锁定当前文件会话。")?;
    let current_session = active_session.as_ref().ok_or("请先打开一个 CSV 文件。")?;
    let target_path = sibling_sheet_path(&current_session.csv_path, &table_name)?;
    let (document, target_session) = load_table_package(&target_path)?;
    let row_index = document
        .rows
        .iter()
        .position(|row| row.first().map(String::as_str) == Some(row_id.as_str()))
        .ok_or_else(|| format!("{} 表中没有 id 为 {} 的行。", table_name, row_id))?;
    let path = target_session.csv_path.to_string_lossy().into_owned();
    *active_session = Some(target_session);
    Ok(LinkedRowResult {
        document,
        path,
        row_index,
    })
}

#[tauri::command]
fn create_csv_dialog(state: tauri::State<'_, AppState>) -> Result<Option<TableDocument>, String> {
    let Some(selected_path) = FileDialog::new()
        .set_title("新建游戏数据 CSV")
        .set_file_name("new_table.csv")
        .add_filter("CSV 文件", &["csv"])
        .save_file()
    else {
        return Ok(None);
    };
    let csv_path = if selected_path.extension().is_some() {
        selected_path
    } else {
        selected_path.with_extension("csv")
    };
    let (document, session) = create_table_package(csv_path)?;
    let mut active_session = state.session.lock().map_err(|_| "无法锁定当前文件会话。")?;
    *active_session = Some(session);
    Ok(Some(document))
}

fn create_table_package(csv_path: PathBuf) -> Result<(TableDocument, TableSession), String> {
    let table_name = csv_path
        .file_stem()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .ok_or("CSV 文件名无效。")?
        .to_string();
    let parent = csv_path.parent().ok_or("CSV 缺少上级目录。")?;
    let schema_path = parent.join(format!("{table_name}.schema.json"));
    let json_dir = parent.join(&table_name);

    let document = TableDocument {
        table_name,
        schema: TableSchema {
            version: 1,
            primary_key: "id".to_string(),
            columns: vec![ColumnSchema {
                name: "id".to_string(),
                column_type: ColumnType::String,
                editor_type: None,
                link_sheet: None,
            }],
        },
        rows: Vec::new(),
        schema_was_missing: false,
    };
    let csv_content = serialize_csv(&document)?;
    let schema_content = serde_json::to_vec_pretty(&document.schema)
        .map_err(|error| format!("无法序列化 Schema：{error}"))?;

    if json_dir.exists() {
        fs::remove_dir_all(&json_dir).map_err(|error| format!("无法清空 JSON 目录：{error}"))?;
    }
    fs::create_dir_all(&json_dir).map_err(|error| format!("无法创建 JSON 目录：{error}"))?;
    fs::write(&csv_path, csv_content).map_err(|error| format!("无法覆盖 CSV：{error}"))?;
    fs::write(&schema_path, schema_content).map_err(|error| format!("无法覆盖 Schema：{error}"))?;

    let session = TableSession {
        csv_fingerprint: fingerprint(&csv_path)?,
        schema_fingerprint: fingerprint(&schema_path)?,
        csv_path,
        schema_path,
        json_dir,
    };
    Ok((document, session))
}

#[tauri::command]
fn validate_document(
    state: tauri::State<'_, AppState>,
    document: TableDocument,
) -> Result<Vec<ValidationIssue>, String> {
    let active_session = state.session.lock().map_err(|_| "无法锁定当前文件会话。")?;
    let session = active_session.as_ref().ok_or("请先打开一个 CSV 文件。")?;
    Ok(validate_document_for_session(&document, session))
}

#[tauri::command]
fn save_document(
    state: tauri::State<'_, AppState>,
    mut document: TableDocument,
) -> Result<SaveResult, String> {
    let mut active_session = state.session.lock().map_err(|_| "无法锁定当前文件会话。")?;
    let session = active_session.as_mut().ok_or("请先打开一个 CSV 文件。")?;

    let issues = validate_document_for_session(&document, session);
    if !issues.is_empty() {
        return Ok(SaveResult {
            saved: false,
            issues,
            message: Some("请先修复全部校验问题。".to_string()),
        });
    }
    assert_session_has_not_changed(session)?;

    document.schema_was_missing = false;
    let schema_content = serde_json::to_vec_pretty(&document.schema)
        .map_err(|error| format!("无法序列化 Schema：{error}"))?;
    let csv_content = serialize_csv(&document)?;

    let original_schema = read_optional(&session.schema_path)?;
    write_backup_and_replace(&session.schema_path, &schema_content)?;
    if let Err(error) = write_backup_and_replace(&session.csv_path, &csv_content) {
        restore_file(&session.schema_path, original_schema.as_deref())?;
        return Err(format!("CSV 保存失败，Schema 已回滚：{error}"));
    }

    session.csv_fingerprint = fingerprint(&session.csv_path)?;
    session.schema_fingerprint = fingerprint(&session.schema_path)?;
    Ok(SaveResult {
        saved: true,
        issues: Vec::new(),
        message: None,
    })
}

#[tauri::command]
fn create_json_ref(state: tauri::State<'_, AppState>) -> Result<String, String> {
    let active_session = state.session.lock().map_err(|_| "无法锁定当前文件会话。")?;
    let session = active_session.as_ref().ok_or("请先打开一个 CSV 文件。")?;
    fs::create_dir_all(&session.json_dir)
        .map_err(|error| format!("无法创建 JSON 目录：{error}"))?;

    loop {
        let reference = Uuid::new_v4().hyphenated().to_string();
        let path = session.json_dir.join(format!("{reference}.json"));
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                file.write_all(b"{}\n")
                    .map_err(|error| format!("无法写入 JSON 文件：{error}"))?;
                file.sync_all()
                    .map_err(|error| format!("无法完成 JSON 文件写入：{error}"))?;
                return Ok(reference);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("无法创建 JSON 文件：{error}")),
        }
    }
}

#[tauri::command]
fn clone_json_ref(state: tauri::State<'_, AppState>, reference: String) -> Result<String, String> {
    let active_session = state.session.lock().map_err(|_| "无法锁定当前文件会话。")?;
    let session = active_session.as_ref().ok_or("请先打开一个 CSV 文件。")?;
    let source = json_path_for_existing_ref(session, &reference)?;
    let content = fs::read(&source).map_err(|error| format!("无法读取源 JSON：{error}"))?;
    serde_json::from_slice::<serde_json::Value>(&content)
        .map_err(|error| format!("源 JSON 格式无效：{error}"))?;
    fs::create_dir_all(&session.json_dir)
        .map_err(|error| format!("无法创建 JSON 目录：{error}"))?;

    loop {
        let new_reference = Uuid::new_v4().hyphenated().to_string();
        let target = session.json_dir.join(format!("{new_reference}.json"));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
        {
            Ok(mut file) => {
                file.write_all(&content)
                    .map_err(|error| format!("无法写入复制的 JSON：{error}"))?;
                file.sync_all()
                    .map_err(|error| format!("无法完成 JSON 写入：{error}"))?;
                return Ok(new_reference);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("无法创建复制的 JSON：{error}")),
        }
    }
}

#[tauri::command]
fn open_json_ref(state: tauri::State<'_, AppState>, reference: String) -> Result<(), String> {
    let active_session = state.session.lock().map_err(|_| "无法锁定当前文件会话。")?;
    let session = active_session.as_ref().ok_or("请先打开一个 CSV 文件。")?;
    let path = json_path_for_existing_ref(session, &reference)?;

    launch_vscode(&path)
}

#[tauri::command]
fn list_orphan_json_refs(
    state: tauri::State<'_, AppState>,
    document: TableDocument,
) -> Result<Vec<String>, String> {
    let active_session = state.session.lock().map_err(|_| "无法锁定当前文件会话。")?;
    let session = active_session.as_ref().ok_or("请先打开一个 CSV 文件。")?;
    find_orphan_refs(&document, session)
}

#[tauri::command]
fn delete_orphan_json_refs(
    state: tauri::State<'_, AppState>,
    document: TableDocument,
    references: Vec<String>,
) -> Result<(), String> {
    let active_session = state.session.lock().map_err(|_| "无法锁定当前文件会话。")?;
    let session = active_session.as_ref().ok_or("请先打开一个 CSV 文件。")?;
    let orphans: HashSet<String> = find_orphan_refs(&document, session)?.into_iter().collect();
    for reference in references {
        if !orphans.contains(&reference) {
            return Err("选择的文件已不再是未引用 JSON，未执行删除。".to_string());
        }
        let path = json_path_for_existing_ref(session, &reference)?;
        fs::remove_file(path).map_err(|error| format!("无法删除未引用 JSON：{error}"))?;
    }
    Ok(())
}

#[tauri::command]
fn export_table_package(
    state: tauri::State<'_, AppState>,
    document: TableDocument,
) -> Result<String, String> {
    let active_session = state.session.lock().map_err(|_| "无法锁定当前文件会话。")?;
    let session = active_session.as_ref().ok_or("请先打开一个 CSV 文件。")?;
    let issues = validate_document_for_session(&document, session);
    if !issues.is_empty() {
        return Err("请先修复校验问题后再导出。".to_string());
    }

    let Some(destination) = FileDialog::new().set_title("选择导出目录").pick_folder() else {
        return Err("已取消导出。".to_string());
    };
    let export_root = destination.join(format!("{}_export", document.table_name));
    if export_root.exists() {
        return Err(format!("导出目录已存在：{}", export_root.display()));
    }
    fs::create_dir_all(&export_root).map_err(|error| format!("无法创建导出目录：{error}"))?;

    let csv_path = export_root.join(format!("{}.csv", document.table_name));
    let schema_path = export_root.join(format!("{}.schema.json", document.table_name));
    fs::write(&csv_path, serialize_csv(&document)?)
        .map_err(|error| format!("无法写入导出 CSV：{error}"))?;
    let schema = serde_json::to_vec_pretty(&document.schema)
        .map_err(|error| format!("无法写入导出 Schema：{error}"))?;
    fs::write(&schema_path, schema).map_err(|error| format!("无法写入导出 Schema：{error}"))?;

    let references = collect_references(&document);
    if !references.is_empty() {
        let export_json_dir = export_root.join(&document.table_name);
        fs::create_dir_all(&export_json_dir)
            .map_err(|error| format!("无法创建导出 JSON 目录：{error}"))?;
        for reference in references {
            let source = json_path_for_existing_ref(session, &reference)?;
            fs::copy(source, export_json_dir.join(format!("{reference}.json")))
                .map_err(|error| format!("无法复制 JSON 引用：{error}"))?;
        }
    }
    Ok(export_root.display().to_string())
}

const FOLDER_ROOTS_APP_DATA_DIRECTORY: &str = "com.dongyun.game-data-editor";
const FOLDER_ROOTS_CONFIG_FILE: &str = "folder-roots.json";

fn folder_roots_config_path() -> Result<PathBuf, String> {
    let local_app_data =
        env::var_os("LOCALAPPDATA").ok_or("无法定位 %LOCALAPPDATA%，因此无法保存目录收藏。")?;
    Ok(PathBuf::from(local_app_data)
        .join(FOLDER_ROOTS_APP_DATA_DIRECTORY)
        .join(FOLDER_ROOTS_CONFIG_FILE))
}

fn load_folder_roots_from_path(path: &Path) -> Result<Vec<FolderRootRecord>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = fs::read(path).map_err(|error| format!("无法读取目录收藏：{error}"))?;
    let config: FolderRootsConfig = serde_json::from_slice(&content)
        .map_err(|error| format!("目录收藏配置格式无效：{error}"))?;
    Ok(deduplicate_folder_roots(config.roots))
}

fn save_folder_roots_to_path(path: &Path, roots: &[FolderRootRecord]) -> Result<(), String> {
    let parent = path.parent().ok_or("目录收藏配置路径无效。")?;
    fs::create_dir_all(parent).map_err(|error| format!("无法创建目录收藏位置：{error}"))?;
    let content = serde_json::to_vec_pretty(&FolderRootsConfig {
        roots: roots.to_vec(),
    })
    .map_err(|error| format!("无法序列化目录收藏：{error}"))?;
    write_backup_and_replace(path, &content).map_err(|error| format!("无法保存目录收藏：{error}"))
}

fn deduplicate_folder_roots(roots: Vec<FolderRootRecord>) -> Vec<FolderRootRecord> {
    let mut known_paths = HashSet::new();
    roots
        .into_iter()
        .filter(|root| root.path.is_absolute() && !root.path.as_os_str().is_empty())
        .filter_map(|root| {
            let path = canonical_directory_path(&root.path).unwrap_or(root.path);
            let key = folder_path_key(&path);
            known_paths.insert(key).then_some(FolderRootRecord { path })
        })
        .collect()
}

fn canonical_directory_path(path: &Path) -> Result<PathBuf, String> {
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("无法访问目录 {}：{error}", path.display()))?;
    let metadata = fs::metadata(&canonical)
        .map_err(|error| format!("无法读取目录 {}：{error}", canonical.display()))?;
    if !metadata.is_dir() {
        return Err(format!("所选路径不是目录：{}", canonical.display()));
    }
    Ok(canonical)
}

fn folder_paths_match(left: &Path, right: &Path) -> bool {
    let left = canonical_directory_path(left).unwrap_or_else(|_| left.to_path_buf());
    let right = canonical_directory_path(right).unwrap_or_else(|_| right.to_path_buf());
    folder_path_key(&left) == folder_path_key(&right)
}

fn folder_path_key(path: &Path) -> String {
    let value = path.to_string_lossy().into_owned();
    #[cfg(windows)]
    {
        value.to_lowercase()
    }
    #[cfg(not(windows))]
    {
        value
    }
}

fn remove_folder_root_record(
    roots: &mut Vec<FolderRootRecord>,
    requested_path: &Path,
) -> Result<(), String> {
    let Some(index) = roots
        .iter()
        .position(|root| folder_paths_match(&root.path, requested_path))
    else {
        return Err("未找到要移除的目录收藏。".to_string());
    };
    roots.remove(index);
    Ok(())
}

fn folder_tree_snapshot(state: &AppState) -> Result<Vec<FolderRoot>, String> {
    let (roots, watch_errors) = {
        let folders = state.folders.lock().map_err(|_| "无法锁定目录收藏。")?;
        (folders.roots.clone(), folders.watch_errors.clone())
    };
    Ok(build_folder_tree(&roots, &watch_errors))
}

fn build_folder_tree(
    roots: &[FolderRootRecord],
    watch_errors: &HashMap<String, String>,
) -> Vec<FolderRoot> {
    roots
        .iter()
        .map(|root| build_folder_root(root, watch_errors))
        .collect()
}

fn build_folder_root(
    root: &FolderRootRecord,
    watch_errors: &HashMap<String, String>,
) -> FolderRoot {
    let root_path = root.path.clone();
    let watch_error = watch_errors.get(&folder_path_key(&root_path)).cloned();
    match canonical_directory_path(&root_path) {
        Ok(canonical_path) => match scan_directory_children(&canonical_path) {
            Ok(children) => FolderRoot {
                name: path_display_name(&canonical_path),
                path: path_to_string(&canonical_path),
                available: true,
                error: watch_error,
                children,
            },
            Err(error) => FolderRoot {
                name: path_display_name(&canonical_path),
                path: path_to_string(&canonical_path),
                available: false,
                error: combine_folder_errors(watch_error, error),
                children: Vec::new(),
            },
        },
        Err(error) => FolderRoot {
            name: path_display_name(&root_path),
            path: path_to_string(&root_path),
            available: false,
            error: combine_folder_errors(watch_error, error),
            children: Vec::new(),
        },
    }
}

fn combine_folder_errors(existing: Option<String>, next: String) -> Option<String> {
    match existing {
        Some(existing) => Some(format!("{existing}；{next}")),
        None => Some(next),
    }
}

fn scan_directory_children(path: &Path) -> Result<Vec<FolderTreeEntry>, String> {
    let entries =
        fs::read_dir(path).map_err(|error| format!("无法读取目录 {}：{error}", path.display()))?;
    let mut folders = Vec::new();
    let mut csv_files = Vec::new();

    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                eprintln!("跳过无法读取的目录项 {}：{error}", path.display());
                continue;
            }
        };
        let child_path = entry.path();
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(error) => {
                eprintln!("跳过无法读取类型的目录项 {}：{error}", child_path.display());
                continue;
            }
        };

        if file_type.is_dir() {
            match dir_entry_is_symlink_or_reparse(&entry, &file_type) {
                Ok(true) => continue,
                Ok(false) => {
                    let folder = scan_folder_entry(&child_path);
                    if folder.error.is_some() || !folder.children.is_empty() {
                        folders.push(folder);
                    }
                }
                Err(error) => folders.push(unavailable_folder_entry(&child_path, error)),
            }
        } else if file_type.is_file()
            && is_csv_path(&child_path)
            && matches!(
                dir_entry_is_symlink_or_reparse(&entry, &file_type),
                Ok(false)
            )
        {
            csv_files.push(FolderTreeEntry {
                name: path_display_name(&child_path),
                path: path_to_string(&child_path),
                kind: FolderEntryKind::Csv,
                available: true,
                error: None,
                children: Vec::new(),
            });
        }
    }

    sort_tree_entries(&mut folders);
    sort_tree_entries(&mut csv_files);
    folders.extend(csv_files);
    Ok(folders)
}

fn scan_folder_entry(path: &Path) -> FolderTreeEntry {
    match scan_directory_children(path) {
        Ok(children) => FolderTreeEntry {
            name: path_display_name(path),
            path: path_to_string(path),
            kind: FolderEntryKind::Folder,
            available: true,
            error: None,
            children,
        },
        Err(error) => unavailable_folder_entry(path, error),
    }
}

fn unavailable_folder_entry(path: &Path, error: String) -> FolderTreeEntry {
    FolderTreeEntry {
        name: path_display_name(path),
        path: path_to_string(path),
        kind: FolderEntryKind::Folder,
        available: false,
        error: Some(error),
        children: Vec::new(),
    }
}

fn dir_entry_is_symlink_or_reparse(
    entry: &fs::DirEntry,
    file_type: &fs::FileType,
) -> Result<bool, String> {
    if file_type.is_symlink() {
        return Ok(true);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;

        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        let metadata = entry
            .metadata()
            .map_err(|error| format!("无法读取目录项属性：{error}"))?;
        Ok(metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0)
    }
    #[cfg(not(windows))]
    {
        let _ = entry;
        Ok(false)
    }
}

fn path_is_symlink_or_reparse(path: &Path) -> Result<bool, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("无法读取路径 {}：{error}", path.display()))?;
    if metadata.file_type().is_symlink() {
        return Ok(true);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;

        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        Ok(metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0)
    }
    #[cfg(not(windows))]
    {
        Ok(false)
    }
}

fn is_csv_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.eq_ignore_ascii_case("csv"))
        == Some(true)
}

fn sort_tree_entries(entries: &mut [FolderTreeEntry]) {
    entries.sort_by(|left, right| {
        left.name
            .to_lowercase()
            .cmp(&right.name.to_lowercase())
            .then_with(|| left.name.cmp(&right.name))
            .then_with(|| left.path.cmp(&right.path))
    });
}

fn path_display_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| path_to_string(path))
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn sync_folder_watches(folders: &mut FolderState, app: &AppHandle) {
    folders.watch_errors.clear();
    let mut watcher = match create_folder_watcher(app.clone()) {
        Ok(watcher) => watcher,
        Err(error) => {
            let message = format!("无法监听目录变化：{error}");
            for root in &folders.roots {
                if canonical_directory_path(&root.path).is_ok() {
                    folders
                        .watch_errors
                        .insert(folder_path_key(&root.path), message.clone());
                }
            }
            folders.watcher = None;
            return;
        }
    };

    for root in &folders.roots {
        let path = match canonical_directory_path(&root.path) {
            Ok(path) => path,
            Err(error) => {
                folders.watch_errors.insert(
                    folder_path_key(&root.path),
                    format!("无法监听目录变化：{error}"),
                );
                continue;
            }
        };
        if let Err(error) = watcher.watcher().watch(&path, RecursiveMode::Recursive) {
            folders.watch_errors.insert(
                folder_path_key(&root.path),
                format!("无法监听目录变化：{error}"),
            );
        }
    }
    folders.watcher = Some(watcher);
}

fn create_folder_watcher(app: AppHandle) -> Result<Debouncer<RecommendedWatcher>, String> {
    new_debouncer(
        Duration::from_millis(350),
        move |result: DebounceEventResult| match result {
            Ok(events) if !events.is_empty() => emit_folder_tree_changed(&app),
            Ok(_) => {}
            Err(error) => {
                eprintln!("目录监听发生错误：{error}");
                emit_folder_tree_changed(&app);
            }
        },
    )
    .map_err(|error| error.to_string())
}

fn emit_folder_tree_changed(app: &AppHandle) {
    if let Err(error) = app.emit("folder-tree-changed", ()) {
        eprintln!("无法发送目录树刷新事件：{error}");
    }
}

fn validate_csv_path_in_roots(
    requested_path: &Path,
    roots: &[FolderRootRecord],
) -> Result<PathBuf, String> {
    if !requested_path.is_absolute() {
        return Err("只能从已收藏目录中打开绝对路径的 CSV 文件。".to_string());
    }
    if path_contains_symlink_or_reparse(requested_path)? {
        return Err("CSV 路径不能穿过符号链接或重解析点。".to_string());
    }
    let canonical_path = requested_path
        .canonicalize()
        .map_err(|error| format!("无法访问 CSV 文件：{error}"))?;
    let metadata =
        fs::metadata(&canonical_path).map_err(|error| format!("无法读取 CSV 文件：{error}"))?;
    if !metadata.is_file() || !is_csv_path(&canonical_path) {
        return Err("请选择已收藏目录中的普通 .csv 文件。".to_string());
    }

    for root in roots {
        let Ok(canonical_root) = canonical_directory_path(&root.path) else {
            continue;
        };
        if canonical_path.starts_with(&canonical_root) {
            return Ok(canonical_path);
        }
    }
    Err("该 CSV 不在任何已收藏目录中。".to_string())
}

fn path_contains_symlink_or_reparse(path: &Path) -> Result<bool, String> {
    let mut current = path.to_path_buf();
    loop {
        if path_is_symlink_or_reparse(&current)? {
            return Ok(true);
        }
        let Some(parent) = current.parent() else {
            return Ok(false);
        };
        if parent == current {
            return Ok(false);
        }
        current = parent.to_path_buf();
    }
}

fn initialize_folder_state(app: &AppHandle) -> Result<(), String> {
    let config_path = folder_roots_config_path()?;
    let roots = load_folder_roots_from_path(&config_path)?;
    let state = app.state::<AppState>();
    let mut folders = state.folders.lock().map_err(|_| "无法锁定目录收藏。")?;
    folders.roots = roots;
    sync_folder_watches(&mut folders, app);
    Ok(())
}

fn sibling_sheet_names(csv_path: &Path) -> Result<Vec<String>, String> {
    let parent = csv_path.parent().ok_or("CSV 缺少上级目录。")?;
    let current_name = csv_path.file_stem().and_then(|name| name.to_str());
    let entries =
        fs::read_dir(parent).map_err(|error| format!("无法读取当前 CSV 目录：{error}"))?;
    let mut names = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| format!("无法读取当前 CSV 目录项：{error}"))?;
        let path = entry.path();
        if !path.is_file()
            || path
                .extension()
                .and_then(|extension| extension.to_str())
                .map(|extension| !extension.eq_ignore_ascii_case("csv"))
                .unwrap_or(true)
        {
            continue;
        }
        let Some(name) = path.file_stem().and_then(|name| name.to_str()) else {
            continue;
        };
        if Some(name) != current_name {
            names.push(name.to_string());
        }
    }
    names.sort_by_key(|name| name.to_lowercase());
    Ok(names)
}

fn sibling_sheet_path(csv_path: &Path, table_name: &str) -> Result<PathBuf, String> {
    if table_name.trim().is_empty() {
        return Err("关联表不能为空。".to_string());
    }
    let current_name = csv_path.file_stem().and_then(|name| name.to_str());
    if current_name == Some(table_name) {
        return Err("关联表不能是当前表。".to_string());
    }
    let parent = csv_path.parent().ok_or("CSV 缺少上级目录。")?;
    for entry in fs::read_dir(parent).map_err(|error| format!("无法读取当前 CSV 目录：{error}"))?
    {
        let path = entry
            .map_err(|error| format!("无法读取当前 CSV 目录项：{error}"))?
            .path();
        if path.is_file()
            && path
                .extension()
                .and_then(|extension| extension.to_str())
                .map(|extension| extension.eq_ignore_ascii_case("csv"))
                == Some(true)
            && path.file_stem().and_then(|name| name.to_str()) == Some(table_name)
        {
            return Ok(path);
        }
    }
    Err(format!("当前文件夹中没有找到 {}.csv。", table_name))
}

fn load_table_package(csv_path: &Path) -> Result<(TableDocument, TableSession), String> {
    let csv_path = csv_path
        .canonicalize()
        .map_err(|error| format!("无法访问 CSV 文件：{error}"))?;
    if csv_path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.eq_ignore_ascii_case("csv"))
        != Some(true)
    {
        return Err("请选择 .csv 文件。".to_string());
    }
    let table_name = csv_path
        .file_stem()
        .and_then(|name| name.to_str())
        .ok_or("CSV 文件名无效。")?
        .to_string();
    let parent = csv_path.parent().ok_or("CSV 缺少上级目录。")?;
    let schema_path = parent.join(format!("{table_name}.schema.json"));
    let json_dir = parent.join(&table_name);
    let (headers, rows) = read_csv(&csv_path)?;
    validate_headers(&headers)?;

    let (schema, schema_was_missing) = if schema_path.exists() {
        let content =
            fs::read(&schema_path).map_err(|error| format!("无法读取 Schema：{error}"))?;
        let schema: TableSchema = serde_json::from_slice(&content)
            .map_err(|error| format!("Schema 格式无效：{error}"))?;
        ensure_schema_matches_headers(&schema, &headers)?;
        (schema, false)
    } else {
        (
            TableSchema {
                version: 1,
                primary_key: "id".to_string(),
                columns: headers
                    .into_iter()
                    .map(|name| ColumnSchema {
                        name,
                        column_type: ColumnType::String,
                        editor_type: None,
                        link_sheet: None,
                    })
                    .collect(),
            },
            true,
        )
    };

    let document = TableDocument {
        table_name,
        schema,
        rows,
        schema_was_missing,
    };
    let session = TableSession {
        csv_fingerprint: fingerprint(&csv_path)?,
        schema_fingerprint: fingerprint(&schema_path)?,
        csv_path,
        schema_path,
        json_dir,
    };
    Ok((document, session))
}

fn read_csv(path: &Path) -> Result<(Vec<String>, Vec<Vec<String>>), String> {
    let bytes = fs::read(path).map_err(|error| format!("无法读取 CSV：{error}"))?;
    let content = String::from_utf8(bytes).map_err(|_| "CSV 必须采用 UTF-8 编码。")?;
    let content = content.strip_prefix('\u{feff}').unwrap_or(&content);
    let mut reader = ReaderBuilder::new()
        .has_headers(true)
        .flexible(false)
        .from_reader(Cursor::new(content.as_bytes()));
    let headers = reader
        .headers()
        .map_err(|error| format!("无法读取 CSV 表头：{error}"))?
        .iter()
        .map(str::to_string)
        .collect::<Vec<_>>();
    let mut rows = Vec::new();
    for result in reader.records() {
        let record = result.map_err(|error| format!("CSV 行格式无效：{error}"))?;
        rows.push(record.iter().map(str::to_string).collect());
    }
    Ok((headers, rows))
}

fn validate_headers(headers: &[String]) -> Result<(), String> {
    if headers.is_empty() || headers[0] != "id" {
        return Err("CSV 第一列必须精确命名为小写 id。".to_string());
    }
    let mut names = HashSet::new();
    for name in headers {
        if name.trim().is_empty() || !names.insert(name) {
            return Err("CSV 列名不能为空且不能重复。".to_string());
        }
    }
    Ok(())
}

fn ensure_schema_matches_headers(schema: &TableSchema, headers: &[String]) -> Result<(), String> {
    let valid_id = schema
        .columns
        .first()
        .map(|column| {
            column.name == "id"
                && column.column_type == ColumnType::String
                && column.editor_type.is_none()
                && column.link_sheet.is_none()
        })
        .unwrap_or(false);
    if schema.primary_key != "id" || !valid_id {
        return Err("Schema 必须将第一列 id 定义为字符串主键。".to_string());
    }
    let schema_headers = schema
        .columns
        .iter()
        .map(|column| column.name.as_str())
        .collect::<Vec<_>>();
    let csv_headers = headers.iter().map(String::as_str).collect::<Vec<_>>();
    if schema_headers != csv_headers {
        return Err("Schema 列定义与 CSV 表头不一致，请先修复后再打开。".to_string());
    }
    if schema
        .columns
        .iter()
        .any(|column| !has_valid_link_config(column))
    {
        return Err(
            "Schema 的 Link 列必须是 string 类型，并同时配置 editorType 和 linkSheet。".to_string(),
        );
    }
    Ok(())
}

fn validate_document_for_session(
    document: &TableDocument,
    session: &TableSession,
) -> Vec<ValidationIssue> {
    let mut issues = Vec::new();
    let columns = &document.schema.columns;
    let valid_id = columns
        .first()
        .map(|column| {
            column.name == "id"
                && column.column_type == ColumnType::String
                && column.editor_type.is_none()
                && column.link_sheet.is_none()
        })
        .unwrap_or(false);
    if document.schema.primary_key != "id" || !valid_id {
        issues.push(issue(
            None,
            None,
            Some("id"),
            "第一列必须为不可变的字符串主键 id。",
        ));
        return issues;
    }
    let mut column_names = HashSet::new();
    for column in columns {
        if column.name.trim().is_empty() || !column_names.insert(&column.name) {
            issues.push(issue(
                None,
                None,
                Some(&column.name),
                "列名不能为空且不能重复。",
            ));
        }
        if !has_valid_link_config(column) {
            issues.push(issue(
                None,
                None,
                Some(&column.name),
                "Link 必须是 string 类型并配置关联表。",
            ));
        }
    }
    let mut ids = HashSet::new();
    for (row_index, row) in document.rows.iter().enumerate() {
        let row_id = row.first().cloned().unwrap_or_default();
        if row.len() != columns.len() {
            issues.push(issue(
                Some(row_index),
                Some(&row_id),
                None,
                "该行单元格数量与列定义不一致。",
            ));
            continue;
        }
        if row_id.trim().is_empty() {
            issues.push(issue(Some(row_index), None, Some("id"), "id 不能为空。"));
        } else if !ids.insert(row_id.clone()) {
            issues.push(issue(
                Some(row_index),
                Some(&row_id),
                Some("id"),
                "id 必须在当前 CSV 中唯一。",
            ));
        }
        for (column_index, column) in columns.iter().enumerate() {
            let value = &row[column_index];
            if value.trim().is_empty() || column_index == 0 {
                continue;
            }
            let validation_error = match column.column_type {
                ColumnType::String => None,
                ColumnType::Int => value
                    .parse::<i64>()
                    .err()
                    .map(|_| "必须是整数。".to_string()),
                ColumnType::Float => value
                    .parse::<f64>()
                    .err()
                    .map(|_| "必须是小数。".to_string()),
                ColumnType::Bool => (!matches!(value.as_str(), "true" | "false"))
                    .then(|| "必须是 true、false 或留空。".to_string()),
                ColumnType::JsonRef => validate_json_reference(session, value).err(),
                ColumnType::Enum | ColumnType::StringArray => None,
                ColumnType::Vector2Int => validate_vector2int(value).err(),
                ColumnType::StringDictionary => validate_string_dictionary(value).err(),
            };
            if let Some(message) = validation_error {
                issues.push(issue(
                    Some(row_index),
                    Some(&row_id),
                    Some(&column.name),
                    message,
                ));
            }
        }
    }
    issues
}

fn has_valid_link_config(column: &ColumnSchema) -> bool {
    match (&column.editor_type, &column.link_sheet) {
        (None, None) => true,
        (Some(editor_type), Some(sheet)) => {
            editor_type == "link"
                && matches!(
                    column.column_type,
                    ColumnType::String | ColumnType::StringArray
                )
                && !sheet.trim().is_empty()
        }
        _ => false,
    }
}

fn validate_vector2int(value: &str) -> Result<(), String> {
    let parts = value.split(['|', ';']).collect::<Vec<_>>();
    if parts.len() != 2 || parts.iter().any(|part| part.trim().parse::<i32>().is_err()) {
        return Err("必须是两个以 | 分隔的整数，例如 1|4。".to_string());
    }
    Ok(())
}

fn validate_string_dictionary(value: &str) -> Result<(), String> {
    for entry in value.split(['|', ';']) {
        let Some((key, _)) = entry.split_once('=') else {
            return Err("必须是 key=value 格式，并以 | 分隔多个条目。".to_string());
        };
        if key.trim().is_empty() {
            return Err("字典键不能为空。".to_string());
        }
    }
    Ok(())
}

fn validate_json_reference(session: &TableSession, reference: &str) -> Result<(), String> {
    let path = json_path_for_existing_ref(session, reference)?;
    validate_json_file(&path)
}

fn validate_json_file(path: &Path) -> Result<(), String> {
    let content = fs::read(path).map_err(|error| format!("无法读取 JSON 文件：{error}"))?;
    serde_json::from_slice::<serde_json::Value>(&content)
        .map_err(|error| format!("JSON 语法无效：{error}"))?;
    Ok(())
}

fn json_path_for_existing_ref(session: &TableSession, reference: &str) -> Result<PathBuf, String> {
    validate_uuid_v4(reference)?;
    let root = session
        .json_dir
        .canonicalize()
        .map_err(|_| "JSON 引用目录不存在。")?;
    let candidate = root.join(format!("{reference}.json"));
    let canonical = candidate
        .canonicalize()
        .map_err(|_| "关联的 JSON 文件不存在。")?;
    if !canonical.starts_with(&root) {
        return Err("JSON 引用不得指向数据包目录外。".to_string());
    }
    if !canonical.is_file() {
        return Err("JSON 引用必须是普通文件。".to_string());
    }
    Ok(canonical)
}

fn validate_uuid_v4(reference: &str) -> Result<(), String> {
    let uuid = Uuid::parse_str(reference).map_err(|_| "JSON 引用必须是 UUID v4。")?;
    if uuid.hyphenated().to_string() != reference || uuid.get_version_num() != 4 {
        return Err("JSON 引用必须是小写、连字符格式的 UUID v4。".to_string());
    }
    Ok(())
}

fn launch_vscode(file_path: &Path) -> Result<(), String> {
    let mut candidates = Vec::new();
    if let Some(path) = env::var_os("GDE_VSCODE_PATH") {
        candidates.push(PathBuf::from(path));
    }
    if let Some(local_app_data) = env::var_os("LOCALAPPDATA") {
        candidates.push(
            PathBuf::from(local_app_data)
                .join("Programs")
                .join("Microsoft VS Code")
                .join("Code.exe"),
        );
    }
    if let Some(program_files) = env::var_os("ProgramFiles") {
        candidates.push(
            PathBuf::from(program_files)
                .join("Microsoft VS Code")
                .join("Code.exe"),
        );
    }
    if let Some(program_files_x86) = env::var_os("ProgramFiles(x86)") {
        candidates.push(
            PathBuf::from(program_files_x86)
                .join("Microsoft VS Code")
                .join("Code.exe"),
        );
    }

    let mut errors = Vec::new();
    for candidate in candidates
        .into_iter()
        .filter(|candidate| candidate.is_file())
    {
        match Command::new(&candidate)
            .arg("--reuse-window")
            .arg(file_path)
            .spawn()
        {
            Ok(_) => return Ok(()),
            Err(error) => errors.push(format!("{}：{error}", candidate.display())),
        }
    }
    match Command::new("code")
        .arg("--reuse-window")
        .arg(file_path)
        .spawn()
    {
        Ok(_) => Ok(()),
        Err(error) => {
            errors.push(format!("code 命令：{error}"));
            Err(format!(
                "无法启动 VS Code。请安装 VS Code，或设置 GDE_VSCODE_PATH 指向 Code.exe。{}",
                if errors.is_empty() {
                    String::new()
                } else {
                    format!(" 已尝试：{}", errors.join("；"))
                }
            ))
        }
    }
}

fn collect_references(document: &TableDocument) -> HashSet<String> {
    let json_columns = document
        .schema
        .columns
        .iter()
        .enumerate()
        .filter_map(|(index, column)| (column.column_type == ColumnType::JsonRef).then_some(index))
        .collect::<Vec<_>>();
    document
        .rows
        .iter()
        .flat_map(|row| {
            json_columns
                .iter()
                .filter_map(|index| row.get(*index))
                .filter(|value| !value.is_empty())
                .cloned()
        })
        .collect()
}

fn find_orphan_refs(
    document: &TableDocument,
    session: &TableSession,
) -> Result<Vec<String>, String> {
    if !session.json_dir.exists() {
        return Ok(Vec::new());
    }
    let references = collect_references(document);
    let mut orphans = Vec::new();
    for entry in
        fs::read_dir(&session.json_dir).map_err(|error| format!("无法读取 JSON 目录：{error}"))?
    {
        let entry = entry.map_err(|error| format!("无法读取 JSON 文件：{error}"))?;
        if !entry
            .file_type()
            .map_err(|error| format!("无法读取 JSON 文件类型：{error}"))?
            .is_file()
        {
            continue;
        }
        let path = entry.path();
        let is_json = path
            .extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| extension.eq_ignore_ascii_case("json"))
            == Some(true);
        let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else {
            continue;
        };
        if is_json && validate_uuid_v4(stem).is_ok() && !references.contains(stem) {
            orphans.push(stem.to_string());
        }
    }
    orphans.sort();
    Ok(orphans)
}

fn serialize_csv(document: &TableDocument) -> Result<Vec<u8>, String> {
    let mut writer = WriterBuilder::new()
        .has_headers(false)
        .from_writer(Vec::new());
    writer
        .write_record(
            document
                .schema
                .columns
                .iter()
                .map(|column| column.name.as_str()),
        )
        .map_err(|error| format!("无法写入 CSV 表头：{error}"))?;
    for row in &document.rows {
        writer
            .write_record(row)
            .map_err(|error| format!("无法写入 CSV 行：{error}"))?;
    }
    writer
        .into_inner()
        .map_err(|error| format!("无法完成 CSV 写入：{error}"))
}

fn assert_session_has_not_changed(session: &TableSession) -> Result<(), String> {
    if fingerprint(&session.csv_path)? != session.csv_fingerprint
        || fingerprint(&session.schema_path)? != session.schema_fingerprint
    {
        return Err(
            "CSV 或 Schema 已被外部修改。请重新打开文件后再保存，避免覆盖他人修改。".to_string(),
        );
    }
    Ok(())
}

fn fingerprint(path: &Path) -> Result<Option<FileFingerprint>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let metadata = fs::metadata(path).map_err(|error| format!("无法读取文件状态：{error}"))?;
    Ok(Some(FileFingerprint {
        size: metadata.len(),
        modified: metadata.modified().ok(),
    }))
}

fn read_optional(path: &Path) -> Result<Option<Vec<u8>>, String> {
    if !path.exists() {
        return Ok(None);
    }
    fs::read(path)
        .map(Some)
        .map_err(|error| format!("无法读取备份内容：{error}"))
}

fn write_backup_and_replace(path: &Path, content: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("目标文件缺少上级目录。")?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("目标文件名无效。")?;
    let temporary = parent.join(format!(".{file_name}.{}.tmp", Uuid::new_v4()));
    {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| format!("无法创建临时文件：{error}"))?;
        file.write_all(content)
            .map_err(|error| format!("无法写入临时文件：{error}"))?;
        file.sync_all()
            .map_err(|error| format!("无法完成临时文件写入：{error}"))?;
    }
    let backup = parent.join(format!("{file_name}.bak"));
    if path.exists() {
        fs::copy(path, &backup).map_err(|error| format!("无法创建文件备份：{error}"))?;
    }
    match fs::rename(&temporary, path) {
        Ok(()) => Ok(()),
        Err(first_error) => {
            if path.exists() {
                fs::remove_file(path).map_err(|error| format!("无法替换原文件：{error}"))?;
            }
            if let Err(second_error) = fs::rename(&temporary, path) {
                if backup.exists() {
                    let _ = fs::copy(&backup, path);
                }
                return Err(format!(
                    "无法替换原文件：{first_error}; 重试失败：{second_error}"
                ));
            }
            Ok(())
        }
    }
}

fn restore_file(path: &Path, original: Option<&[u8]>) -> Result<(), String> {
    match original {
        Some(content) => write_backup_and_replace(path, content),
        None if path.exists() => {
            fs::remove_file(path).map_err(|error| format!("无法回滚新建 Schema：{error}"))
        }
        None => Ok(()),
    }
}

fn issue(
    row_index: Option<usize>,
    row_id: Option<&str>,
    column: Option<&str>,
    message: impl Into<String>,
) -> ValidationIssue {
    ValidationIssue {
        row_index,
        row_id: row_id.map(str::to_string).filter(|value| !value.is_empty()),
        column: column.map(str::to_string),
        message: message.into(),
    }
}

pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .menu(|app| {
            let new_csv = MenuItemBuilder::with_id("file-new", "新建 CSV").build(app)?;
            let open_csv = MenuItemBuilder::with_id("file-open", "打开 CSV").build(app)?;
            let save = MenuItemBuilder::with_id("file-save", "保存")
                .accelerator("Ctrl+S")
                .build(app)?;
            let export = MenuItemBuilder::with_id("file-export", "导出数据包").build(app)?;
            let file_menu = SubmenuBuilder::new(app, "&File")
                .items(&[&new_csv, &open_csv])
                .separator()
                .items(&[&save, &export])
                .build()?;
            MenuBuilder::new(app).item(&file_menu).build()
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "file-new" | "file-open" | "file-save" | "file-export" => {
                let _ = app.emit("file-menu-action", event.id().as_ref().to_string());
            }
            _ => {}
        })
        .setup(|app| {
            if let Err(error) = initialize_folder_state(&app.handle()) {
                eprintln!("无法初始化目录收藏：{error}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_csv_dialog,
            add_folder_dialog,
            list_folder_tree,
            remove_folder_root,
            open_csv_from_folder,
            list_sibling_sheets,
            open_linked_row,
            create_csv_dialog,
            validate_document,
            save_document,
            create_json_ref,
            clone_json_ref,
            open_json_ref,
            list_orphan_json_refs,
            delete_orphan_json_refs,
            export_table_package,
        ])
        .run(tauri::generate_context!())
        .expect("启动 Game Data Editor 失败");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_directory(label: &str) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("game-data-editor-{label}-{}", Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn uuid_reference_requires_lowercase_v4() {
        let valid = Uuid::new_v4().hyphenated().to_string();
        assert!(validate_uuid_v4(&valid).is_ok());
        assert!(validate_uuid_v4(&valid.to_uppercase()).is_err());
        assert!(validate_uuid_v4("../escape.json").is_err());
    }

    #[test]
    fn link_column_stays_a_string_in_schema() {
        let schema: TableSchema = serde_json::from_str(
            r#"{"version":1,"primaryKey":"id","columns":[{"name":"id","type":"string"},{"name":"ability","type":"string","editorType":"link","linkSheet":"Ability"}]}"#,
        )
        .unwrap();
        assert_eq!(schema.columns[1].column_type, ColumnType::String);
        assert_eq!(schema.columns[1].editor_type.as_deref(), Some("link"));
        assert_eq!(schema.columns[1].link_sheet.as_deref(), Some("Ability"));

        let serialized = serde_json::to_value(schema).unwrap();
        assert_eq!(serialized["columns"][1]["type"], "string");
        assert_eq!(serialized["columns"][1]["editorType"], "link");
        assert_eq!(serialized["columns"][1]["linkSheet"], "Ability");
    }

    #[test]
    fn sibling_sheets_only_include_other_csv_files_in_the_same_folder() {
        let root = test_directory("sibling-sheets");
        fs::write(root.join("Monster.csv"), b"id\n").unwrap();
        fs::write(root.join("Ability.csv"), b"id\n").unwrap();
        fs::write(root.join("notes.txt"), b"").unwrap();
        fs::create_dir(root.join("nested")).unwrap();
        fs::write(root.join("nested").join("Hidden.csv"), b"id\n").unwrap();

        assert_eq!(
            sibling_sheet_names(&root.join("Monster.csv")).unwrap(),
            vec!["Ability".to_string()]
        );
    }

    #[test]
    fn id_is_required_and_unique() {
        let document = TableDocument {
            table_name: "items".to_string(),
            schema_was_missing: false,
            schema: TableSchema {
                version: 1,
                primary_key: "id".to_string(),
                columns: vec![ColumnSchema {
                    name: "id".to_string(),
                    column_type: ColumnType::String,
                    editor_type: None,
                    link_sheet: None,
                }],
            },
            rows: vec![
                vec!["0001".to_string()],
                vec!["0001".to_string()],
                vec![String::new()],
            ],
        };
        let session = TableSession {
            csv_path: PathBuf::new(),
            schema_path: PathBuf::new(),
            json_dir: PathBuf::new(),
            csv_fingerprint: None,
            schema_fingerprint: None,
        };
        assert_eq!(validate_document_for_session(&document, &session).len(), 2);
    }

    #[test]
    fn extended_column_types_validate_their_structured_values() {
        let document = TableDocument {
            table_name: "skills".to_string(),
            schema_was_missing: false,
            schema: TableSchema {
                version: 1,
                primary_key: "id".to_string(),
                columns: vec![
                    ColumnSchema {
                        name: "id".to_string(),
                        column_type: ColumnType::String,
                        editor_type: None,
                        link_sheet: None,
                    },
                    ColumnSchema {
                        name: "group".to_string(),
                        column_type: ColumnType::Enum,
                        editor_type: None,
                        link_sheet: None,
                    },
                    ColumnSchema {
                        name: "tags".to_string(),
                        column_type: ColumnType::StringArray,
                        editor_type: None,
                        link_sheet: None,
                    },
                    ColumnSchema {
                        name: "range".to_string(),
                        column_type: ColumnType::Vector2Int,
                        editor_type: None,
                        link_sheet: None,
                    },
                    ColumnSchema {
                        name: "props".to_string(),
                        column_type: ColumnType::StringDictionary,
                        editor_type: None,
                        link_sheet: None,
                    },
                ],
            },
            rows: vec![
                vec![
                    "skill_01".to_string(),
                    "Common".to_string(),
                    "melee|starter".to_string(),
                    "1|4".to_string(),
                    "damage=3|push=1".to_string(),
                ],
                vec![
                    "skill_02".to_string(),
                    "Rare".to_string(),
                    "".to_string(),
                    "1|bad".to_string(),
                    "=invalid".to_string(),
                ],
            ],
        };
        let session = TableSession {
            csv_path: PathBuf::new(),
            schema_path: PathBuf::new(),
            json_dir: PathBuf::new(),
            csv_fingerprint: None,
            schema_fingerprint: None,
        };

        let issues = validate_document_for_session(&document, &session);
        assert_eq!(issues.len(), 2);
        assert!(issues
            .iter()
            .any(|issue| issue.column.as_deref() == Some("range")));
        assert!(issues
            .iter()
            .any(|issue| issue.column.as_deref() == Some("props")));
    }

    #[test]
    fn creating_a_table_package_directly_overwrites_everything() {
        let root = std::env::temp_dir().join(format!(
            "game-data-editor-overwrite-test-{}",
            Uuid::new_v4()
        ));
        fs::create_dir_all(&root).unwrap();

        let csv_path = root.join("items.csv");
        let schema_path = root.join("items.schema.json");
        let json_dir = root.join("items");
        let old_csv = b"id,name\nold_item,Old Item\n";
        let old_schema = b"{\"legacy\":true}\n";
        let reference = Uuid::new_v4().hyphenated().to_string();
        let json_path = json_dir.join(format!("{reference}.json"));

        fs::write(&csv_path, old_csv).unwrap();
        fs::write(&schema_path, old_schema).unwrap();
        fs::create_dir(&json_dir).unwrap();
        fs::write(&json_path, b"{}\n").unwrap();

        let (document, session) = create_table_package(csv_path.clone()).unwrap();
        let (headers, rows) = read_csv(&csv_path).unwrap();
        let schema: TableSchema = serde_json::from_slice(&fs::read(&schema_path).unwrap()).unwrap();

        assert_eq!(document.table_name, "items");
        assert!(document.rows.is_empty());
        assert_eq!(headers, vec!["id"]);
        assert!(rows.is_empty());
        assert_eq!(schema.columns.len(), 1);
        assert_eq!(schema.columns[0].name, "id");
        assert_eq!(schema.columns[0].column_type, ColumnType::String);
        assert_eq!(session.json_dir, json_dir);
        assert!(session.json_dir.is_dir());
        assert!(!json_path.exists());
        assert!(fs::read_dir(&session.json_dir).unwrap().next().is_none());
        assert!(!root.join("items.csv.bak").exists());
        assert!(!root.join("items.schema.json.bak").exists());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn folder_tree_recurses_filters_csv_and_sorts_directories_first() {
        let root = test_directory("folder-tree");
        let data_dir = root.join("Data");
        let nested_dir = data_dir.join("Nested");
        let z_dir = root.join("z-last");
        fs::create_dir_all(&nested_dir).unwrap();
        fs::create_dir_all(&z_dir).unwrap();
        fs::write(root.join("beta.CSV"), b"id\n").unwrap();
        fs::write(root.join("Alpha.csv"), b"id\n").unwrap();
        fs::write(root.join("notes.txt"), b"ignored").unwrap();
        fs::write(nested_dir.join("Hero.CsV"), b"id\n").unwrap();
        fs::write(nested_dir.join("Hero.schema.json"), b"{}").unwrap();

        let canonical_root = root.canonicalize().unwrap();
        let roots = vec![FolderRootRecord {
            path: canonical_root,
        }];
        let tree = build_folder_tree(&roots, &HashMap::new());

        assert_eq!(tree.len(), 1);
        assert!(tree[0].available);
        let names = tree[0]
            .children
            .iter()
            .map(|entry| entry.name.as_str())
            .collect::<Vec<_>>();
        assert_eq!(names, vec!["Data", "Alpha.csv", "beta.CSV"]);
        assert!(!names.contains(&"z-last"));

        let data = &tree[0].children[0];
        assert!(matches!(data.kind, FolderEntryKind::Folder));
        let nested = data
            .children
            .iter()
            .find(|entry| entry.name == "Nested")
            .unwrap();
        assert_eq!(nested.children.len(), 1);
        assert_eq!(nested.children[0].name, "Hero.CsV");
        assert!(matches!(nested.children[0].kind, FolderEntryKind::Csv));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn folder_config_deduplicates_and_keeps_missing_roots() {
        let root = test_directory("folder-config");
        let existing = root.join("existing");
        let missing = root.join("missing");
        fs::create_dir_all(&existing).unwrap();
        let canonical_existing = existing.canonicalize().unwrap();
        let config_path = root.join("state").join(FOLDER_ROOTS_CONFIG_FILE);
        let records = vec![
            FolderRootRecord {
                path: canonical_existing.clone(),
            },
            FolderRootRecord {
                path: canonical_existing.clone(),
            },
            FolderRootRecord {
                path: missing.clone(),
            },
        ];

        save_folder_roots_to_path(&config_path, &records).unwrap();
        let loaded = load_folder_roots_from_path(&config_path).unwrap();
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].path, canonical_existing);
        assert_eq!(loaded[1].path, missing);

        let tree = build_folder_tree(&loaded, &HashMap::new());
        assert!(tree[0].available);
        assert!(!tree[1].available);
        assert!(tree[1].error.is_some());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn removing_folder_record_never_deletes_disk_content() {
        let root = test_directory("folder-remove");
        let csv_path = root.join("items.csv");
        fs::write(&csv_path, b"id\n").unwrap();
        let canonical_root = root.canonicalize().unwrap();
        let mut records = vec![FolderRootRecord {
            path: canonical_root.clone(),
        }];

        remove_folder_root_record(&mut records, &canonical_root).unwrap();

        assert!(records.is_empty());
        assert!(root.is_dir());
        assert!(csv_path.is_file());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn csv_path_must_be_a_regular_file_inside_a_managed_root() {
        let base = test_directory("folder-path-boundary");
        let managed = base.join("managed");
        fs::create_dir_all(&managed).unwrap();
        let inside = managed.join("inside.CSV");
        let outside = base.join("outside.csv");
        fs::write(&inside, b"id\n").unwrap();
        fs::write(&outside, b"id\n").unwrap();
        let roots = vec![FolderRootRecord {
            path: managed.canonicalize().unwrap(),
        }];

        assert_eq!(
            validate_csv_path_in_roots(&inside, &roots).unwrap(),
            inside.canonicalize().unwrap()
        );
        assert!(validate_csv_path_in_roots(&outside, &roots).is_err());
        assert!(validate_csv_path_in_roots(&managed, &roots).is_err());

        fs::remove_dir_all(base).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn recursive_watcher_reports_nested_file_changes() {
        let root = test_directory("folder-watch");
        let (sender, receiver) = std::sync::mpsc::channel();
        let mut watcher = new_debouncer(
            Duration::from_millis(100),
            move |result: DebounceEventResult| {
                let _ = sender.send(result);
            },
        )
        .unwrap();
        watcher
            .watcher()
            .watch(&root, RecursiveMode::Recursive)
            .unwrap();

        let nested = root.join("nested");
        fs::create_dir_all(&nested).unwrap();
        fs::write(nested.join("new.csv"), b"id\n").unwrap();

        let event = receiver
            .recv_timeout(Duration::from_secs(5))
            .expect("directory watcher did not report a nested change");
        assert!(event.is_ok());

        drop(watcher);
        fs::remove_dir_all(root).unwrap();
    }
}
