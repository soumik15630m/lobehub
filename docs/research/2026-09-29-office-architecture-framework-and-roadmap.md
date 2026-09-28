# LobeHub Office 能力架构框架与分阶段路线图（架构设计文档）

> - **任务**：T-571「设计 LobeHub office 能力的架构框架与分阶段路线图」
> - **所属 Goal**：AI Office 能力：市场全景调研、可行性分析与架构路线图（本阶段只做调研与设计，**不进入产品实现**）
> - **日期**：2026-09-29
> - **分支**：`research/ai-office-agent`，本文件位于 `docs/research/`
> - **输入**（同分支 `docs/research/` 下四份报告，选型结论直接沿用）：
>   1. 《主流商业 AI 办公产品 Office（PPT/Excel/Word）实现思路调研报告》（T-565，下称**商业调研**）
>   2. 《开源 Office 引擎与 AI 办公开源方案调研报告》（T-566，下称**开源调研**）
>   3. 《LobeHub 现有实现与 Office（PPT/Excel/Word）能力的复用点与缺口分析》（T-567，下称**现状分析**）
>   4. 《LobeHub Office 能力技术路线可行性分析报告》（T-570，下称**可行性分析**；本文档的选型基准）
> - **性质**：纯架构设计文档，不含任何产品实现代码。所有模块落点均给到仓库路径与导出名，所有里程碑给到可逐项核对的验收形态。

---

## 0. 摘要（TL;DR）

1. **总体方案是五层组合架构**：文档模型层（自有模型复用 `@lobehub/editor`/liteXML，Office 结构化操作模型新建 `packages/office-operations`）→ 编辑渲染层（M1/M2 复用 FileViewer 预览 +「对话即编辑器」，M3 新建 Univer 编辑面）→ AI agent 工具层（复用 builtin tool 五面孔框架，新建 `packages/builtin-tool-office`）→ 产物与存储层（全部复用：files 表、`exportFile`→`/f/:id`、fileEditScan→Work 合成；仅新增文件版本链约定）→ 预览与导出层（全部复用：docx-preview / `@aiden0z/pptx-renderer` / exceljs 三件套预览）。
2. **技术选型与可行性分析完全一致**：主路线 R1（代码生成 OOXML）为生成底座 + R2（结构化中间层单向导出）为体验层，R4（Univer SDK 嵌入）为 M3 编辑面，R5（独立服务）按需挂载，**R3 自研版式编辑器 12 个月内不立项，R6 模板填充降级为 R1 管线的模板约束技巧**；不迁移 Lexical → Tiptap，不将任何 AGPL 代码并入主仓库。
3. **AI 交互体验框架 = 四种模式 × （组件设计 + 协议设计）**：对话内卡片（Render/Inspector/Portal 三表面）、预览-确认（humanIntervention + 结构化 diff）、追问编辑（声明式 OfficeEditOperation 寻址）、多轮迭代（文件版本链 + 渲染自检闭环）。
4. **路线图 M1→M2→M3** 对应可行性分析的 P0→P1→P2：M1 生成底座（0–1 月）、M2 体验层（1–3 月）、M3 编辑面（3–9 月）；每阶段含范围、依赖、验收形态与 Go/No-Go 检查点。
5. **旧实现处置（e 项）**：任务书所称「feat/ai-office-agent 分支 `packages/builtin-tool-office`」经核查**不存在于本地与远端**；上一 Goal 的真实半成品是 **`feat/t-324-office-capability-baseline` 分支**（8 个 commit，客户端内编辑器）。处置结论：**文档/夹具/测试方法/`fileType.ts` 检测/`xlsxOperations.ts` 操作联合类型设计 留作参考**；**三个编辑器 UI、IndexedDB 草稿存储、重复公式引擎、committed 证据二进制 全部废弃**。逐项清单见 §6。

---

## 1. 设计输入、约束与名词

### 1.1 选型基准：可行性分析（T-570）的最终结论

本文档的全部技术选型以可行性分析 §6.1/§6.3 为基准，原句摘录如下（出处：`2026-09-29-office-technical-route-feasibility.md`）：

> **主路线：R1 + R2（生成层与中间层组合）为底座，R4 为中期编辑面，R5 为按需增值；明确不做 R3（12 个月内），R6 降级为 R1 管线的模板约束技巧。**
> 用一句话概括：**「先做能生成真实 OOXML 的 agent 底座（R1），再把自有文档体验接到 OOXML 上（R2 单向），表格/文档件的界面内编辑用 Univer 补齐（R4），『真 Office』全功能与现成 AI PPT 以服务形态按需挂载（R5），自研编辑器（R3）只在 R4/R5 证伪后启动。」**

以及其 Do/Don't 清单（§6.3 原句）：

> - **Do**：P0 启动 R1；同步进行 G9 沙箱网络验证与 Univer Pro 采购评估两个 PoC；把开源调研 §4.3 的四条 License 红线写入工程规范。
> - **Don't**：12 个月内不立项 R3；不将任何 AGPL 代码并入主仓库；不迁移 Lexical → Tiptap/Plate/Slate；不引入 Luckysheet/impress.js/Handsontable；R6 不独立立项。

里程碑对应关系：本文档 **M1 ≈ 可行性分析 P0**、**M2 ≈ P1**、**M3 ≈ P2**；P3（R2 双向保真编辑 / R3 重评估）是 M3 之后的观察项，不在本路线图承诺范围内（见 §5.4）。

### 1.2 硬约束（来自现状分析与仓库事实）

| # | 约束 | 来源 |
|---|---|---|
| C1 | 后端业务逻辑一律在 `apps/server/src`（经 `@/server/*` 引用）；`src/app/(backend)` 只放路由壳 | AGENTS.md 代码归属 |
| C2 | 共享代码放 `packages/`；业务 UI 放 `src/features/`；`src/routes` 只做薄页面段 | AGENTS.md 代码归属 |
| C3 | builtin tool 五面孔结构：manifest/types/systemRole / ExecutionRuntime / client executor / client UI（Inspector 必需）+ 中央注册 | 现状分析 §5.3 |
| C4 | OnlyOffice（AGPL-3.0）、PPTist/TabTin/banana-slides（AGPL）、Handsontable（非商业许可）严禁代码并入主仓库，只能独立服务 | 可行性分析 §0.4 |
| C5 | Univer 核心 Apache-2.0 可代码级引入；xlsx 高保真导入导出与实时协同在 Univer Pro 商业层 | 可行性分析 §3 R4 |
| C6 | 生成三件套 PptxGenJS 4.0.1 / docx 9.8.1 / exceljs 4.4.0 全 MIT；exceljs 实质停摆需锁版或 `@protobi/exceljs` 分叉 | 可行性分析 §3 R1 |
| C7 | `PluginApiWorkResourceType` 当前仅 `'document' \| 'task'`；office 实体 Work 由服务端 fileEditScan + `registerWorksForOperation` 合成，不经 manifest `work` 声明 | 代码核实（见 §3.4） |
| C8 | `ArtifactType` 枚举仅 Code/React/Python/HTML，无 office 类型 | 代码核实（§3.4） |
| C9 | identifier（`lobe-<domain>`）永久存于消息历史，新增需谨慎、一经发布不可改名 | 现状分析 §5.1 |

### 1.3 名词表

| 名词 | 含义 |
|---|---|
| OOXML | Office Open XML（docx/xlsx/pptx 的 zip+XML 格式族） |
| liteXML | `@lobehub/editor` 的带节点 id XML 程序化编辑协议（寻址/命令/人审 diff） |
| Work | 平台「产物」实体（manifest `work` 声明或 fileEditScan 合成注册） |
| 渲染自检闭环 | 生成 → headless 渲染（soffice/预览器）→ 截图 → 多模态看图查错 → 重试 |
| 五面孔 | builtin tool 的 manifest / ExecutionRuntime / client executor / client UI / 注册接线 |
| OfficeEditOperation | 本文档定义的按格式声明式编辑操作联合类型（§4.4） |

---

## 2. 总体架构（任务书 a 项）：五层架构

### 2.1 架构图（ASCII 描述）

```
┌─────────────────────────────── 展现层（src/features） ───────────────────────────────┐
│  对话内 OfficeCard（Render）│ Inspector（调用摘要）│ Portal（全屏预览/播放）│ 预览-确认浮层  │
├─────────────────────────────── L5 预览与导出层 ──────────────────────────────────────┤
│  【复用】FileViewer 三件套：DocxPane(docx-preview)/PptxPane(@aiden0z/pptx-renderer)/  │
│          XlsxPane(exceljs 自研模型) + OfficeOnlinePane 降级链 + MSDoc 20MB/500行上限   │
│  【复用】exportFile 下载链路、【新建】documents→OOXML 导出菜单（M2）、播放/放映（M3+）    │
├─────────────────────────────── L4 产物与存储层 ──────────────────────────────────────┤
│  【复用】files/globalFiles 表(S3+sha256 去重)、exportFile→/f/:id、fileEditScan→        │
│          registerWorksForOperation 合成 slides/sheet/doc Work、manifest work 声明      │
│  【新建】office 文件版本链约定（derivedFrom 元数据，M2 落地）、产物卡片元数据             │
├─────────────────────────────── L3 AI agent 工具层 ───────────────────────────────────┤
│  【复用】builtin tool 五面孔框架、agent-runtime step/ToolTransport、humanIntervention/ │
│          dynamicInterventionAudits 审批、mecha manifestPool 生成 schema                │
│  【新建】packages/builtin-tool-office：create / inspect / edit / export 四 api +         │
│          systemRole + serverRuntime + Inspector/Render/Portal 表面                     │
│  【新建】渲染自检闭环（ExecutionRuntime 内部步骤：生成→渲染→看图→重试）                  │
├─────────────────────────────── L2 编辑渲染层 ────────────────────────────────────────┤
│  M1/M2【复用】EditorCanvas/Portal Document（自有文档人在环编辑）、FileViewer 预览作为      │
│            office「确认面」——对话即编辑器                                              │
│  M3【新建】src/features/OfficeEditor/（Univer 外壳，表格/文档件界面内编辑）+              │
│          packages/office-univer 适配层；【新建】块锚定保真编辑渲染（复用 LexicalDiff）   │
├─────────────────────────────── L1 文档模型层 ────────────────────────────────────────┤
│  【复用】@lobehub/editor（Lexical+liteXML，json/markdown/litexml）+ documents 表        │
│          （content markdown + editorData jsonb）+ editor-runtime 计划-校验-执行-回读    │
│  【新建】packages/office-operations：OfficeEditOperation 联合类型 + 每格式 Provider     │
│          （xlsx=ExcelJS 对象模型；pptx/docx=PptxGenJS/docx 声明式对象树，Node-safe）     │
│  M2【新建】litexml→OOXML 映射规范（对照 genoffice ops 协议）；M3【新建】Univer snapshot 适配│
└──────────────────────────────────────────────────────────────────────────────────────┘
        ▲ 调用                         ▲ 执行/回读
┌───────┴────────────────┐   ┌─────────┴──────────────────────────────────────┐
│ 执行环境【复用】         │   │ 外部服务（按需）                                  │
│ lobe-cloud-sandbox      │   │ R5a OnlyOffice/Collabora（云端可选 iframe 模块）   │
│ （13 API：python/js/ts+  │   │ R5b presenton worker（AI PPT 过渡，Apache-2.0）    │
│  shell+文件+exportFile） │   │ R4 Univer（@univerjs/* presets，Apache-2.0 核心）  │
│ device-sandbox（本地）   │   │ R5c genoffice CLI（块锚定协议范本，独立 worker）    │
└─────────────────────────┘   └──────────────────────────────────────────────────┘
```

数据主流向（M1 起）：用户指令 → GeneralChatAgent 决策 → `lobe-office` 工具调用（或 `lobe-cloud-sandbox.executeCode` 自由代码路径）→ 沙箱/服务端生成 OOXML → `exportFile` → `/f/:id` 平台文件 → fileEditScan 识别 → Work 合成 → 消息卡片（Render）→ FileViewer 预览（Portal）→ 渲染自检闭环回读 → 需要修改时进入 `edit` api（预览-确认）→ 新版本文件。

### 2.2 L1 文档模型层：自有模型复用，Office 操作模型新建

**【复用】LobeHub 自有文档模型**——`@lobehub/editor`（Lexical 0.42，安装 4.27.3）+ liteXML 协议 + `packages/editor-runtime` 的 plan→validate→execute→readback 闭环 + `documents` 表（`content` markdown 文本 + `editorData` jsonb）。这套是 R2 中间层的直接载体：liteXML 的寻址/命令/人审 diff 三件套已量产于 `lobe-page-agent`，M2 的「自有文档 → OOXML 导出」与「追问编辑」都建立在它之上。**不迁移到 Tiptap/Plate/Slate**（可行性分析 §6.3 Don't）。

**【新建】`packages/office-operations`——Office 结构化操作模型**。原因（现状分析缺口 G1/G2/G10/G11）：仓库内没有任何能表达或变换 Office 语义的层。内容：

| 模块 | 路径 | 职责 |
|---|---|---|
| 操作类型 | `packages/office-operations/src/types.ts` | `OfficeEditOperation` 联合类型：`XlsxEditOperation`（sheet/range/cell 寻址）∪ `PptxEditOperation`（slideIndex/nodeId 寻址）∪ `DocxEditOperation`（块 index 寻址）；统一包一层 `{ format: 'xlsx'\|'pptx'\|'docx', targetFileId }` |
| xlsx Provider | `packages/office-operations/src/xlsx.ts` | 基于 **ExcelJS**（唯一有真实对象模型的格式）：`loadXlsx(bytes)` / `editXlsx(bytes, op[])` / `exportXlsx(workbook)`；公式策略 = `fullCalcOnLoad` + 显式声明不支持公式引擎（见 §7 风险 F3） |
| pptx Provider | `packages/office-operations/src/pptx.ts` | 基于 **PptxGenJS 4.0.1** 的声明式对象树做「生成/整页替换」；幻灯片内元素级修改（R2 双向阶段）按 genoffice 块锚定范式新建，t-324 手写 XML 仅作案头参考（§6） |
| docx Provider | `packages/office-operations/src/docx.ts` | 基于 **docx 9.8.1** 声明式对象树；M2 做块级 replace/insert，M3+ 评估块锚定双向 |
| 服务端校验 | `packages/office-operations/src/verify.ts` | reopen 校验（zip CRC、部件完整性、sentinel 文本回读），测试方法继承 t-324（§6.2-K6） |

关键设计约束：Provider 必须 **Node-safe（禁止浏览器 DOMParser）**——t-324 的 `docxOperations.ts`/`pptxOperations.ts` 依赖 `DOMParser`/`outerHTML`，无法在沙箱/服务端运行，这是其不能直接搬迁的技术原因（§6.3-D2）。XML 处理改用 Node 兼容库。

**M2 追加【新建】liteXML→OOXML 映射规范**：放在 `packages/office-operations/src/mapping/`（litexml 块 ↔ OOXML 结构的映射表 + 版式语义的降级规则文档），规范本体是 Markdown + 可执行测试对照表，对照 genoffice `docs read --range` / `docs apply --ops` 协议设计（可行性分析 §3 R2：两协议「高度同构」）。

### 2.3 L2 编辑渲染层：M1/M2「对话即编辑器」，M3 新建 Univer 面

- **M1/M2【复用】**：office 文件的「编辑」不造专用编辑器 UI，而是「agent 改 + 人审预览确认」——FileViewer 三件套预览（`src/features/FileViewer/Renderer/Document/`）就是确认面；自有文档的人编辑继续走 `EditorCanvas` + Portal Document（复用保存链路 `src/services/document` → tRPC `document:update`）。
- **M3【新建】`src/features/OfficeEditor/`**：Univer 的 React 外壳（preset 自组装 UI），按 `@lobehub/editor` 的受控模式接线；**【新建】`packages/office-univer`**：headless 工具封装 + 文件导入导出适配层（可行性分析 §3 R4 生产化内容：8–12 人周）。按 surface 代码分割（MB 级包体，性能风险 2）。
- **M3【新建】块锚定保真编辑渲染**：`LexicalDiff`（`@lobehub/editor` 导出，行/单元格级结构化 diff）渲染「预览-确认」中的结构化 diff 视图。

边界：编辑渲染层的所有可执行逻辑（解析/序列化/校验）都在 `packages/` 或 `apps/server/src`，`src/features/` 只留薄壳（C1/C2）。

### 2.4 L3 AI agent 工具层：框架全复用，工具新建

**【复用】builtin tool 五面孔框架的全部骨架**（现状分析 §5.4 已核实「8 个增量层全部纯增量」）：manifest 类型 `BuiltinToolManifest`（`packages/types/src/tool/builtin.ts`）、schema 生成 `assembleManifestPool()`（`packages/mecha/src/toolSet/manifestPool.ts`）、执行 `AgentRuntime.step()`（`packages/agent-runtime/src/core/runtime.ts`）、服务端 `ServerToolTransport` → `BuiltinToolsExecutor` → `getServerRuntime(identifier, ctx)`（43+ runtime 的 Map 注册范式）、前端 `invokeExecutor`（Map 注册表 + `stashBuiltinToolWorkIntent`）、审批 `InterventionChecker` + `dynamicInterventionAudits.ts`、表面注册 `registerBuiltinToolSurfaces()`（renders/inspectors/streamings/placeholders/interventions/portals）。

**【新建】`packages/builtin-tool-office`**（identifier `lobe-office`，C9：一经发布不可改名）：

| apiName | 参数要点 | humanIntervention | work 声明 | 里程碑 |
|---|---|---|---|---|
| `create` | `{ format, spec, templateId?, selfCheck?: boolean }` | 执行代码时复用沙箱既有审批 | 否（产物经 fileEditScan 合成 Work，C7） | **M1** |
| `inspect` | `{ fileId, format }` → 结构化大纲（slides/sheets/blocks 带寻址 id） | 无 | 无 | **M1** |
| `edit` | `{ fileId, format, operations: OfficeEditOperation[] }` → 新版本文件 | **required**（改既有文件） | 否 | **M2** |
| `export` | `{ documentId \| litexml, format, options }` → OOXML 文件 | 无 | `work: { action: 'create', resourceType: 'document' }` | **M2** |

- `create` 两条执行路径：①**结构化生成**（主）：spec → 服务端 Node 生成库（PptxGenJS/docx/exceljs）执行，确定性强；②**自由代码**（逃生舱）：引导模型写 python/js 经 `lobe-cloud-sandbox.executeCode` 执行（现状已可用，fileEditScan 已识别 `.save()`/`to_excel()`/`pptxgenjs writeFile` 模式）。systemRole 教模型何时走哪条。
- **【新建】渲染自检闭环**：`create` 的 `selfCheck: true` 时，ExecutionRuntime 内部追加：生成 → 沙箱内 `soffice --convert-to pdf`（或预览器渲染）→ 截图 → 多模态看图 → 失败自动重试 N 次。依赖 U1/G9 沙箱网络验证结论；不可用时降级为「生成后直接把文件给多模态模型读结构」的弱自检（可行性分析 §3 R1 风险缓解）。
- 注册接线清单（M1 全部要动的层，均按现状分析 §5.4）：`packages/builtin-tools/src/index.ts`（registry + `defaultToolIds` 等 5 个清单，默认关闭、按话题开启）与 `identifiers.ts`、`apps/server/src/services/toolExecution/serverRuntimes/office.ts` + index 注册、`src/store/tool/slices/builtin/executors/catalog.ts` 前端接线、`packages/builtin-tools/src/register.ts` 表面注册、`packages/locales/src/default/plugin.ts` 的 `builtins.lobe-office.apiName.*` + en-US/zh-CN 手写、`dynamicInterventionAudits.ts` 可选 resolver。

### 2.5 L4 产物与存储层：近乎全复用，仅新增版本链约定

- **【复用】** `files`/`globalFiles` 表（S3 + sha256 去重，`packages/database/src/schemas/file.ts`）；`exportFile` → `SandboxMiddlewareService.exportAndUploadFile` → `fileService.createFileRecord` → `/f/:id`（`getFileProxyUrl`）完整链路；**fileEditScan → `registerWorksForOperation` 合成 slides/sheet/doc 实体 Work**（`ENTITY_EXTENSIONS`：`ppt/pptx→slides、xls/xlsx→sheet、doc/docx→doc`，已核实）——M1 不新增任何 Work 类型即可获得「产物入 Work」能力（C7 的约束被现有合成路径绕过）。
- **【新建】文件版本链（M2 落地）**：约定而非大改——`files.metadata` jsonb 增加 `derivedFrom: fileId`、`versionKind: 'edit'|'export'|'selfcheck-retry'`；Work 侧沿用合成路径的 entity 归并。理由：编辑必须产生可回滚的新版本（t-324 的教训：IndexedDB 草稿无版本、无回滚，见 §6.3）；不动 `documents` 表承载 Office 语义（现状分析 G4：承载不了，也不要求它承载——Office 语义活在 OOXML 文件与 office-operations 层）。
- **ArtifactType 枚举不扩展**（C8 保持）：office 产物走「文件 + Work + 卡片」而非 artifact 通道；html-artifact 的打包/发布范式（`gatherWorkspaceHtmlArtifact`/`publishWorkspaceHtmlArtifact`，50MB/64 文件限制）仅作参考，不复用其代码。

### 2.6 L5 预览与导出层：全复用 + 两处薄新建

- **【复用】** `src/features/FileViewer` 全链：`MSDocViewer`（20MB blob 上限）→ `Renderer/Document/` 的 `DocxPane`（docx-preview）/`PptxPane`（`@aiden0z/pptx-renderer`，缩略图/缩放/文本搜索）/`XlsxPane`（exceljs 自研模型，500 行截断）+ `OfficeOnlinePane` 公网降级。xlsx 500 行与 20MB 上限在 M1 保留（现状分析 G7 是有意接受的边界，M3 再按 Univer 编辑面一并解决）。
- **【新建·薄】** 消息内预览卡片与 Portal 接线：`packages/builtin-tool-office/src/client/Render/OfficeFileCard/` + `Portal/OfficePreviewPortal/`（复用 `MSDocViewer` 渲染，薄封装）；M2 新建 documents 的「导出为 Word/PPT/Excel」菜单入口（`src/features/Portal/Document/` 头部动作，调用 `export` api 后走 FileViewer 下载）。

---

## 3. 模块划分与边界（任务书 b 项）

### 3.1 模块 → 仓库落点总表

| # | 模块 | 落点（新建=✦） | 层 | 新建/复用 | 职责一句话 | 主要依赖方向 |
|---|---|---|---|---|---|---|
| M-01 | office 工具包 | ✦ `packages/builtin-tool-office/` | L3 | 新建 | `lobe-office` 四 api + systemRole + 表面 | → M-02、M-03、`@lobechat/types` |
| M-02 | Office 操作模型 | ✦ `packages/office-operations/` | L1 | 新建 | 声明式 OfficeEditOperation + 每格式 Provider + 校验 | → exceljs/docx/PptxGenJS；不依赖任何 src/ |
| M-03 | 服务端 runtime | ✦ `apps/server/src/services/toolExecution/serverRuntimes/office.ts` | L3 | 新建 | create/inspect/edit/export 的服务端执行 + 自检闭环编排 | → M-02、cloud-sandbox service、fileService |
| M-04 | 渲染自检 | ✦ `apps/server/src/services/officeSelfCheck/` | L3 | 新建 | soffice 渲染→截图→多模态查错→重试 | → sandboxService、agent 多模态调用 |
| M-05 | 工具注册接线 | `packages/builtin-tools/src/{index,identifiers,register}.ts` | L3 | 修改 | registry + 5 个工具清单 + 7 类表面映射 | → M-01 |
| M-06 | 前端 executor | `src/store/tool/slices/builtin/executors/catalog.ts` | L3 | 修改 | OfficeExecutor 注册进 Map | → M-01 client executor |
| M-07 | 消息卡片 | ✦ `packages/builtin-tool-office/src/client/{Render,Inspector,Portal}/` | L5 | 新建 | OfficeFileCard / 调用摘要 Inspector / 全屏预览 Portal | → FileViewer Renderer（只读引用） |
| M-08 | FileViewer 接线 | `src/features/FileViewer/index.tsx` | L5 | 修改 | 卡片点击 → Portal 预览路由（改动 <20 行） | → M-07 Portal |
| M-09 | liteXML→OOXML 映射 | ✦ `packages/office-operations/src/mapping/` | L1 | 新建（M2） | litexml 块 ↔ OOXML 映射规范 + 对照测试 | → M-02、`@lobehub/editor` headless |
| M-10 | 导出菜单 | ✦ `src/features/Portal/Document/ExportOfficeMenu/` | L5 | 新建（M2） | documents → docx/pptx/xlsx 导出入口 | → M-01 export api |
| M-11 | 版本链 | `files.metadata` 约定 + ✦ `packages/database/src/models/file.ts` 派生查询 | L4 | 新建（M2） | derivedFrom 元数据 + 版本列表查询 | → files 表 |
| M-12 | Univer 编辑面 | ✦ `packages/office-univer/` + ✦ `src/features/OfficeEditor/` | L2 | 新建（M3） | preset 封装 + 导入导出适配 + React 外壳 | → `@univerjs/*`、M-02 |
| M-13 | 套件 iframe 模块 | ✦ `apps/server/src/modules/officeSuite/` + docker profile | L2/L5 | 新建（M3，云端可选） | OnlyOffice/Collabora 接入与 URL 签发 | → 独立服务（AGPL 边界 C4） |
| M-14 | i18n | `packages/locales/src/default/plugin.ts` + `locales/{en-US,zh-CN}` | L3/L5 | 修改 | `builtins.lobe-office.*` 手写双语 | — |
| M-15 | 审批 resolver | `apps/server/src/services/toolExecution/dynamicInterventionAudits.ts` | L3 | 修改（可选） | edit api 的文件改写审批策略 | → M-01 manifest |

### 3.2 边界与依赖规则（谁调用谁、接口在何处）

1. **依赖方向只允许向下**：`src/features/* → packages/* → apps/server/src/*`；`packages/*` 之间允许平级依赖（M-01 → M-02），**严禁 `packages/*` 依赖 `src/features/*`**（t-324 的 `src/features/FileViewer/Renderer/*/​*Operations.ts` 正是犯此条：引擎在 client bundle 里，服务端工具永远调不到——§6.3-D1）。
2. **接口定义集中在两处**：工具协议接口（manifest/types/systemRole）在 `packages/builtin-tool-office/src/{types,manifest,systemRole}.ts`（无 React，纯逻辑）；Office 操作与 Provider 接口在 `packages/office-operations/src/types.ts`。前端/服务端都从这里取类型。
3. **服务端唯一入口**：`apps/server/src/services/toolExecution/serverRuntimes/office.ts` 实现 serverRuntime 工厂（`{ identifier: 'lobe-office', factory }` 注册进 `serverRuntimeFactories` Map），执行时调用 M-02 Provider 与 M-04 自检；`src/app/(backend)` 不加业务逻辑（C1）。
4. **预览复用边界**：M-07 的 Portal 只引用 `src/features/FileViewer/Renderer/Document/` 的只读组件，不复制渲染逻辑；FileViewer 本身不被 office 工具依赖（单向：卡片 → FileViewer）。
5. **License 边界（C4）**：M-13 的 OnlyOffice/Collabora 只以独立服务形态存在（docker-compose profile + iframe），其代码永不进入主仓库依赖树；M-12 只引入 Apache-2.0 的 `@univerjs/*` 核心包，Pro 层能力采购决策见 §5.3-M3 Go/No-Go。

### 3.3 关键接口草样（设计级，非实现）

```ts
// packages/office-operations/src/types.ts（设计草样）
export type OfficeFormat = 'docx' | 'xlsx' | 'pptx';

export interface OfficeFileRef { fileId: string; format: OfficeFormat; url: string; }

export type OfficeEditOperation =
  | { type: 'xlsx.setCells'; sheet: string; range: string; values: CellValue[][] }
  | { type: 'xlsx.insertRows'; sheet: string; at: number; count: number }
  | { type: 'pptx.setText'; slideIndex: number; nodeId: string; text: string }
  | { type: 'pptx.duplicateSlide'; slideIndex: number }
  | { type: 'docx.setParagraphText'; blockIndex: number; text: string }
  | { type: 'docx.insertParagraph'; afterIndex: number; text: string; style?: string };

// packages/builtin-tool-office/src/types.ts（设计草样）
export const OfficeApiName = {
  Create: 'create', Edit: 'edit', Export: 'export', Inspect: 'inspect',
} as const;

// 工具 state（给 UI）与 content（给 LLM）三分法沿用框架约定
export interface OfficeCreateState extends OfficeFileRef { selfCheck?: { passed: boolean; attempts: number } }
```

说明：操作类型的字段命名沿用 t-324 `XlsxEditOperation`/`PptxEditOperation` 的成熟形态（discriminated union + 格式内寻址），但寻址协议最终版在 M2 立项时以 liteXML 对齐评审一次（§2.2 映射规范）。

### 3.4 与现状代码的精确对接点（已逐条核实）

| 对接点 | 现状事实 | 本文档用法 |
|---|---|---|
| 服务端 runtime 注册 | `apps/server/src/services/toolExecution/serverRuntimes/index.ts`：`serverRuntimeFactories` Map + `registerRuntimes([...])`，`getServerRuntime(identifier, ctx)`（43+ 个 runtime 同范式） | M-03 照 `pageAgent.ts`/`cloudSandbox.ts` 范式新增 |
| 前端 executor 注册 | `src/store/tool/slices/builtin/executors/index.ts`：`Map<string, IBuiltinToolExecutor>` + `registerBuiltinToolExecutors()` 懒加载 catalog | M-06 在 catalog 增 OfficeExecutor |
| 工具清单 | `packages/builtin-tools/src/index.ts`：`defaultToolIds`(14)/`alwaysOnToolIds`(4)/`chatModeAllowedToolIds`(6)/`runtimeManagedToolIds`(9)/`AGENT_SHARE_ALLOWED_BUILTIN_IDENTIFIERS`(12) | M1 仅入 `runtimeManagedToolIds` 与 `AGENT_SHARE…`（经审阅后），**不入** `defaultToolIds`（默认关闭） |
| Work 合成 | `packages/builtin-tools/src/fileEditScan/index.ts`：`ENTITY_EXTENSIONS`（ppt/pptx→slides、xls/xlsx→sheet、doc/docx→doc）；`apps/server/src/services/workRegistration/registerWorksForOperation.ts` 合成文件 Work | M1 产物自动入 Work，无需 manifest work（C7） |
| Work 声明类型 | `PluginApiWorkConfig { action, resourceType: 'document'|'task' }`（`packages/types/src/tool/builtin.ts:141-170`） | 仅 `export` api 声明 `resourceType: 'document'` |
| 沙箱 API | `lobe-cloud-sandbox` 13 apiName，其中 `executeCode/writeFile/editFile/moveFiles/runCommand` 声明 `humanIntervention: 'required'`（`packages/builtin-tool-cloud-sandbox/src/manifest.ts`） | `create` 自由代码路径复用其审批；`exportFile` 复用其产物上传 |
| 文件注入沙箱 | `SandboxInitFileItem`（`packages/database/src/models/file.ts:59`）+ `findFilesToInitInSandbox(topicId)` | `edit` api 把目标文件注入沙箱执行代码修改 |
| 预览组件 | `FileViewer/index.tsx:44` `MSDOC_EXTENSIONS`；`Renderer/Document/index.tsx:101-105` `OFFICE_PANES` 按 MIME 分发 | M-07 直接复用，不改渲染器 |
| i18n | `packages/locales/src/default/plugin.ts` 扁平点号键：`builtins.lobe-cloud-sandbox.apiName.exportFile` 等 | M-14 同形新增 `builtins.lobe-office.*` |

---

## 4. AI 交互体验框架（任务书 c 项）：四种模式的组件与协议设计

设计原则（对齐 LobeHub 设计值：自然/意义感/确定性/成长）：**office 文件的编辑主界面是对话**——模型负责改，人负责看和确认；人直接上手编辑是 M3 Univer 面之后才有的增强。所有模式共享同一套工具协议（§3.3 的 apiName/payload/state），差异只在 UI 表面与状态机。

### 4.1 对话内卡片（生成结果的即时呈现）

- **组件**：`OfficeFileCard`（Render 表面，`packages/builtin-tool-office/src/client/Render/OfficeFileCard/index.tsx`）——格式图标（docx/xlsx/pptx）、文件名、大小、页数/sheet 数摘要、「预览 / 下载 / 继续修改」三动作；`OfficeInspector`（Inspector 表面）——调用参数摘要（format、spec 要点、模板名、自检结果）；`OfficePreviewPortal`（Portal 表面）——全屏 FileViewer 预览，pptx 带缩略图导航。
- **协议**：工具结果三分法（content 给 LLM / state 给 UI / error）。`state: OfficeCreateState`（§3.3 草样）经 `renders.ts`/`portals.ts` 注册表映射到组件；卡片动作「继续修改」回填一条用户消息（`@agent 修改这份文件：…`），把会话引导进 4.3 的追问编辑模式。下载走 `/f/:id` 既有链路。

### 4.2 预览-确认（对既有文件的破坏性修改前闸口）

- **适用**：`edit` api 命中已有文件（尤其他人/历史产物）、`export` 覆盖同名文件。
- **组件**：`OfficeEditConfirm`（Intervention 表面 + 浮层）——左侧结构化 diff 摘要（按 OfficeEditOperation 逐条列出「改什么」），右侧嵌入只读预览（复用 FileViewer 渲染「修改后」的新 blob，由服务端先生成预览副本）；操作粒度：逐条勾选/全选接受。
- **协议**：`edit` manifest 声明 `humanIntervention: 'required'`；服务端在真正写文件前挂起，经 `InterventionChecker` → 前端浮层确认 → 恢复执行。State 机：`proposed → approved → applied → registered(fileId')`；拒绝时 `rejected` 并把原因回给模型作为下一轮输入。预览副本用 `files.metadata.versionKind: 'preview'` 标记，不进入 Work 版本链。

### 4.3 追问编辑（自然语言 → 声明式操作）

- **流程**：用户「把第 3 页标题改成 X；给 Sheet2 加一列合计」→ 模型先调 `inspect` 拿结构化大纲（slides[].nodes / sheets[].ranges 带寻址 id）→ 生成 `operations: OfficeEditOperation[]` 调 `edit` → 走 4.2 确认 → 新版本文件 + 更新后的卡片预览。
- **组件**：`OfficeEditInspector`——操作列表（每条一行：格式图标 + 寻址 + 变更摘要 + 状态），复用 `LexicalDiff` 的 diff 渲染行内高亮；`Streaming` 表面在 `inspect` 长输出时给骨架屏。
- **协议要点**：`inspect` 的返回寻址 id 在同一文件版本内稳定（xlsx 用 `sheet!A1` 语义坐标，pptx 用 slideIndex+nodeId，docx 用块 index+sentinel 前缀）；`edit` 请求携带 `baseFileId + expectedVersion`（乐观并发，参考 `document:update` 的乐观并发模式）；操作部分失败时返回逐条结果（`formatModifyNodesResult` 的重试提示范式，packages/editor-runtime 已有同款）。

### 4.4 多轮迭代（版本链 + 自检闭环 + 回滚）

- **版本链**：每次 `edit`/`export` 产出新 files 记录（`metadata.derivedFrom` 指向基线），卡片右上角「v3 ← v2 ← v1」下拉可回看任意历史版本（只读预览 + 「回滚为最新」动作= 以旧版本为基线再 edit 一次）。
- **自检闭环**：`create(selfCheck: true)` 在服务端执行 M-04：soffice 渲染成图 → 多模态模型按「布局是否越界/文字是否截断/图表是否渲染」打分 → 不通过自动重试（上限 3 次）→ 最终报告进 `state.selfCheck`（卡片上以 ✓/⚠ 展示）。
- **Work 呈现**：版本链挂到话题 Work 下（fileEditScan 合成的 slides/sheet/doc Work 自动归并同话题同实体），Goal/任务视图可见「本话题产出的三件套及其版本」。
- **协议**：版本节点 `{ fileId, versionKind, derivedFrom, createdAt, toolCallId }`；回滚不删除历史（软可见性），保持审计。

### 4.5 四种模式与里程碑的关系

| 模式 | M1 | M2 | M3 |
|---|---|---|---|
| 对话内卡片 | ✦ 完整（生成即卡片） | ✦ 追加 edit/export 卡片形态 | 卡片可跳转 Univer 编辑面 |
| 预览-确认 | 不涉及（无 edit） | ✦ 完整 | 复用 |
| 追问编辑 | 仅「重新生成」级 | ✦ 完整（inspect+edit） | 增强（Univer 内直接改，回写走同协议） |
| 多轮迭代 | ✦ 版本记录（基础） | ✦ 版本链 UI + 自检闭环 | 复用 + 协同编辑场景另评估 |

---

## 5. 分阶段路线图（任务书 d 项）

### 5.1 路线图总表

| 里程碑 | 时间窗 | 对应可行性分析阶段 | 范围（条目化） | 依赖 | 验收形态 |
|---|---|---|---|---|---|
| **M1 生成底座** | 0–1 月 | P0（R1） | ① ✦`packages/office-operations`（xlsx Provider 完整；pptx/docx Provider 覆盖生成场景）② ✦`packages/builtin-tool-office`：`create`/`inspect` + systemRole + Inspector/Render/Portal ③ ✦`serverRuntimes/office.ts` + 全部注册接线（M-05/06/14）④ ✦`officeSelfCheck/` 渲染自检闭环 ⑤ 文档：映射规范骨架 + License 红线写入工程规范 | cloud-sandbox 可用（G9 验证结论）；生成三件套依赖锁定（C6）；开发机/沙箱 soffice 可用性 | 见 §5.2-M1 |
| **M2 体验层** | 1–3 月 | P1（R1 增强 + R2 单向） | ① `edit` api + OfficeEditConfirm 预览-确认 ② ✦`office-operations/src/mapping/`：liteXML→OOXML 单向导出 + `export` api + ExportOfficeMenu ③ 文件版本链（M-11 元数据约定 + 版本 UI）④ 模板约束管线（R6 并入：模板库 + 品牌版式注入 systemRole）⑤ 可选：presenton worker 接入（R5b，1–2 人周） | M1 全部；`@lobehub/editor` headless 转换校验；模板库素材 | 见 §5.2-M2 |
| **M3 编辑面** | 3–9 月 | P2（R4 生产化 + R5a 可选） | ① Univer PoC（2–4 人周，可与 M2 并行）→ ✦`packages/office-univer` + ✦`src/features/OfficeEditor/` 生产化 ② 云端可选 ✦`officeSuite/` iframe 模块（docker profile）③ R2 双向（块锚定）立项评估：genoffice 季度跟踪 + 立项评审 ④ xlsx 500 行/20MB 上限随 Univer 面一并重估 | M2；Univer Pro 采购条款结论（U2）；OnlyOffice/Collabora 部署决策 | 见 §5.2-M3 |

### 5.2 各里程碑验收形态（逐项核对）

**M1 验收**（在真实对话中完成，非单测）：
1. 对 agent 说「生成一份含 3 个工作表、带合计公式的 Q3 销售 xlsx 和一份对应汇报 pptx」→ 消息内出现两个 OfficeFileCard，可全屏预览（xlsx 网格、pptx 缩略图）；
2. 下载文件用真实 Office/WPS/Keynote 打开**无修复提示**（zip CRC 干净、部件完整——`office-operations/src/verify.ts` 断言全过）；
3. 自检闭环可见：`state.selfCheck` 报告 + 至少一次「生成→渲染→看图」的记录可查；
4. 产物已注册为话题 Work（slides/sheet/doc 实体在 Work 视图可见）；
5. `create` 的自由代码路径（cloud-sandbox executeCode 生成）同样入卡片与 Work；
6. Go/No-Go：G9 沙箱网络验证完成并记录结论；若 python 库不可用，Node 生成库路径不受影响（降级预案验证）。

**M2 验收**：
1. 对已有文件追问「把 Sheet2 的 B 列改成百分比格式，加一页总结幻灯片」→ OfficeEditConfirm 出现结构化 diff → 确认后产生新版本卡片（v2），v1 可从版本下拉回看；
2. 自有文档（Portal Document）「导出为 docx/pptx」→ 导出文件在 FileViewer 预览高保真（映射规范对照测试全过；版式降级规则有文档说明）；
3. 模板约束生效：选品牌模板生成的 pptx 视觉下限稳定（对比无模板基线，人工评审通过）；
4. 乐观并发生效：基于旧版本 edit 被拒并提示刷新（expectedVersion 冲突路径有测试）；
5. 回归：M1 全部验收项不重测即通过。

**M3 验收**：
1. xlsx/docx 在 LobeHub 界面内直接编辑（Univer 面），保存回写为新文件版本并出现在版本链；
2. （云端部署）开启 officeSuite 模块后 OnlyOffice/Collabora iframe 内可编辑平台文件；OSS 自托管 docker-compose profile 一键起；
3. Univer Pro 采购 vs 自建适配的决策报告归档（含 xlsx 保真度实测数据）；
4. R2 双向块锚定编辑的立项评审结论（做/不做/再观察 + 依据）；
5. 回归：M1/M2 验收项通过。

### 5.3 Go/No-Go 检查点（沿用可行性分析 §5）

| 检查点 | 触发时机 | No-Go 条件 | 降级路径 |
|---|---|---|---|
| G9 沙箱网络 | M1 第 1 周 | 云沙箱不可装 python office 库 | Node 生成库纯 npm 路径（M1 主路径本来就是 Node 生成库，python 仅增强） |
| soffice 可用性 | M1 自检闭环联调前 | 沙箱/服务端无 headless LibreOffice | 弱自检（多模态直读生成 spec + 结构校验），强自检推迟 |
| Univer Pro 条款（U2） | M3 立项前 | 报价/SaaS 转售权不可接受 | 自建格式适配层（+6–10 人周）或 R5a iframe 承接 |
| xlsx 保真度 | Univer PoC 末 | 实测保真不达标 | 表格编辑面改走 R5a 套件 iframe，Univer 仅用于文档件 |

### 5.4 M3 之后的观察项（对应可行性分析 P3，不在本路线图承诺内）

- **R2 双向保真编辑**（10–16 人周起，L2）：仅当 genoffice 范式持续验证、且 M2 单向导出被高频使用时立项；
- **R3 重评估**：仅当 R4（Univer）与 R5a（套件 iframe）均证伪核心编辑场景时启动自研评估（可行性分析 §6.3：12 个月内不立项）；
- 协同编辑（yjs 侧）不在任何里程碑承诺——`@lobehub/editor` 的 yjs 底座只覆盖自有文档，office 协同在 Univer Pro 层（C5 约束已声明）。

### 5.5 人周估算汇总（沿用可行性分析口径，±50%）

| 里程碑 | 估算 | 主要构成 |
|---|---|---|
| M1 | 4–6 人周 | 工具八层 2–3 + xlsx/pptx/docx 生成 Provider 1–2 + 自检闭环 1–2（可行性分析 R1：2–3 + 自检 1–2） |
| M2 | 6–9 人周 | 单向导出 4–6（可行性分析 R2 单向）+ edit/确认交互 1–2 + 版本链 1 |
| M3 | 10–16 人周 + 2 个 PoC | Univer 生产 8–12 + iframe 模块 2–4 + 双向评估（若立项另算） |

---

## 6. 与上一 Goal 半成品实现的关系（任务书 e 项）

### 6.1 事实核查（先纠正任务书的前提）

任务书称旧实现位于「feat/ai-office-agent 分支 `packages/builtin-tool-office`」。经逐项核查：

- `git fetch origin feat/ai-office-agent` → **`couldn't find remote ref`**（本地、远端均无该分支）；
- `git rev-list --all -- packages/builtin-tool-office` → **空**（全部可达 commit 无此路径）；GitHub API 查该路径 404；
- 远端唯一 office 相关分支为 **`feat/t-324-office-capability-baseline`**（8 个 commit，2026-09-03，基于 canary `546cc8354e`，现已落后 810+ commit）。

**结论：上一 Goal 的真实半成品是 `feat/t-324-office-capability-baseline`**，内容为浏览器内的三件套编辑器（非 `packages/builtin-tool-office` 工具包）。下文按该真实分支逐项处置；若未来真创建 `packages/builtin-tool-office`，按 §3 的边界定义执行，不继承 t-324 的代码位置。

### 6.2 留作参考（Keep）

| # | 资产 | 位置（t-324 分支） | 保留方式与理由 |
|---|---|---|---|
| K1 | 能力基线文档 | `docs/development/office-document-capability-baseline.md` | **最佳资产**。PPT-01..08/XLS-01..09/DOC-01..08 需求表、六阶段用户旅程、发布门禁（完整性/保真/状态确定性/恢复/性能≤3s）直接作为 M1–M2 的验收契约来源 |
| K2 | 验收场景目录 | `docs/development/office-document-acceptance-scenarios.yaml` | 8 条 globalHardFailures（修复提示/sentinel 丢失/计数错误/公式错/静默丢特性/不可恢复破坏）+ SHARED/PPT/XLS/DOC 场景，移植为 `office-operations` 测试包的验收场景 |
| K3 | 夹具规范 | `docs/development/office-document-fixture-spec.md` + `docs/development/t-325-office-baseline/fixtures/`（`excel-seed.csv`、`expected-results.json`、`word-content.md`、`ppt-storyboard.md`） | sentinel 约定（`LH-OFFICE-V1`）、确定性夹具与预言值，直接复用为 M1 自检与 Provider 测试夹具 |
| K4 | 文件类型检测 | `src/features/FileViewer/fileType.ts` + `fileType.test.ts`（`matchesFileType`/`isDocxFile`/`isPptxFile`/`isXlsxFile`） | 小、测试扎实；M-08 接线时整体搬入（含测试） |
| K5 | xlsx 声明式操作 API | `src/features/FileViewer/Renderer/XLSX/xlsxOperations.ts`（`XlsxEditOperation` 联合类型 + `editXlsx(bytes, op)`） | 作为 `packages/office-operations/src/xlsx.ts` 的设计模板（discriminated union + 语义寻址）；公式引擎部分仅原型级，按 F3 策略重做 |
| K6 | 测试方法学 | 三处：linkedom 桩 DOMParser、`checkCRC32` reopen 断言、sentinel 语义 diff；python 校验脚本模式（`scripts/verify-t328-word-fixture.py`） | 移植进 `office-operations/src/verify.ts` 与测试包；「编辑产物必须用真实 Office 打开验证」的手工证据流程转为 M-04 自检闭环的自动化版 |
| K7 | PPTX OOXML 机制 know-how | `src/features/FileViewer/Renderer/PPTX/pptxOperations.ts` | 仅作案头参考（不搬代码）：rels id 分配、`[Content_Types].xml` 记账、占位符几何从 layout 物化、图表部件 + 同步 PNG 回退、包级幻灯片增删改排 |
| K8 | DOCX 操作联合类型形态 | `src/features/FileViewer/Renderer/DOCX/docxOperations.ts` 的 `DocxEditOperation` 形状 | 作 `OfficeEditOperation` docx 变体的 schema 起点；另记录其两个反面教训（见 D4） |

### 6.3 废弃（Discard）

| # | 资产 | 位置（t-324 分支） | 废弃理由 |
|---|---|---|---|
| D1 | 三件套编辑器 UI | `Renderer/{DOCX,PPTX,XLSX}/index.tsx`（约 530/640/400 行） | 手写 GUI、`window.prompt` 驱动、单色表格按钮，低于产品 UX 基线；与「对话即编辑器」架构正面冲突；M3 起由 Univer 面承接人直接编辑 |
| D2 | 手写 XML 操作引擎 | `Renderer/DOCX/docxOperations.ts`、`Renderer/PPTX/pptxOperations.ts` | 依赖浏览器 DOMParser（Node/沙箱不可运行，服务端工具调不到）；图表 XML 硬编码 axId 不可重入；docx `replaceText` 塌缩 run、丢内联图/域；列表插入硬编码 numId 5/1（悬空引用）。由 M-02 的生成库对象树 + 块锚定范式替代 |
| D3 | IndexedDB 草稿存储 | 三份 `draftStorage.ts`（`lobehub-office-drafts`/`lobehub-pptx-editor`/`lobehub-xlsx-editor`） | 「保存」不上传、无版本、无 Work 集成；sourceUrl 轮换即静默丢草稿；与 M-11 服务端版本链模型不兼容。仅保留「客户端恢复缓存」的思路 |
| D4 | 重复公式引擎 | `src/features/Portal/LocalFile/excelWorkbook.ts`（与 xlsxOperations 并存的第二套 `calculateFormula`/`recalculateWorkbook`） | 同一产品两套语义略异的正则公式引擎是合并债；M2 起统一为 ExcelJS `fullCalcOnLoad` 策略（F3） |
| D5 | 证据生成脚本 | `scripts/generate-pptx-browser-evidence.ts`、`render-pptx-editor-evidence.ts`、`t327-excel-evidence.ts`、两个 .py | 一次性 esbuild 打包 src/features 内部结构的证据生成器；M-04 自检闭环替代其职能 |
| D6 | committed 证据二进制 | `artifacts/`（t-325、t-326 约 20 文件）、`outputs/t-327/`（含 macOS `.qlpreview` plist 垃圾，约 40 文件） | 仓库污染；证据应进 acceptance 系统/对象存储，不进 git |
| D7 | 未声明依赖 | `docxOperations.ts`/`pptxOperations.ts` 直接 `import JSZip` 但任何 package.json 未声明 jszip | pnpm 严格 linker 下的潜在构建断裂；M-02 显式声明所需依赖 |
| D8 | 分支本身 | `feat/t-324-office-capability-baseline` | 落后 canary 810+ commit，rebase 成本高；内容按 K1–K8 抽取后归档，不做 merge |

### 6.4 处置汇总与落地动作

- **M1 立项时**：将 K1–K3 移植进实现仓库测试包（夹具 + 场景 + hard-failure 清单作为 `office-operations` 的验收门槛）；K4 随 M-08 搬迁；K5–K7 作为设计输入评审一次。
- **工程规范追加**（可行性分析 §6.3 Do ③）：License 红线（C4）+ 「office 可执行逻辑禁止落在 src/features」（§3.2-1）+ 「证据二进制不入库」（D6）三条写入 `.agents/skills/` 对应技能文档。
- t-324 的 DOCX 列表插入、塌缩式替换等「静默丢失」行为（D2/D4）列入 `office-operations` 测试的 hard-failure 对照项——用自己的反面教材做回归。

---

## 7. 风险与开放问题

| # | 风险/开放问题 | 影响 | 缓解 |
|---|---|---|---|
| F1 | 沙箱网络策略（G9/U1）不确定 | M1 python 增强路径 | M1 主路径为 Node 生成库；M1 第 1 周完成验证 |
| F2 | soffice headless 在沙箱/服务端的可用性 | M-04 强自检 | 弱自检降级；服务端 worker 预装 LibreOffice 作为部署选项 |
| F3 | ExcelJS 无公式引擎（t-324 自评仅 SUM/AVERAGE/MIN/MAX/COUNT 级） | xlsx 产物公式可信度 | M1/M2 用 `fullCalcOnLoad` 让 Excel 打开时自算 + 自检闭环读值验证；真公式引擎属 R4/Univer 或远期 |
| F4 | exceljs 停摆期供应链 CVE（U3） | xlsx 生成依赖 | 锁版或 `@protobi/exceljs` 分叉，package.json 记录理由（可行性分析 §7 U3） |
| F5 | Univer Pro 条款（U2） | M3 成本与功能面 | PoC 先用 OSS 层；双备选（自建适配 / R5a iframe） |
| F6 | liteXML↔OOXML 版式语义鸿沟 | M2 导出「能导出但不好看」 | 映射规范明写降级规则；模板约束（M2-④）抬视觉下限；自检闭环兜底 |
| F7 | 大文件/旧格式预览上限（500 行/20MB/Office Online 依赖公网） | 体验边界 | M1/M2 接受现状；M3 随 Univer 面重估（现状分析 G7） |
| F8 | identifier 永久化（C9） | `lobe-office` 一经发布不可改 | M1 评审时一次定名；apiName 演进允许（历史消息只存 identifier+apiName 文本） |

---

## 8. 附录

### 8.1 输入文档引用

| 文档 | 文件 | 本文档引用章节 |
|---|---|---|
| 商业调研（T-565） | `ai-office-implementation-survey.md` | §1.1 路线定义参照、§6 K1 验收契约 |
| 开源调研（T-566） | `2026-09-29-open-source-office-survey.md` | §1.2 C4/C5/C6、§2.2 块锚定范式、§5.3 genoffice 跟踪 |
| 现状分析（T-567） | `2026-09-29-lobehub-office-capability-reuse-gap-analysis.md` | §1.2 C1–C9、§2 各层复用/新建标注、§3.4 对接点 |
| 可行性分析（T-570） | `2026-09-29-office-technical-route-feasibility.md` | §1.1 选型基准、§5 路线图映射、§7 F1/F4/F5 |

### 8.2 关键仓库文件索引（设计引用）

| 主题 | 路径 |
|---|---|
| 工具模板 | `packages/builtin-tool-page-agent/src/{manifest,types,systemRole}.ts`、`src/ExecutionRuntime/index.ts`、`src/client/executor/index.ts` |
| 注册接线 | `packages/builtin-tools/src/{index.ts,identifiers.ts,register.ts}`、`apps/server/src/services/toolExecution/serverRuntimes/index.ts`、`src/store/tool/slices/builtin/executors/index.ts` |
| Work 合成 | `packages/builtin-tools/src/fileEditScan/index.ts`（`ENTITY_EXTENSIONS`）、`apps/server/src/services/workRegistration/registerWorksForOperation.ts` |
| 沙箱 | `packages/builtin-tool-cloud-sandbox/src/{manifest.ts,types/api.ts,ExecutionRuntime/index.ts}`、`apps/server/src/services/sandbox/service.ts`（`exportAndUploadFile`） |
| 预览 | `src/features/FileViewer/{index.tsx,fileType.ts}`、`src/features/FileViewer/Renderer/Document/{DocxPane,PptxPane,xlsx/XlsxPane,OfficeOnlinePane}.tsx` |
| 文档模型 | `packages/editor-runtime/src/{EditorRuntime.ts,liteXMLEditPlan.ts}`、`@lobehub/editor` headless/litexml-commands 入口 |
| 数据模型 | `packages/database/src/schemas/file.ts`（`documents`/`files`/`globalFiles`、`SandboxInitFileItem`） |
| 产物范式 | `packages/html-artifact/src/index.ts`（参考） |
| t-324 旧实现 | `origin/feat/t-324-office-capability-baseline`（§6 全部分析对象） |

*文档完成时间：2026-09-29 · 设计执行：LobeHub Agent（Kimi Code）· 任务 T-571*
