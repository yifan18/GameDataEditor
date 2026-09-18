# Game Data Editor

一个 Windows 桌面工具，用于编辑由 CSV、Schema 与外部 JSON 引用组成的游戏数据包。

## 数据包约定

```text
items.csv
items.schema.json
items/
  <uuid-v4>.json
```

- CSV 首列固定为小写 `id`，按字符串保存，不能为空且全表唯一。
- `items.schema.json` 保存列顺序及类型：`string`、`int`、`float`、`bool`、`json_ref`、`enum`、`string_array`、`vector2int`、`string_dictionary`。
- `json_ref` 单元格只存小写 UUID v4；文件路径由编辑器推导为 `items/<uuid>.json`。
- 首次打开没有 Schema 的合法 CSV 时，除 `id` 外的列按 `string` 加载；首次保存自动创建 Schema。

## 使用

```powershell
npm install
npm run tauri dev
```

可直接点击“新建 CSV”创建空数据包：工具会创建 CSV、同名 Schema 和同名 JSON 目录。打开或新建后可编辑行、列和列类型。`json_ref` 单元格支持创建 JSON 文件，并通过本机 `code` 命令在 VS Code 中打开。复制行会深复制 JSON 文件并生成新 UUID。

“导出数据包”会导出 CSV、Schema 与全部被引用 JSON；“清理未引用 JSON”只会删除同名目录中 UUID 格式的孤儿文件。

## 文件夹导航

左侧 **Folders** 侧栏可添加多个本地目录，并递归显示其中的 `.csv` 文件；点击文件即可在当前单文档编辑器中打开。切换文件前如有未保存修改，会先要求确认。

- 已添加目录保存在 `%LOCALAPPDATA%\com.dongyun.game-data-editor\folder-roots.json`，重启应用后仍会显示。
- 目录中的 CSV 新增、重命名或删除后会自动刷新列表；侧栏也提供手动刷新按钮。自动刷新不会重载当前正在编辑的文件。
- 移除目录只会取消侧栏收藏，**不会删除磁盘上的目录或文件**。失效或无权限的目录会保留在列表中并标记为不可用，方便之后恢复访问。

## Unity 读取

将整个数据包置于 Unity 的 `Resources` 目录，例如 `Resources/Sheet/Hero.csv`、`Resources/Sheet/Hero.schema.json` 与 `Resources/Sheet/Hero/<uuid>.json`。新增的 `CsvPackageParser` 会读取 Schema，而不是旧 CSV 的第二行类型声明：

```csharp
var heroes = CsvPackageParser.LoadList<HeroEntity>("Sheet/Hero");
```

`json_ref` 会根据字段类型立即用 Newtonsoft.Json 反序列化对应的 UUID JSON 文件。旧的 `CsvParser` 和旧格式 CSV 不受影响。

## 验证

```powershell
npm run build
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
cargo check --manifest-path src-tauri\Cargo.toml
cargo test --manifest-path src-tauri\Cargo.toml
```

## 构建
```powershell
npm run tauri build
```