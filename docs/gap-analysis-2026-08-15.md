# dsh-tui 全量差距报告（vs deepseek-harness / Claude Code）

生成方式：30 个 agent（8 盘点 + 11 专职差距分析 + 11 对抗验证），共 331 条差距、261 条验证。
验证结果：233 confirmed / 25 partial / 3 refuted（已从表中剔除）。

---

## gap:harness-web-chat（33 条）

| 严重度 | 工作量 | 验证 | 差距 | 我们的现状 | 参考方行为 |
|---|---|---|---|---|---|
| high | M | confirmed | Per-message like/dislike feedback with optional note | No per-message feedback at all. Only /copy and Ctrl+X copy the last assistant answer. No rating, no note, no feedback persistence. Tool-call approval reject-wit | Renders a like/dislike toggle with optional note editor; persists rating and note via version-CAS put/delete on the message record. |
| high | S | confirmed | Per-message copy action on every message | Only /copy and Ctrl+X copy the last assistant answer. Cannot copy an arbitrary historical message, user message, or tool result. Terminal scrollback selection p | Renders a copy button on every message that writes the exact message text to the clipboard. |
| medium | M | partial | Per-message branch/fork action on completed turns | Only session-level /rewind which rewinds the current session to a prior prompt. No fork-to-new-session from an arbitrary message. /resume reopens a prior sessio | Renders a branch action on completed turns that forks the session at that message and opens the child session. |
| high | L | confirmed | Image and file attachment intake (paste/drag/file picker) | No image or file attachment support. The editor is plain multi-line text. No paste-image, no drag-drop, no file picker. @-mention autocomplete references file p | Accepts pasted/dropped images, validates against image-limit, shows thumbnails in a rail, and previews in a lightbox. |
| high | L | confirmed | Queued message dock with per-message edit/delete/steer | Submitted prompts while a turn is running are queued invisibly. On cancel, all queued prompts are returned to the editor joined by newlines. No visible queue, n | Lists pending turns with per-message edit, delete, and steer-into-current-turn actions; collapsed header shows count; expand/collapse toggle. |
| high | S | confirmed | Empty-draft steer-all-queued gesture | No such gesture. Ctrl+Enter is not bound to any queue action. The only queue interaction is cancel-which-returns-all. No way to inject queued content into the l | When draft is empty and queue is non-empty, Ctrl+Enter steers all queued messages into the running turn at once. |
| high | S | confirmed | Busy-Enter behavior preference (Queue vs Steer) | No preference. The TUI always steers: pressing Enter while a turn is running submits the draft as a steering message. No setting to make Enter queue instead. | Offers a two-option toggle (Queue vs Steer) persisted to settings; submission-policy reads it to decide Enter behavior while busy. |
| high | M | confirmed | Context-occupancy meter with heuristic composition breakdown | The prompt line shows a bare context percentage. No ring, no click-to-expand, no per-section breakdown. /status shows aggregate token counts but not the heurist | Renders a 14px occupancy ring after the model seat; click opens a panel listing system-prompt / tools / messages / kV-cache composition with per-section token c |
| high | M | confirmed | Model-retry status row with live countdown | Retry is a static warning notice via pushNotice with the failure message and delayMs. No countdown tick, no shimmer, no retry-policy display. The notice appears | Projects consecutive retries as one muted status row with a client-side countdown anchored to receive time, shimmer animation, and retry-policy display (maxRetr |
| low | S | partial | Max-tokens truncation with inline continue suggestion | Max-tokens stop is a generic warning notice via pushNotice. No inline status row, no one-click continue. The user must manually type 'continue' or resend. | Renders a persistent inline status at the turn boundary with a one-click 'Send continue' action. |
| medium | L | confirmed | Trajectory / event-ledger view | No trajectory view. The TUI transcript renders the conversational stream only. Internal events are transient notices or collapsed groups, not a queryable ledger | Renders a turn/step-grouped event ledger with timeline overview, per-event inspector, and token/timing breakdown; virtualised for long sessions. |
| medium | L | confirmed | Subagent catalog tree with live status | No subagent UI. Subagent spawns are mentioned in code comments but there is no catalog, no tree, no status, no navigation to child sessions. /status does not li | Renders an expandable tree of parent/child agent runs with token totals, running/error/done status, and click-to-open child session. |
| medium | L | confirmed | Background jobs list with progress and cancel | No jobs UI. The TUI has no background-job surface. Long-running operations block the turn or are invisible. No job list, no progress, no cancel. | Renders a header popover listing background jobs with per-job progress, status, and cancel action. |
| medium | L | confirmed | Workflow run visualisation (node graph) | No workflow UI. Workflow runs are not rendered as a graph; they appear only as sequential tool-call entries in the transcript if at all. | Renders workflow execution as a node graph with per-node status, inputs/outputs, and timing. |
| medium | L | confirmed | Session rename and archive from a persistent sidebar | No sidebar, no rename, no archive. /resume lists prior sessions in a modal picker and can reopen one; /new /clear handle the current session. Sessions cannot be | Renders a persistent sidebar with session list, inline rename, archive with confirm, pin, duplicate, and drag reorder; sessions grouped by workspace. |
| medium | M | confirmed | Workspace add / rename / reorder / delete | No workspace management. The /resume picker can scope by workspace path but workspaces cannot be created, renamed, reordered, or deleted. No workspace tree. | Provides workspace CRUD (add/rename/reorder/delete), session grouping by workspace, and a sidebar workspace tree. |
| medium | M | confirmed | Plan-review surface (approve / reject / comment) | No plan-review surface. Plan-mode exits are generic tool approvals or questions. No dedicated plan view, no approve/reject plan action, no plan comment thread.  | Renders a dedicated plan-review surface showing the plan markdown with Approve / Reject / comment actions, distinct from the generic question composer. |
| medium | M | confirmed | Tabbed view switcher (Chat / Trajectory / plugin views) | Single transcript view. No tab system; the transcript is the only surface. /status and /plugins open modal panels that overlay and dismiss; they are not persist | Registers a view-tabs slot in ConversationRoot; tabs switch between Chat, Trajectory, and plugin-contributed views without losing scroll position. |
| medium | M | confirmed | Persistent session header with title, actions, and utilities | No persistent header. The startup banner scrolls away with the transcript. The prompt line carries model, context, git branch, cwd, goal but is an input footer, | Renders a fixed session header with title, view-tabs, actions slot (jobs, subagent catalog), and utilities slot (settings, theme, connection). |
| low | L | confirmed | Hover cards and inline previews | No hover support. The TUI is keyboard-driven; terminals do not have a hover idiom. Code explicitly notes 'this terminal has no hover'. | Renders a hover card with file previews, command docs, and tool signatures on pointer hover. |
| low | S | confirmed | Toast / banner notifications for async events | No toast system. Async feedback is via the status-line flash (1.5s) or transcript notices. No dedicated toast surface. | Renders a top-of-viewport transient banner for connection loss, job completion, and plugin events. |
| low | M | confirmed | First-run onboarding wizard | No onboarding wizard. The TUI starts directly into chat with a welcome banner. Theme is auto-detected. Model is selected via /model. No guided first-run flow. | Runs a multi-step wizard on first launch: theme picker, model selection, credential check, and welcome notice. |
| low | S | confirmed | Connection status banner with reconnection state | No connection banner. No visible connection-state surface. If the host connection drops, the failure surfaces as a generic error notice or silent stall. No reco | Renders a 'Reconnecting' / 'Connection lost' banner with spinner; auto-dismisses on reconnect. |
| low | S | confirmed | Per-code-block copy button and language label | Code blocks are fenced markdown with optional syntax highlighting via MarkdownHighlighter. No per-block copy button, no language label. The user must select tex | Renders a code block with a language label header and a copy button; uses shiki for syntax highlighting. |
| low | L | confirmed | Math / LaTeX rendering (KaTeX) | No math rendering. The TUI markdown pipeline has no KaTeX or LaTeX support. Math expressions appear as literal source text. | Renders $...$ and $$...$$ via KaTeX; block math is centred. |
| low | M | confirmed | Read-tool card with line numbers and range indicator | Read-tool output is generic dim markdown. No line numbers, no range indicator, no 'showing N of M'. File content is plain text. | Renders a file-read card with line-number gutter, 'showing N of M' footer, and offset/limit metadata. |
| low | M | confirmed | Search-tool card with per-file collapsible groups | Search output is generic dim markdown. No per-file grouping, no collapse, no match counts. | Renders search results grouped by file with per-group collapse/expand, match counts per file, and 'X matches in Y files' summary. |
| low | M | confirmed | Web-search card with citation links and source list | Web-search output is generic dim markdown. No citation list, no source links, no favicon, no result count. URLs appear as inline text if the model includes them | Renders a web-search card with a numbered citation list, clickable source URLs, favicon, and result count; empty-state has an illustration. |
| low | M | confirmed | Terminal card with ANSI progress-line and CR handling | Terminal output is raw text lines. No ANSI parsing, no CR handling, no progress-line collapse. Long output is truncated to maxOutputLines (default 6) with an ex | Parses ANSI SGR, CR for in-place progress updates, and backspace; renders spinner frames; output capped with expand. |
| low | M | partial | Diff stat bar (+N/-N) and hunk-level collapse | TUI has word-level diff highlighting and unified/split views, but no +N/-N stat bar and no hunk-level collapse. The diff card shows the full diff or a collapsed | Renders a diff card with a +N/-N stat bar, per-hunk collapse, word-level diff highlighting, and a file-path header. |
| low | S | confirmed | JSON tree inspector for structured tool output | Structured tool output is pretty-printed as text. No interactive tree, no expand/collapse, no type badges. | Renders an interactive JSON tree with expand/collapse, type badges, and copy-path. |
| low | S | confirmed | Inline file-mention links and produced-file chips | File paths in assistant text are plain text; no linkification, no produced-file row, no click-to-open. The @-mention autocomplete inserts a literal path string, | Renders turn-footer chips for files created/modified, clickable to open; inline @path mentions are rendered as links. |
| low | S | confirmed | Reveal-in-file-manager action on produced files | No reveal-in-folder action. The TUI has no OS-integration surface for opening a file manager. /copy can copy a path but cannot reveal it. | Renders a 'Show in folder' action on produced files that opens the OS file manager at the parent directory. |


## gap:harness-web-settings（15 条）

| 严重度 | 工作量 | 验证 | 差距 | 我们的现状 | 参考方行为 |
|---|---|---|---|---|---|
| high | M | confirmed | 无法编辑已配置 provider 的连接属性（baseURL/协议/显示名） | absent。/provider 只有 list 和 add 两个子命令；/login 只能重输 key。改 endpoint/协议/显示名必须手编 $DSH_HOME/settings.yaml。 | Web Models 设置页每个已配置 provider 一行，点开是按适配器家族手写的编辑卡：API key（write-only 经 credentials.set）、baseURL、显示名、API 协议、模型列表，外加折叠的自定义设置区；Apply 后提示不回显密钥。 |
| high | M | confirmed | 无法管理已有 provider 的模型列表（增删模型、显示名、contextWindow/maxTokens） | absent。模型列表只在 /provider add 向导里写一次，且只写 id；已有 provider 加/删模型、改显示名或容量只能手改 YAML。 | Web 模型列表编辑器：每行 id+显示名，contextWindow/maxTokens 藏在行内折叠区（支持 256K/1M 后缀），空列表表示用内置目录；DeepSeek 路由用 DeepSeekModelsEditor 编辑继承生效行，reset 取消覆盖。 |
| medium | L | confirmed | 没有插件配置界面（bash 执行器/agent-loop 并行度/web-search 等可调设置） | absent。/plugins 面板是只读网关：状态列（active/failed/disabled/inactive）+ Enter 看条目详情，注释明确说启用/禁用归配置文件管；没有任何插件配置写入路径。 | Web Plugins 设置区有 configurable 标签页，每个宿主插件一张可展开卡（首批：bash 执行器、agent-loop 并行度、web-search-deepseek），字段标'已覆盖'、可重置回组合默认、暂存草稿、Save 按 revision 栅栏写、Discard 丢弃，有未存改动时卡头明示。 |
| medium | S | confirmed | 没有'新会话默认权限预设'设置项 | absent。Shift+Tab 和 /permission 都只写当前会话（permissionPresets.set(agent.session, ...)）；/config 面板没有权限行；没有'新会话默认权限'设置。 | Web General 设置的 Permission 行：选项来自宿主动态 defaultPreset 枚举，写带 descriptor revision 的设置，只影响之后新建的会话；选 Full access 需先勾选风险确认。 |
| medium | S | confirmed | 没有忙时 Enter 行为设置（Queue vs Steer） | absent。忙时提交一律走 agent.steer（立即插话），没有队列选项，也没有对应设置。 | Web General 设置的 Enter 行为行：主会话运行时普通 Enter 发 Queue（默认）还是 Steer，Cmd/Ctrl+Enter 执行另一行为；写 $DSH_HOME/settings.yaml 跟随用户主目录。 |
| medium | S | confirmed | 无法删除自定义 provider | absent。/provider 无 delete/remove 子命令；删 provider 只能手改 settings.yaml 并清凭证文件。 | Web 仅用户层承载的 provider 行可删（恢复组合基值），确认对话框在标题/描述/最终动作中具名该 provider，删除同时清理本页派生的 <ROUTE>_API_KEY 凭证，幂等。 |
| medium | S | confirmed | danger-full-access 切换没有风险确认门禁 | absent。/permission danger-full-access 直接透传给 host 执行，无确认步骤；modes.ts 注释只解释为何不放进 Shift+Tab 循环。 | Web 选 Full access 时先弹 RiskConfirmation 模态：标题+描述+勾选 acknowledge 后才能 Enable，取消则不写。 |
| medium | M | confirmed | 没有首启引导（欢迎公告 + 无 provider 时的凭证配置步） | absent。无首启引导：无公告机制，无 key 时只靠用户自己发现 /login；/doctor 能诊断但不主动出现。 | Web 首启两个有序对话框：版本化内测公告（loopback 下写 welcomeNoticeVersion，显式 Continue 才记录）；无任何可达 provider 时弹 DeepSeek 凭证步（credential-only 模式的 ProviderEditor，只写凭证不改 provider 设置，Con |
| low | M | confirmed | preset 管理缺删除、composition 只读查看器和目录位置展示 | 部分覆盖。/preset 可切换（空白会话）、存默认、copy；选择器显示 id+描述+current/default 徽章和 broken 原因。无删除、无 composition 只读查看、无路径展示（copy 成功后才报一次 landed 路径）。 | Web Agent Presets 设置页：roster 卡片（描述 4 行截断+tooltip）、copy 对话框（id+可选显示名）、删除 preset 目录、 shipped preset 的只读 composition 查看器、每行位置动作（有桌面打开器则开目录，否则把路径作为文本显示）、broken pres |
| low | S | confirmed | /permission 没有选择器和参数补全 | absent。/permission 作为 host 命令透传，无参数补全、无选择器；用户需记住预设名。 | Web 给 /permission 命令挂 popupSelect 装饰：扁平预设列表（当前值标记、kebab 转 Title Case），选中即提交 /permission <preset>，与 composer 芯片共用同一投影和写路径。 |
| low | S | confirmed | 已有 provider 无法重新拉取可用模型列表 | absent。探测只在 /provider add 和 /login 向导里发生；已有 provider 无法重新拉取模型列表。 | Web 模型列表编辑器的 'Fetch available models'：用当前表单（含未保存的 baseURL/key）问 llm.discoverModels，结果开选择器（已配置项默认不勾），不可询问的端点在行旁显示适配器原话。 |
| low | S | confirmed | 没有'打开配置文件'动作 | absent。无打开配置文件的命令或动作；/config 面板不提 settings.yaml 路径。 | Web General 设置头部的 'Open configuration file'：仅 loopback 且宿主确认 hasDocument 时出现，点击经宿主用原生编辑器打开 settings.yaml（macOS 用 open -t），失败显示本地化错误。 |
| low | S | confirmed | provider 列表没有凭证状态点（绿/红） | 部分覆盖。/provider 列表用文本显示每个 provider 的 key 位置（'key in <env>' 或 'no key'）和模型数，但无颜色状态点，也不区分'引用确认缺失'与'原生认证'。 | Web provider 行用绿点表示引用凭证确认已配置、红点表示具名引用确认缺失；provider 原生认证与不可富集状态不标。 |
| low | S | confirmed | 会话头部没有常驻 preset 标签 | 部分覆盖。当前 preset 只在 /status 和 /doctor 里出现；启动横幅和会话标题都不显示 preset。 | Web 会话标题旁的只读 preset 标签：读会话自己的 summary，对同一 roster 解析显示名，作为静态 chrome（不提供切换，因为 host 拒绝）。 |
| low | S | partial | provider 列表不显示 live/dormant 状态和 Custom 标签 | 部分覆盖。/provider 列表分'已配置'和'可登录'两组，不显示每个 provider 的 live/dormant 状态，也不标 Custom。 | Web Models 页合并 llm.providers/settings.describe/credentials.describe 三线域，provider 行带 live/dormant 状态；目录中适配器未内置的路由标 'Custom' 标签（只看目录回答，有 profile 不算 custom）。 |


## gap:harness-orchestration（8 条）

| 严重度 | 工作量 | 验证 | 差距 | 我们的现状 | 参考方行为 |
|---|---|---|---|---|---|
| high | M | confirmed | 后台任务（jobs）完全不可见：无任务列表、无状态、无时长 | absent — TUI 不注入 JobRegistry，无 jobs 服务访问，无任何后台任务展示。后台 bash 启动仅以 generic 工具卡出现一次，任务的运行/完成/杀死/失败状态和后续输出完全不可见。/status 和 /doctor 也不包含 jobs 信息。 | Web UI 在会话头部渲染 JobListAction：仅当会话有 job 时出现，徽标显示 running+stopping 计数，弹层列出每个 job 的 kind/label/status/detail/elapsed（运行中每秒 ticking）。数据来自 client runtime 的 jobsBySes |
| high | L | confirmed | 子代理目录树缺失：无法发现/浏览本会话的子代理 | absent — TUI 无子代理发现/导航 UI。subagent/start、subagent/end、subagent/descriptor 事件在 foldEvent 中落入 default 分支被静默忽略。/status 不包含子代理信息。 | Web UI 在会话头部渲染 SubagentCatalogAction：可展开的子代理树，每行显示 label/title/mode(one-shot\\|continuable)/activity(running\\|inactive)/token 四桶合计/可视化时长，方向键导航，懒加载子目录，点击进入子会话。数据来自  |
| high | L | confirmed | 子代理 transcript 查看与交互缺失：无法进入子会话 | absent — 无法查看子代理会话的 transcript。子代理的中间步骤（工具调用、思考、输出）完全不可见，只能看到父会话中 subagent 工具调用的最终结果。 | Web UI 点击目录树中的子代理行后打开子会话视图：一次性子代理显示只读 composer（标识为已完成执行记录），可继续子代理在父不可用且未运行时也切只读（附恢复路径说明），父存活时保留普通输入（经 subagent.prompt FIFO 收件箱）。 |
| high | L | confirmed | 工作流运行可视化缺失：workflow/* 事件未接线，无三级折叠视图 | absent — workflow/* 事件在 foldEvent 中被静默忽略，工作流运行完全不可见。tool-workflow 调用以 generic 工具卡出现，tool-ralph 同理。无法看到工作流的阶段、成员、各成员状态和子会话链接。 | Web UI 将 tool-workflow 运行重建为聊天节点（WorkflowRunPanel）：运行/阶段/成员三级折叠行，运行中保持展开、全部完成后折叠，成员行可点击进入仍在运行的子会话，关闭 turn 缺终态事件时显示 interrupted。 |
| medium | M | confirmed | Plan review 无专用面板：plan-review intent 被当作通用问题渲染 | partial — plan review 以通用 QuestionDialog 呈现：plan 正文作为 question detail 显示（可滚动），approve/refuse 作为编号选项。无 intent 识别，无 'Chat about it' 动作（Esc 可拒绝但语义不明确），无专用决策卡样式。 | Web UI 对 plan-review intent 的问题渲染专用 PlanReviewPanel：着色条 + 'Plan review' 标题、可滚动 markdown plan 正文、'Chat about it / Refuse / Approve' 三动作行（discuss 是显式按钮而非 Esc 逃逸）， |
| medium | M | confirmed | skill 工具调用无专用行：模型调用 skill 时渲染为 generic 工具卡 | absent — 模型调用 skill 工具时以 generic 工具卡渲染（XML 树或 dim body），无技能图标/名称/运行中微光/错误首行/有界 Instructions 展开。/skills 面板可浏览技能目录但与工具调用无关联。 | Web UI 为 skill 工具调用注册专用 toolview 键（SkillRow）：折叠行显示技能图标+名称（运行中微光、失败显示首行错误），展开为有界 Instructions 卡（durable 工具输出），可用时带 Inspect 动作。 |
| low | S | confirmed | @ 子代理引用源缺失：无法在输入中 @ 运行中的子会话 | absent — @ 补全仅有文件引用（@file）和会话引用（@session，需 sessionReferenceResolver 挂载），无子代理引用。无法在输入中 @ 一个运行中的子会话。 | Web UI 的 @ 源列出零 RPC 的运行中子会话（从 ctx.sessions.list 取），选中插入字面 @label 文本，不做命令裁决、不解析为续接地址。 |
| low | S | confirmed | Goal 无专用操作条：仅 prompt 行片段 + /status 行，无一键 edit/pause/resume/clear | partial — goal 显示在 prompt 行（截断 40 列）和 /status（完整 objective + phase + round X/Y + blockedReason），/goal 命令可用（host 命令，自动补全中有）。无专用 goal 条和一键动作按钮，需输入 /goal pause\\|res | Web UI 在输入坞 order 10 渲染 GoalBar：显示当前目标，提供 编辑/暂停/恢复/清除 四个动作按钮（读投影 CAS ref，错误内联显示），清除后本地抑制该目标 id 直至投影追上。 |


## gap:harness-session（9 条）

| 严重度 | 工作量 | 验证 | 差距 | 我们的现状 | 参考方行为 |
|---|---|---|---|---|---|
| medium | M | confirmed | 无法在 TUI 中附加图片到 prompt（无草稿图栏/粘贴图片/拖拽） | absent — TUI 没有任何图片附件输入路径：无粘贴图片处理、无拖拽、@ 补全只插入文本提及不产生附件；attachment-local 存储后端虽在 profile 中挂载，TUI UI 完全未消费 | Web 端 dsh-client-ui-attachment 提供草稿图栏（AttachmentRail，64px 缩略图、可删除、点击看原图）、整页拖拽投放层（DropOverlay）；用户可把截图贴进/拖进输入框作为附件随 prompt 发送，附件经 attachment-local 内容寻址存储 |
| medium | M | confirmed | 图片内容块只渲染为 [image] 占位，无内联图片渲染 | absent — contentText 的 default 分支把 image 块渲染为 '[image]' 占位文本；read_image 工具结果卡、用户消息中的图片都只显示占位；无任何终端图形协议支持 | Web 端消息中的图片渲染为缩略图画廊（MessageImage/ImageGallery），点击打开灯箱（ImageLightbox）看原图；模型可见的图片用户也可见 |
| low | S | confirmed | /feedback 备注写入日志但 TUI 不渲染（feedback/record 事件无节点） | partial — /feedback 命令经 ctx.commands.execute 正常执行并回执，但 feedback/record 事件在 nodes.ts/session-store.ts/transcript-search.ts 中零处理：备注不渲染进 transcript，resume 后不可见，/se | command-feedback 把 /feedback <text> 作为不可变 feedback/record 事件写入会话日志；Web 端在对话中展示该备注，反馈还用于会话共享的 feedback-gated 放行 |
| low | M | confirmed | 消息评分 UI 缺失（message-feedback 已挂载但无入口） | absent — TUI patch 挂载了 dsh-message-feedback 并配置 maxNoteBytes: 8192，但 TUI 没有任何评分/备注 UI：assistant 消息上无评分入口，sidecar 数据在 TUI 会话中从不写入也不展示 | Web 端 dsh-client-ui-message-feedback 在每条 assistant 消息上提供可编辑评分/备注 sidecar，数据存会话外存储并供 UI 展示 |
| low | S | confirmed | spill 溢出结果无取回交互（定位符只当文本显示） | absent — TUI 把替换后的预览+定位符当普通工具结果文本渲染，无任何取回交互（如按键打开溢出文件、或按定位符取全文） | spill-policy 把超大工具结果替换为有界头尾预览 + 定位符 + 取回提示（'Full formatted result stored at: <locator>'），用户可按定位符取回全文 |
| low | M | confirmed | 跨会话搜索缺失（session-query-sqlite 已挂载，仅用于 /resume 列表） | partial — sessionQuery 仅用于 /resume 选择器列会话；/search 只搜本会话消息，无跨会话全文搜索入口 | session-query-sqlite 提供持久会话日志的 SQLite FTS 全文搜索与关系查询，tool-session-query 暴露给模型；Web 端 workspace 浏览器可列/过滤会话 |
| low | S | confirmed | Code Mode (run_code) 调用无特化渲染 | absent — run_code 调用走通用工具卡（rawInput pretty JSON + 通用结果体），无程序/输出特化渲染；Code Mode 状态也无专门指示 | Code Mode 下模型写 TypeScript 程序经 run_code 一次执行多操作；code preset 是一等公民 preset，DSH_TOOLS_MODE 可整进程切换 |
| low | M | confirmed | tool-cordis 自修改调用无专属面板（cordis preset 下） | absent — cordis preset 可经 /preset 切换，tool-cordis 调用走通用工具卡；无动态定义面板、无 define 卡片、无运行/撤回交互 | Web 端 ui-cordis 提供面板操作所有动态定义（define 卡片、动态包运行/撤回）；tool-cordis 让模型检视插件/服务 API 并定义运行动态包 |
| low | S | confirmed | 已存凭证无列表/删除 UI | partial — /login 与 /provider add 覆盖添加（验证后存凭证存储，settings 只记变量名），但无列出已存凭证、删除/吊销凭证的入口 | credentials 把引用解析与 provider 分离，暴露 UI 安全的 CredentialInfo；Web 设置界面有 provider 配置与凭证管理 |


## gap:harness-cli（2 条）

| 严重度 | 工作量 | 验证 | 差距 | 我们的现状 | 参考方行为 |
|---|---|---|---|---|---|
| low | S | confirmed | 缺少 dsh tui 简写子命令 (启动器只为 web 硬编码别名) | 没有 dsh tui 简写; 用户必须输入 dsh --profile tui (README:51,62). TUI 是第三方 profile bundle, 无法从自己的 bundle 注册启动器子命令. src/startup.ts:55 的命令名就是 'dsh --profile tui'. | 启动器硬编码 web 子命令作为 --profile web 的别名 (apps/cli/src/args.ts:156 program.command('web')), 用户可输入 dsh web 代替 dsh --profile web. 启动器只认 web 和 plugin 两个子命令, 不为其他 profile |
| low | S | confirmed | --version 打印启动器版本而非 TUI bundle 版本 | TUI 自己的 commander 命令 (src/startup.ts:53-73) 未定义 --version. dsh --profile tui --version 被启动器根命令的 .version() 拦截, 打印的是 apps/cli 的版本而非 TUI bundle 版本. TUI 版本只在启动横幅显示 | 启动器根命令定义 .version(version, '-V, --version') (apps/cli/src/args.ts:119), 打印 apps/cli 包版本. 由于 passThroughOptions 只透传未知 flag, --version 是根命令已知 flag, 会被启动器拦截处理, 不会到 |


## gap:cc-commands（43 条）

| 严重度 | 工作量 | 验证 | 差距 | 我们的现状 | 参考方行为 |
|---|---|---|---|---|---|
| high | M | fixed@0.2.0 | /compact 手动压缩上下文 | absent — 压缩仅自动触发（dsh-compaction），无手动命令，无自定义摘要指令 | /compact 清空对话历史但在上下文中保留摘要，可带自定义摘要指令，支持非交互模式；证据 src/commands/compact/index.ts:6-7 |
| medium | S | partial | /clear 语义：清视图 vs 清上下文 | partial — /clear 只清 transcript 视图（会话日志不变）；释放上下文要靠 /new 开新会话（旧会话保留可 resume） | /clear 清空对话历史并释放上下文，有 caches/conversation 子命令；证据 src/commands/clear/index.ts:12-13 |
| medium | S | confirmed | /cost 会话费用显示 | absent — token-meter 有启发式定价但 TUI 只显示 token 数和缓存命中率，无 cost 命令或显示 | /cost 显示本会话总费用和时长；证据 src/commands/cost/index.ts:10-11 |
| medium | M | partial | /permissions 持久 allow/deny 规则管理 | partial — /permission 是 host 命令切换四个预设（read-only/workspace-write/auto-accept/danger-full-access）；审批对话框有'本会话不再问'但仅进程内记忆，无持久 allow/deny 规则管理 | /permissions 管理 allow 和 deny 工具权限规则（持久规则）；证据 src/commands/permissions/index.ts:5-7 |
| medium | L | partial | /mcp 管理 MCP server（只读面板 vs 管理） | partial — /mcp 是只读面板，从 mcp__<server>__<tool> 命名反推 server 清单；无添加/删除/配置 MCP server 的能力 | /mcp 交互式管理 MCP server（增删改、状态）；证据 src/commands/mcp/index.ts:5-6, mcp.tsx:63-79 |
| medium | L | partial | /plugin 插件管理（只读面板 vs 管理） | partial — /plugins 是只读搜索面板查看 Loader 插件条目；无浏览 marketplace、安装、启用/禁用、更新能力 | /plugin 管理插件：浏览 marketplace、安装、启用/禁用、管理 marketplace；证据 src/commands/plugin/index.tsx:4-6 |
| medium | M | confirmed | /init 生成项目指令文件 | absent — 无项目指令文件概念，无初始化向导 | /init 扫描代码库并生成 CLAUDE.md 项目文档（NEW_INIT 变体还创建 skills/hooks）；证据 src/commands/init.ts:225-235 |
| medium | M | confirmed | /add-dir 扩展工作目录 | absent — 无添加工作目录的命令或概念 | /add-dir 把新工作目录加入会话允许的工具访问根；证据 src/commands/add-dir/index.ts:5-6 |
| medium | L | partial | /rewind 恢复文件（仅会话分叉） | partial — /rewind 只能 fork 会话或回填 prompt 到编辑器，明确不恢复文件 | /rewind 把代码和/或对话恢复到之前某点；证据 src/commands/rewind/index.ts:4-5 |
| medium | M | partial | /agents subagent 管理（/preset 部分覆盖） | partial — /preset 可查看/切换/复制 agent preset；host 有 subagents 注册表但 TUI 无管理命令，无交互式创建/编辑自定义 subagent | /agents 管理 agent 配置（创建/编辑自定义 subagent）；证据 src/commands/agents/index.ts:5-6 |
| low | S | confirmed | /context 上下文可视化 | absent — 无 /context 命令；context 占用在 prompt 行和 /status 中以数字/百分比显示 | /context 把当前上下文用量可视化为彩色网格，有非交互变体打印用量；证据 src/commands/context/index.ts:5-6,14-16 |
| medium | M | confirmed | /tasks 后台任务管理 | absent — 无后台任务管理命令；host 有 jobs 注册表但 tool-jobs 在本组合被禁用 | /tasks 列出并管理后台任务；证据 src/commands/tasks/index.ts:5-7 |
| low | M | confirmed | /diff per-turn 变更视图 | absent — 无 per-turn diff 聚合视图；单次编辑 diff 在工具卡片中渲染 | /diff 查看未提交变更和 per-turn diff；证据 src/commands/diff/index.ts:5-6 |
| medium | M | confirmed | /memory 记忆文件编辑 | absent — 无记忆文件编辑命令，无自动记忆系统 | /memory 编辑 Claude 记忆文件（CLAUDE.md / 记忆层）；证据 src/commands/memory/index.ts:5-6 |
| low | M | confirmed | /btw 侧边提问 | absent — 无侧问命令；运行中提交 prompt 走 steering 排队进主对话 | /btw 问一个快速侧问题，不打断主对话；证据 src/commands/btw/index.ts:5-6 |
| low | S | fixed@0.2.0 | /rename 会话重命名 | absent — 会话标题由 dsh-session-title 自动生成，显示在横幅和终端标题；无手动重命名命令 | /rename 重命名当前对话（无参数时用 generateSessionName 自动生成）；证据 src/commands/rename/index.ts:5-6 |
| low | L | confirmed | /vim 编辑模式 | absent — 编辑器无 vim 模式 | /vim 在 Vim 和 Normal 编辑模式间切换；证据 src/commands/vim/index.ts:4-5 |
| low | S | partial | /effort 命令（选择器已覆盖） | partial — 无 /effort 命令；reasoning effort 在 /model 选择器中用左右/Shift+Tab 调节，/status 显示当前值 | /effort 设置模型 effort 级别（low/medium/high/max），无参数打印当前值；证据 src/commands/effort/index.ts:6-7 |
| low | S | partial | /keybindings 打开键位配置文件 | partial — 无 /keybindings 命令；键位配置在 settings 文件中，/hotkeys 面板查看 resolved 键 | /keybindings 打开或创建 keybindings 配置文件；证据 src/commands/keybindings/index.ts:5-6 |
| low | S | confirmed | /logout 登出 | absent — 有 /login 存凭证，无 /logout 清除凭证 | /logout 登出 Anthropic 账户；证据 src/commands/logout/index.ts:6-7 |
| low | S | fixed@0.2.0 | /copy N 复制第 N 条回答 | partial — /copy 只复制最后一条回答，不支持 /copy N | /copy 复制最后一条回答，/copy N 复制倒数第 N 条；证据 src/commands/copy/index.ts:9-10 |
| low | S | fixed@0.2.0 | /export 导出到剪贴板 | partial — /export 只写文件（JSONL），不支持导出到剪贴板 | /export 把当前对话导出到文件或剪贴板；证据 src/commands/export/index.ts:5-6 |
| low | S | confirmed | /terminal-setup 终端键位安装 | absent — 无终端键位安装命令 | /terminal-setup 安装 Shift+Enter 换行键位（Apple Terminal 上 Option+Enter）；证据 src/commands/terminalSetup/index.ts:14-15 |
| low | M | confirmed | /hooks 查看 hook 配置 | absent — 无 hooks 配置查看命令，无用户级 hooks 系统 | /hooks 查看工具事件的 hook 配置；证据 src/commands/hooks/index.ts:5-6 |
| low | S | confirmed | /files 列出上下文文件 | absent — 无列出上下文中文件的命令 | /files 列出当前上下文中的所有文件；证据 src/commands/files/index.ts:5-6 |
| low | S | confirmed | /tag 会话标签 | absent — 无会话标签命令 | /tag 在当前会话上切换可搜索标签；证据 src/commands/tag/index.ts:5-6 |
| low | M | confirmed | /stats 使用统计 | absent — 无跨会话使用统计命令；/status 只显示本会话统计 | /stats 显示 Claude Code 使用统计和活动；证据 src/commands/stats/index.ts:5-6 |
| low | S | confirmed | /version 命令 | absent — 无 /version 命令；版本显示在启动横幅 | /version 打印当前会话运行的版本；证据 src/commands/version.ts:14-15 |
| low | M | confirmed | /loop、/schedule 定时任务 skill | absent — 无定时循环/远程调度 skill | /loop 按间隔循环运行 prompt 或命令（默认 10m）；/schedule 创建定时远程 agent；证据 src/skills/bundled/loop.ts:76-79, scheduleRemoteAgents.ts:324-333 |
| low | L | confirmed | /review 系列 PR 工作流 | absent — 无 PR review/安全 review 命令 | /review 审查 PR、/security-review 安全审查、/pr-comments 获取 PR 评论（后两者已移到插件）；证据 src/commands/review.ts:35-36, security-review.ts:8 |
| low | M | partial | /reload-plugins 激活插件变更 | partial — /reload 是实验性 dev 命令重读 Loader 配置，仅 idle 时可用，需 experimentalCommands 开启 | /reload-plugins 在当前会话激活待处理的插件变更；证据 src/commands/reload-plugins/index.ts:9-10 |
| low | S | partial | /branch 命名分支（/rewind 部分覆盖） | partial — 无 /branch 命令；/rewind 可 fork 会话（在更早 prompt 处分叉） | /branch 在当前点创建对话分支（fork）；证据 src/commands/branch/index.ts:6-9 |
| low | S | confirmed | /statusline 自定义状态行 | absent — 无自定义状态行命令；状态行是固定的 prompt 行 | /statusline 设置 Claude Code 状态行 UI；证据 src/commands/statusline.tsx:6-10 |
| low | S | confirmed | CLI: --dangerously-skip-permissions 等效标志 | absent — 无跳过审批的 CLI 标志；--print 审批固定 never，交互会话靠 Shift+Tab 切预设 | --dangerously-skip-permissions 跳过所有权限提示；证据 Claude Code CLI |
| low | S | confirmed | CLI: --max-turns 限制轮数 | absent — --print 跑到 quiescence，无最大轮数限制 | --max-turns 限制会话最大轮数；证据 Claude Code CLI |
| low | M | confirmed | CLI: --output-format 结构化输出 | absent — --print 只输出最终答案文本，无流式 JSON 输出格式 | --output-format 支持 stream-json 等结构化输出；证据 Claude Code CLI |
| low | S | confirmed | CLI: --verbose/--debug | absent — 无 --verbose/--debug 标志；调试面板在 Shift+Ctrl+D | --verbose/--debug 输出详细日志；证据 Claude Code CLI |
| low | S | confirmed | CLI: --allowedTools/--disallowedTools | absent — 无工具白/黑名单 CLI 标志 | --allowedTools/--disallowedTools 限制可用工具；证据 Claude Code CLI |
| low | S | confirmed | CLI: --mcp-config | absent — 无 MCP 配置 CLI 标志 | --mcp-config 指定 MCP server 配置；证据 Claude Code CLI |
| low | S | confirmed | CLI: --version | absent — TUI 命令无 --version 标志（-h/--help 有）；版本在横幅显示 | --version 打印版本；证据 Claude Code CLI |
| low | S | confirmed | CLI: --permission-mode | absent — 无 --permission-mode 标志；权限靠 preset 组合和 /permission 命令 | --permission-mode 启动时设权限模式；证据 Claude Code CLI |
| low | S | confirmed | CLI: --append-system-prompt | absent — 无追加系统提示词的 CLI 标志 | --append-system-prompt 追加系统提示词；证据 Claude Code CLI |
| low | L | confirmed | CLI 子命令族：mcp/plugin/auth（launcher 层） | absent — dsh-tui 是 profile bundle，不含 launcher 子命令；MCP/插件/认证管理在 TUI 内也无对应命令 | claude mcp（管理 MCP server）、claude plugin（管理插件/marketplace）、claude auth（登录/状态/登出）；证据 src/main.tsx:3894-3960, 4148-4265, 4100-4131 |


## gap:cc-ui（135 条）

| 严重度 | 工作量 | 验证 | 差距 | 我们的现状 | 参考方行为 |
|---|---|---|---|---|---|
| high | L | confirmed | 审批框内联 diff 预览（文件编辑/写入） | ApprovalDialog 只显示 toolName+reason，4 个固定选项，无 diff 预览 | FileEditPermissionRequest/FileWritePermissionRequest 在审批框内联渲染 FileEditToolDiff，展示 old_string→new_string 的 diff，支持 IDE diff 配置 |
| high | L | confirmed | Bash 命令特定审批选项与破坏性命令警告 | 所有工具共用同一 ApprovalDialog，无命令特定选项、无破坏性命令警告 | BashPermissionRequest 提供命令特定选项、destructiveCommandWarning、sed 编辑检测、sandbox 选项、classifier 自动批准 shimmer |
| high | L | confirmed | /permissions 权限规则管理界面 | 无 /permissions 命令，无规则列表/输入/描述 UI | /permissions 命令打开规则管理界面，含 PermissionRuleList、PermissionRuleInput、PermissionRuleDescription、WorkspaceTab、RecentDenialsTab |
| high | M | confirmed | 状态栏 cost 显示 | 状态栏无 cost 字段，无 /cost 命令 | StatusLine 显示 cost.total_cost_usd = getTotalCost()，/cost 命令展示成本明细 |
| high | M | confirmed | /context 上下文用量可视化 | 状态栏只有 context 百分比，无 /context 命令 | /context 命令展示 ContextVisualization，按 Project/User/Managed/Plugin/Builtin 分组展示 token 用量和上下文窗口占比 |
| medium | L | confirmed | 首次启动 onboarding 向导 | 有 ProviderWizard 但无完整 onboarding 流程，无 TrustDialog | Onboarding 6 步向导：preflight→theme→OAuth→API key→security notes→terminal setup；TrustDialog 在不受信仓库时显示警告 |
| medium | L | confirmed | /agents 子代理管理界面 | 无 /agents 命令 | /agents 命令打开 AgentsMenu（列表+详情+编辑器+颜色选择+模型选择+工具选择+创建向导） |
| medium | L | confirmed | /hooks 配置菜单 | 无 /hooks 命令 | /hooks 命令打开 HooksConfigMenu，含 PromptDialog、SelectEventMode、SelectHookMode、SelectMatcherMode、ViewHookMode 等子对话框 |
| medium | L | confirmed | /tasks 后台任务总览对话框 | 无 /tasks 命令，无后台任务 UI | /tasks 命令打开 BackgroundTasksDialog，列出所有后台任务（shell/agent/remote/dream/teammate/workflow/monitor），支持列表→详情导航 |
| medium | L | confirmed | /diff 变更查看器 | 无 /diff 命令 | /diff 命令打开 DiffDialog，文件列表（DiffFileList）→单文件 diff 详情（DiffDetailView） |
| medium | M | confirmed | Rate limit 专用消息组件 | 无限流专用消息组件 | RateLimitMessage 展示限流错误、retry 倒计时、upsell 选项（/upgrade、/extra-usage） |
| medium | S | confirmed | InterruptedByUser 中断提示 | 只有 'Turn cancelled.' notice | InterruptedByUser 显示 'Interrupted · What should Claude do differently?' 引导用户输入 |
| medium | M | confirmed | FileEditToolUpdated/Rejected 消息 | 工具卡片只有 success/error 两种状态 | FileEditToolUpdatedMessage 展示编辑后的 diff；FileEditToolRejectedMessage 展示被拒绝的 plan |
| low | S | partial | RejectedPlan/RejectedToolUse 消息 | 无 plan 模式，无 rejected plan 消息 | RejectedPlanMessage 展示被拒绝的 plan 内容；RejectedToolUseMessage 显示 'Tool use rejected' |
| low | S | confirmed | Redacted thinking 消息 | 不支持 redacted thinking | AssistantRedactedThinkingMessage 显示 '✻ Thinking…'（redacted 版本） |
| low | S | confirmed | 用户图片消息 | 不支持图片输入 | UserImageMessage 显示 [Image #N] 可点击链接（支持 OSC 8 超链接） |
| medium | S | confirmed | 状态栏 rate limit 显示 | 状态栏无限流字段 | StatusLine 显示 rate_limits.five_hour / seven_day 使用率百分比 |
| low | S | confirmed | 状态栏 vim 模式指示 | 无 vim 模式 | StatusLine 显示 vim.mode = 'INSERT'/'NORMAL' 等 |
| medium | M | confirmed | 消息操作（copy/fork/branch/summarize） | 无消息操作 UI | messageActions.tsx 提供 copyTextOf、forkConversation、branchConversation、summarizeFromHere 等操作 |
| medium | M | confirmed | 选择器模糊匹配 | 选择器只用 substring .includes() 匹配 | FuzzyPicker 支持模糊匹配（fzf 风格），按相关度排序 |
| medium | M | confirmed | 选择器预览面板 | 选择器无预览面板 | FuzzyPicker 支持 renderPreview 回调，展示选中项的详细预览 |
| low | M | confirmed | /bug 和 /feedback 命令 | 无 /bug、/feedback 命令 | /bug 提交 bug 报告；/feedback 提交反馈（含 memory survey、transcript share） |
| low | M | confirmed | /memory 记忆文件选择器 | 无 /memory 命令 | /memory 打开 MemoryFileSelector；记忆更新时显示 MemoryUpdateNotification |
| low | S | confirmed | /init 命令 | 无 /init 命令 | /init 命令生成项目级 CLAUDE.md 配置文件 |
| low | S | fixed@0.2.0 | /compact 手动压缩命令 | 有自动压缩但无 /compact 手动命令 | /compact 命令手动触发上下文压缩，可选择压缩方向和反馈 |
| low | M | confirmed | /usage 用量面板 | 无 /usage 命令 | /usage 打开 Usage tab，展示 LimitBar（5h/7d 限流进度条）和 overage credit |
| low | M | confirmed | /stats 统计图表 | 有 sessionStats 数据但无 /stats 命令 | /stats 展示 asciichart 图表（token 用量、API 时长、成本等） |
| low | S | fixed@0.2.0 | 自动更新器 | 已补：挂载后异步查 npm registry，每天最多一次，发现新版本提示一条 `Update available: … — run: npm install -g …`（`updateCheck` 可关；只提示，不自装） | AutoUpdater 检查更新并提示用户安装 |
| low | S | confirmed | Worktree 退出对话框 | 无 worktree 功能 | WorktreeExitDialog 在退出 worktree 会话时确认 |
| low | S | confirmed | ExitFlow 随机告别语 | 有可配置 goodbyeMessage 但无随机告别 | ExitFlow 显示随机告别语（从列表中选择） |
| low | S | confirmed | InvalidSettingsDialog 设置校验错误 | 无设置校验错误对话框 | InvalidSettingsDialog 显示 ValidationErrors 列表，可继续或退出 |
| low | S | confirmed | BypassPermissionsModeDialog 危险模式确认 | 无 bypass permissions 模式 | BypassPermissionsModeDialog 确认进入危险模式 |
| low | S | confirmed | AutoModeOptInDialog 自动模式确认 | 无 auto 模式 | AutoModeOptInDialog 确认进入 auto 模式 |
| low | S | confirmed | ApproveApiKey API Key 批准 | 有 /login 但无 API key 批准对话框 | ApproveApiKey 检测到新 ANTHROPIC_API_KEY 时显示批准对话框 |
| low | S | confirmed | CostThresholdDialog 成本阈值确认 | 无成本阈值对话框 | CostThresholdDialog 在成本超过阈值时确认 |
| low | S | confirmed | IdleReturnDialog 空闲返回确认 | 无空闲返回确认 | IdleReturnDialog 在空闲后返回会话时确认 |
| low | S | confirmed | ManagedSettingsSecurityDialog 受管设置安全 | 无受管设置 | ManagedSettingsSecurityDialog 显示受管设置中的危险项 |
| low | M | partial | EnterPlanMode/ExitPlanMode 权限请求 | 无 plan 模式 | EnterPlanModePermissionRequest/ExitPlanModePermissionRequest 确认进入/退出 plan 模式 |
| low | S | confirmed | WebFetch/Skill 专用权限请求 | 所有工具共用同一 ApprovalDialog | WebFetchPermissionRequest 显示 URL；SkillPermissionRequest 显示 skill 名 |
| low | S | confirmed | SandboxPermissionRequest sandbox 权限请求 | 有 sandbox 预设但无 sandbox 权限请求 UI | SandboxPermissionRequest 按 hostPattern 请求 sandbox 权限 |
| low | S | confirmed | PermissionExplanation 权限解释 | 审批框只有 reason 文本 | PermissionExplanation/PermissionRuleExplanation 解释为什么需要此权限和匹配的规则 |
| low | S | confirmed | PermissionDecisionDebugInfo 权限决策调试 | 无权限决策调试信息 | PermissionDecisionDebugInfo 显示权限决策的调试信息 |
| low | S | confirmed | WorkerBadge/WorkerPendingPermission worker 权限 | 无 worker 权限请求 UI | WorkerBadge 标识 worker 发起的权限请求；WorkerPendingPermission 展示待处理项 |
| low | S | confirmed | HookProgressMessage hook 进度 | 无 hook 进度消息 | HookProgressMessage 展示 hook 执行进度 |
| low | S | confirmed | AdvisorMessage advisor 消息 | 无 advisor 消息 | AdvisorMessage 展示 advisor 建议 |
| low | S | partial | PlanApprovalMessage plan 审批 | 无 plan 审批消息 | PlanApprovalMessage 展示 plan 内容供用户审批 |
| low | S | confirmed | TaskAssignmentMessage 任务分配 | 无任务分配消息 | TaskAssignmentMessage 展示任务分配内容 |
| low | S | confirmed | ShutdownMessage shutdown 请求 | 无 shutdown 消息 | ShutdownMessage 展示 shutdown 请求 |
| low | S | confirmed | UserChannel/UserTeammate 消息 | 无 channel/teammate 消息 | UserChannelMessage/UserTeammateMessage 展示 channel/teammate 消息 |
| low | S | confirmed | UserCommandMessage 命令回显 | 命令执行后有输出但无命令回显消息 | UserCommandMessage 回显用户输入的 slash command |
| low | S | confirmed | UserBashInput/Output 消息 | 有 terminal 卡片但无用户 bash 输入回显 | UserBashInputMessage 回显 bash 命令；UserBashOutputMessage 展示输出 |
| low | S | partial | UserPlanMessage 用户 plan | 无 plan 消息 | UserPlanMessage 展示用户输入的 plan |
| low | S | confirmed | UserMemoryInputMessage 记忆输入 | 无记忆输入消息 | UserMemoryInputMessage 展示用户输入的记忆内容 |
| low | S | confirmed | UserResourceUpdateMessage 资源更新 | 无资源更新消息 | UserResourceUpdateMessage 展示资源更新 |
| low | S | confirmed | AttachmentMessage 通用附件 | 只有 session-reference 附件 | AttachmentMessage 展示通用附件 |
| low | S | confirmed | GroupedToolUseContent 分组工具调用 | 有 CollapsedGroupComponent 但无分组工具调用 | GroupedToolUseContent 分组展示多个工具调用；teamMemCollapsed 折叠 team memory |
| low | S | confirmed | ToolUseLoader 工具加载指示器 | 有状态 glyph 动画但无专门 loader | ToolUseLoader 展示工具执行中的加载动画 |
| low | S | confirmed | ThinkingToggle thinking 切换 | 有 Ctrl+T 固定 thinking 但无切换组件 | ThinkingToggle 提供 thinking 展开/折叠的 UI 切换 |
| low | S | confirmed | CtrlOToExpand 展开提示 | 有 Ctrl+O 卡片相位循环但无展开提示 | CtrlOToExpand 显示 'Press Ctrl+O to expand' 提示 |
| low | S | confirmed | Spinner 家族（shimmer/glimmer） | 有状态 glyph 淡入/脉冲动画但无 shimmer/glimmer | Spinner 家族：SpinnerGlyph（braille 动画）、FlashingChar、ShimmerChar（字符级 shimmer）、GlimmerMessage、TeammateSpinnerTree |
| low | S | confirmed | useStalledAnimation 停滞动画 | 有 stallTimer 但无 stalled 动画 | useStalledAnimation 在操作超时时显示 stalled 提示 |
| medium | S | fixed@0.2.0 | TokenWarning 上下文警告 | 有 context 百分比但无警告 | TokenWarning 在上下文使用率高时显示警告和升级建议 |
| low | S | confirmed | CompactSummary 压缩摘要 | 有 COMPACTION_MARKER 但无摘要 | CompactSummary 展示压缩后的对话摘要 |
| low | S | confirmed | MemoryUsageIndicator 内存指示器 | 无内存使用指示器 | MemoryUsageIndicator 显示进程内存使用 |
| low | S | ? | FooterSuggestions 输入建议 | 有 autocomplete 但无 footer 建议 | FooterSuggestions 在输入框下方显示上下文建议（文件、MCP 资源、agent） |
| low | S | ? | 上下文动态 placeholder | 有静态 inputPlaceholder | usePromptInputPlaceholder 根据上下文动态生成 placeholder |
| low | S | ? | PromptInputStashNotice stash 提示 | 无 stash 提示 | PromptInputStashNotice 显示 stash 状态 |
| low | S | ? | IssueFlagBanner issue 标记 | 无 issue 标记横幅 | IssueFlagBanner 显示 issue 标记 |
| low | S | ? | ShimmeredInput shimmer 输入框 | 无 shimmer 输入框 | ShimmeredInput 在加载时显示 shimmer 效果 |
| low | S | ? | Vim 模式输入 | 无 vim 模式 | VimTextInput 支持 vim 编辑模式 |
| low | S | ? | /sandbox 设置界面 | 有 sandbox 预设但无 /sandbox 命令 | /sandbox 打开 SandboxSettings，含 Config/Dependencies/Overrides 3 个 tab |
| low | S | ? | /teams 团队对话框 | 无 /teams 命令 | /teams 打开 TeamsDialog 和 TeamStatus |
| low | S | ? | SentryErrorBoundary 错误边界 | 无错误边界 | SentryErrorBoundary 捕获渲染错误并上报 |
| low | S | ? | DevBar 开发调试条 | 无开发调试条 | DevBar 显示开发调试信息 |
| low | S | ? | AwsAuthStatusBox AWS 认证状态 | 无 AWS 认证状态 | AwsAuthStatusBox 显示 AWS 认证状态 |
| low | S | ? | IdeStatusIndicator IDE 状态 | 无 IDE 状态指示器 | IdeStatusIndicator 显示 IDE 连接状态 |
| low | S | ? | DesktopUpsell 桌面版升级 | 无桌面版升级引导 | DesktopUpsell 引导用户使用桌面版 |
| low | S | ? | ChannelDowngradeDialog channel 降级 | 无 channel 降级 | ChannelDowngradeDialog 处理 channel 降级 |
| low | S | ? | PluginHint/LspRecommendation 推荐菜单 | 有 /plugins 面板但无推荐 | PluginHintMenu 推荐插件；LspRecommendationMenu 推荐 LSP 服务器 |
| low | S | ? | EffortCallout/EffortIndicator effort 选择 | 有 reasoning effort 但无 callout | EffortCallout 引导选择 effort 级别；EffortIndicator 显示当前 effort |
| low | S | ? | RemoteCallout 远程模式提示 | 无远程模式 | RemoteCallout 显示远程模式提示 |
| low | S | ? | PressEnterToContinue 继续提示 | 无 PressEnterToContinue 组件 | PressEnterToContinue 显示 'Press Enter to continue…' 等待用户确认 |
| low | S | ? | /add-dir 添加工作区目录 | 无 /add-dir 命令 | /add-dir 命令添加额外工作区目录 |
| low | S | ? | /logout 登出命令 | 有 /login 但无 /logout | /login 登录；/logout 登出 |
| low | S | ? | /upgrade 升级命令 | 无 /upgrade 命令 | /upgrade 升级订阅 |
| low | S | ? | /install 安装命令 | 无 /install 命令 | /install 安装 hooks/skills |
| low | S | ? | /terminal-setup 终端配置 | 无 /terminal-setup 命令 | /terminal-setup 配置终端键位 |
| low | S | ? | Resume 选择器 worktree 分组 | ResumePicker 不按 worktree 分组 | ResumeConversation 按 worktree 分组展示历史会话 |
| low | S | fixed@0.2.0 | ExportDialog 剪贴板导出选项 | /export 只支持文件导出 | ExportDialog 支持 'copy to clipboard' 和 'save to file' 两种方式 |
| low | S | ? | GlobalSearch/QuickOpen 全局搜索 | 有 /search 会话内搜索但无全局搜索 | GlobalSearchDialog 全局搜索；QuickOpenDialog 快速打开 |
| low | S | ? | MessageSelector 消息选择器 | RewindPanel 直接选择 prompt | MessageSelector 选择特定消息进行 rewind/fork |
| low | S | ? | LogSelector 日志选择器 | 无日志选择器 | LogSelector 选择日志文件 |
| low | S | ? | SnapshotUpdate 记忆快照更新 | 无记忆快照更新 | MemoryFileSelector 选择记忆文件；MemoryUpdateNotification 通知更新 |
| low | S | ? | AssistantSessionChooser assistant 会话选择 | 无 assistant 会话选择器 | AssistantSessionChooser 选择 assistant 会话 |
| low | S | ? | NewInstallWizard assistant 安装向导 | 无 assistant 安装向导 | NewInstallWizard 引导安装 assistant |
| low | S | ? | GroveDialog Grove 政策同意 | 无 Grove 对话框 | GroveDialog 处理 Grove 政策同意 |
| low | S | ? | DevChannelsDialog 开发通道 | 无开发通道对话框 | DevChannelsDialog 管理开发通道 |
| low | S | ? | ClaudeMdExternalIncludesDialog 外部引用批准 | 无 CLAUDE.md 外部引用 | ClaudeMdExternalIncludesDialog 批准 CLAUDE.md 的外部引用 |
| low | S | ? | MCP Elicitation 对话框 | 无 MCP elicitation | ElicitationDialog 处理 MCP 服务器的 elicitation 请求 |
| low | S | ? | MCP 重连与解析警告 | 有 /mcp 只读面板但无重连/警告 | MCPReconnect 重连 MCP 服务器；McpParsingWarnings 显示解析警告 |
| low | S | ? | MCP 服务器批准与多选 | 无 MCP 服务器批准 | MCPServerApprovalDialog 批准新 MCP 服务器；MCPServerMultiselectDialog 多选服务器 |
| low | S | ? | MCPDialogCopy MCP 配置复制 | 无 MCP 对话框复制 | MCPDialogCopy 复制 MCP 配置 |
| low | S | ? | BridgeDialog bridge 对话框 | 无 bridge 对话框 | BridgeDialog 处理 bridge 连接 |
| low | S | ? | Teleport 远程会话 | 无 teleport 功能 | TeleportResumeWrapper/TeleportRepoMismatchDialog/TeleportProgress 处理远程会话 |
| low | S | ? | Ultraplan 计划功能 | 无 ultraplan | UltraplanChoiceDialog/UltraplanLaunchDialog 处理 ultraplan |
| low | S | ? | ClaudeInChrome Chrome 集成 | 无 Chrome 集成 | ClaudeInChromeOnboarding 引导 Chrome 集成 |
| low | S | ? | CoordinatorAgent coordinator 状态 | 无 coordinator agent | CoordinatorAgentStatus/BashModeProgress/AgentProgressLine 展示 coordinator 状态 |
| low | S | ? | SessionBackground 会话后台提示 | 无会话后台提示 | SessionBackgroundHint/SessionPreview/ResumeTask 处理后台会话 |
| low | S | ? | SandboxViolation sandbox 违规视图 | 无 sandbox 违规视图 | SandboxViolationExpandedView 展示 sandbox 违规详情 |
| low | S | ? | StatusNotices 状态通知区 | 有键位冲突检测但只在 /help 中显示 | StatusNotices/KeybindingWarnings/DiagnosticsDisplay 在状态栏显示通知 |
| low | S | ? | OffscreenFreeze 离屏冻结 | 用 TranscriptReconciler 全量渲染 | OffscreenFreeze 冻结滚出视口的定时更新内容 |
| low | S | ? | FullscreenLayout 全屏布局（设计选择） | 有意不用 alt screen | FullscreenLayout 使用 alt screen 全屏模式 |
| low | S | ? | VirtualMessageList 虚拟滚动 | 用 TranscriptReconciler 全量渲染 | VirtualMessageList 虚拟滚动长会话 |
| low | S | ? | Sticky prompt 追踪 | 无 sticky prompt 追踪 | VirtualMessageList 的 sticky prompt 追踪 |
| low | S | ? | Unread separator 未读分隔 | 无未读分隔 | FullscreenLayout 的未读分隔 pill |
| low | S | ? | ScrollKeybinding 主 transcript 滚动 | 主 transcript 无滚动（终端自然滚动） | ScrollKeybindingHandler 处理主 transcript 的滚动键位 |
| low | S | ? | Ratchet 高度锁定 | 无 Ratchet 组件 | Ratchet 锁定内容高度，防止布局抖动 |
| low | S | ? | StatusIcon 状态图标 | 无 StatusIcon 组件 | StatusIcon 显示 6 种状态图标（success/error/warning/info/pending/loading） |
| low | S | ? | LoadingState 加载状态 | 有 loading 文本但无专门组件 | LoadingState 显示 spinner + 消息 + 副标题 |
| low | S | ? | KeyboardShortcutHint 快捷键提示 | 有键位提示但分散在各处 | KeyboardShortcutHint 统一显示快捷键提示 |
| low | S | ? | SearchBox 搜索框 | 有搜索输入但无专门组件 | SearchBox 统一搜索输入框 |
| low | S | ? | ListItem 列表项 | 有 SelectList 但无 ListItem | ListItem 显示列表项，支持 focus/selected 状态和描述 |
| low | S | ? | ThemedText/ThemedBox 主题组件 | 有 Palette 但无 ThemedText/ThemedBox | ThemedText/ThemedBox 提供主题化文本/容器 |
| low | S | ? | Tabs 标签页组件 | 无 Tabs 组件 | Tabs 提供标签页切换 |
| low | S | ? | ProgressBar 进度条 | 有 diagnosticMeter 但无 ProgressBar | ProgressBar 显示进度条（9 级精度） |
| low | S | ? | Byline 元数据分隔 | 无 Byline 组件 | Byline 用 · 分隔元数据 |
| low | S | ? | Divider 分隔线 | 无 Divider 组件 | Divider 显示分隔线 |
| low | S | ? | Wizard 通用向导框架 | 有 ProviderWizard 但无通用向导框架 | Wizard 框架提供多步向导的通用结构 |
| low | S | ? | Pane 窗格组件 | 有面板但无 Pane | Pane 显示带彩色顶线的区域 |
| low | S | ? | Dialog 对话框组件 | 有 renderDialog 函数但无 Dialog 组件 | Dialog 提供对话框通用结构 |
| low | S | ? | SelectMulti 多选组件 | 有 QuestionDialog 多选但无 SelectMulti | SelectMulti 提供多选下拉 |
| low | S | ? | FilePathLink 文件路径链接 | 无 FilePathLink | FilePathLink 显示可点击的文件路径 |
| low | S | ? | ClickableImageRef 可点击图片 | 无可点击图片引用 | ClickableImageRef 显示可点击的图片引用 |
| low | S | ? | FastIcon 快速图标 | 无 FastIcon | FastIcon 显示快速图标 |
| low | S | ? | ConfigurableShortcutHint 可配置快捷键 | 有键位提示但不可配置 | ConfigurableShortcutHint 显示可配置的快捷键提示 |


## gap:cc-input（25 条）

| 严重度 | 工作量 | 验证 | 差距 | 我们的现状 | 参考方行为 |
|---|---|---|---|---|---|
| high | M | fixed@0.2.0 | 跨会话历史持久化（history.jsonl） | absent - 历史纯内存（pi-tui Editor 私有 history + HintEditor mirror），进程退出即丢，无跨会话历史 | 历史持久化到 ~/.claude/history.jsonl，最多 100 条，当前会话条目优先于其他会话，支持 removeLastFromHistory 跳过已刷盘条目，粘贴内容超 1024 字符时存到 pasteStore 用 hash 引用。Up/Down 箭头导航时分块加载（每块 10 条）并合并并发磁盘读取 |
| high | L | confirmed | 图片粘贴与拖文件识别 | absent - 剪贴板仅文本（native/tmux/OSC52 三路），无图片粘贴、无图片路径识别、无 [Image #N] 占位符 | 粘贴文本中检测图片文件路径（换行或空格分隔，支持 Unix / 和 Windows C:\ 路径），拖拽多张图片时逐个读取为图片附件；macOS 上 Cmd+V 粘贴图片时终端发送空 bracketed paste，自动检测剪贴板图片并转为图片附件；粘贴的图片在输入框显示为 [Image #N] 占位符。 |
| medium | M | fixed@0.2.0 | 外部编辑器（$EDITOR）编辑输入 | absent - 无外部编辑器功能，Ctrl+G 已绑定为会话消息搜索 | Ctrl+G 或 Ctrl+X Ctrl+E 打开 $EDITOR 编辑当前输入，保存后内容回到输入框；多行输入时底部提示 'edit in <editor>'；编辑前 push undo 快照。 |
| medium | L | confirmed | Ghost text 输入建议（Prompt Suggestion） | absent - 无 ghost text / 内联建议 | 空闲时用 forked agent 预测用户下一步输入（2-12 词），显示为 ghost text，Tab 或 Enter 接受；有严格过滤（拒绝评价/问题/Claude 口吻/多句）；被多种原因抑制（disabled/pending_permission/plan_mode/rate_limit 等）；接受时可触发 |
| medium | M | confirmed | !bash 前缀直接执行 shell 命令 | absent - 无 bash 模式，所有输入都作为 prompt 发给 agent | 输入以 ! 开头时进入 bash 模式，直接在 shell 中执行命令（不经过 agent），输出回显到对话；历史导航按模式过滤（bash 历史只显示 bash 命令）；bash 模式下提供 shell 补全（命令/变量/路径）。 |
| medium | L | confirmed | Vim 编辑模式 | absent - 无 vim 模式 | 输入框支持 vim 模式，INSERT/NORMAL 两种模式，Esc 从 INSERT 切到 NORMAL；NORMAL 下支持完整状态机：count(1-9)、operator(d/c/y)+motion、find(f/F/t/T)、text object(i/a+w/p/s)、replace(r)、indent( |
| medium | S | fixed@0.2.0 | 超长输入自动截断 | absent - 输入不截断，仅 transcript 显示时裁剪（MAX_PROMPT_CHARS=10_000） | 输入超过 10,000 字符时自动截断（中间省略号），截断后光标移到末尾，防止超长输入导致 API 错误。 |
| medium | M | confirmed | 排队消息可编辑（Up 键编辑 queued messages） | absent - 排队的 steering 消息只在取消时（Esc）全部放回编辑器，不支持 Up 键逐条编辑 | 有排队消息时，placeholder 显示 'Press up to edit queued messages'（最多提示 3 次）；Up 箭头可逐条编辑排队中的消息，编辑后可重新提交。 |
| low | S | confirmed | Stash/unstash 暂存输入 | absent - 无 stash 功能 | Ctrl+S 保存当前输入（文本+光标位置+粘贴内容）到 stash，清空输入框；输入框为空时再按 Ctrl+S 恢复 stash 的内容。 |
| low | S | partial | 历史记录中保留粘贴占位符 | partial - pi-tui 有 paste marker（[paste #N +M lines]），但提交时展开为全文存入历史，历史中不保留 marker | 粘贴的长文本在历史记录中保留为 [Pasted text #N +M lines] 占位符，显示时才展开为实际内容，保持历史文件紧凑。 |
| low | S | confirmed | 历史搜索提示（首次导航后） | absent - 无历史搜索提示 | 导航历史 2 条后显示一次 'Ctrl+R search history' 提示通知，每会话一次，帮助用户发现历史搜索功能。 |
| low | S | confirmed | 历史按输入模式过滤 | absent - 无模式过滤（无 bash 模式） | Up/Down 导航历史时按输入模式过滤（prompt/bash），在 bash 模式下只显示 bash 命令历史。 |
| low | S | confirmed | Ctrl+P/Ctrl+N 历史导航 | absent - Ctrl+N 绑定到 plan 展开/折叠，Ctrl+P 未绑定；历史导航仅靠 Up/Down 箭头 | Ctrl+P/Ctrl+N 等价于 Up/Down 导航历史（readline 习惯），在多行内先移动光标，到边界才触发历史。 |
| low | S | confirmed | Ctrl+H 删除前一个词 | absent - pi-tui 无 Ctrl+H 绑定 | Ctrl+H 删除前一个词（deleteTokenBefore）或退格。 |
| low | S | partial | Ctrl+Shift+- 撤销（Kitty 协议） | partial - 仅 Ctrl+-（等同于 Ctrl+_），无 Ctrl+Shift+- | 撤销绑定到 Ctrl+_（传统终端）和 Ctrl+Shift+-（Kitty 协议）两个键。 |
| low | S | confirmed | 撤销栈大小限制 | absent - pi-tui UndoStack 无大小限制，可无限增长 | 撤销栈最多 50 条，debounce 1000ms 合并快速变更，截断 redo 分支。 |
| low | S | confirmed | 新用户示例命令 placeholder | absent - 空闲时无 placeholder，无示例命令 | 新用户（未提交过）空闲时 placeholder 显示一条示例命令（从缓存获取），引导用户上手。 |
| low | S | partial | 上下文感知的 placeholder 提示 | partial - placeholder 仅在运行时显示（'press enter to steer and esc to cancel'），空闲时无任何提示 | placeholder 根据上下文变化：查看 teammate 时显示 'Message @name…'，有排队消息时显示 'Press up to edit queued messages'，新用户显示示例命令。 |
| low | M | confirmed | Slack 频道/成员自动补全 | absent - 无 Slack 补全 | 输入 # 时触发 Slack 频道补全（需 Slack MCP server），输入 @ 时触发 DM 成员补全。 |
| low | M | confirmed | Shell 命令自动补全 | absent - 无 shell 补全 | bash 模式下提供 shell 补全（命令/变量/路径），通过 getShellCompletions 异步获取，AbortController 取消过期请求。 |
| low | S | confirmed | 剪贴板图片提示 | absent - 无剪贴板图片检测 | 终端重新获得焦点且剪贴板有图片时，显示 'Image in clipboard · Ctrl+V to paste' 提示，30 秒冷却。 |
| low | S | confirmed | 空粘贴回退检测剪贴板图片 | absent - pi-tui 不处理空 bracketed paste | macOS 上 Cmd+V 粘贴图片时终端发送空 bracketed paste，自动检测剪贴板图片并转为图片附件；临时截图文件不存在时回退到剪贴板检测。 |
| low | S | confirmed | 粘贴中指示器 | absent - pi-tui 同步处理粘贴，无粘贴中指示器 | 粘贴处理中显示 'Pasting text…' 指示器。 |
| low | S | confirmed | 多行输入时提示外部编辑器 | absent - 无外部编辑器提示 | 多行输入时显示 'Ctrl+G edit in <editor>' 提示（5 秒超时），引导用户使用外部编辑器。 |
| low | S | confirmed | 反斜杠续行使用追踪 | absent - 无追踪 | 追踪用户是否使用过反斜杠+Enter 续行（markBackslashReturnUsed），用于推荐安装 Shift+Enter 键绑定（terminal-setup）。 |


## gap:cc-session（17 条）

| 严重度 | 工作量 | 验证 | 差距 | 我们的现状 | 参考方行为 |
|---|---|---|---|---|---|
| high | M | fixed@0.2.0 | 缺少 /compact 手动压缩命令和 /clear 会话重置语义 | absent (no /compact command; /clear only hides view) | Claude Code has /compact to manually trigger conversation compaction with optional custom summarization instructions, and /clear with subcommands (caches, conve |
| high | M | fixed@0.2.0 | 缺少上下文窗口不足警告和 auto-compact 阈值提示 | absent (no context-low warning UI; only output-token-limit notice) | Claude Code shows 'Context low (X% remaining) · Run /compact to compact & continue' warning when approaching context window, with auto-compact at threshold. War |
| high | L | confirmed | 完全缺少成本(cost)统计与显示 | absent (no cost tracking anywhere) | Claude Code tracks cost per session (cost-tracker.ts), shows total cost + duration at session end, per-model token usage breakdown, and 'costs may be inaccurate |
| medium | M | fixed@0.2.0 | 缺少 /rename 用户自定义会话标题 | absent (title is backend auto-generated, read-only in TUI) | Claude Code /rename sets a user-defined session title (or auto-generates via generateSessionName when no arg). Title shown in /resume picker and terminal title. |
| medium | M | confirmed | 缺少 /branch 显式分叉命令 | absent (fork only via /rewind selecting a past prompt) | Claude Code /branch creates a fork of the conversation at the current point (branch session). Explicit command separate from /rewind. |
| medium | S | fixed@0.2.0 | 缺少 /copy N 复制历史第 N 条回答 | absent (/copy only copies last answer, no N argument) | Claude Code /copy N copies the Nth most recent assistant response to clipboard. |
| medium | S | fixed@0.2.0 | 缺少 /export 到剪贴板选项 | absent (/export only writes to file, no clipboard option) | Claude Code /export exports conversation to file or clipboard. |
| medium | M | confirmed | 缺少 /context 上下文占用可视化 | absent (only meter in /status, no grid visualization) | Claude Code /context visualizes current context usage as a colored grid showing which sections (system prompt, tools, messages, compaction) occupy the window. |
| medium | S | confirmed | 缺少 /effort 命令(仅在模型选择器中可调) | absent (effort only adjustable in model selector dialog) | Claude Code /effort sets reasoning effort level (low/medium/high/max) and prints current level when no arg. |
| low | L | confirmed | 缺少空闲离开(away)摘要 | absent | Claude Code generates a 'while you were away' summary when terminal regains focus after 5+ minutes blur, if a turn was running. Delayed until turn completes. |
| low | M | confirmed | 缺少完成桌面通知 | absent | Claude Code sends desktop notification when request completes and user has been idle 6+ seconds (iTerm2/kitty/ghostty/terminal_bell channels). |
| low | M | confirmed | 缺少 --fork CLI 标志 | absent (no --fork flag in startup.ts) | Claude Code --fork flag starts a forked session from the current conversation state. |
| low | L | confirmed | 缺少 /stats 跨会话用量统计 | absent | Claude Code /stats shows cross-session usage statistics (total cost, tokens, sessions). |
| low | S | confirmed | 缺少 /tag 会话标签 | absent | Claude Code /tag toggles a searchable tag on the current session, used for filtering in /resume. |
| low | M | confirmed | /rewind UI 细节:无文件 diff 预览和检查点元数据 | present but simpler (prompt list only, no file diff preview, no checkpoint metadata) | Claude Code /rewind shows checkpoints with file diff previews, can restore both code and conversation to a prior point. UI shows what changed at each checkpoint |
| low | S | confirmed | 历史导航后缺少 Ctrl+R 搜索提示 | absent (no hint after history navigation) | Claude Code shows a one-time 'Ctrl+R to search history' notification after user navigates history with Up/Down twice. |
| low | M | confirmed | steer 队列缺少优先级(now/next/later) | present but simpler (FIFO queue with count badge, no priority levels) | Claude Code prompt queue supports priority levels: 'now' (interrupt current), 'next' (queue after current), 'later' (queue lowest). Queue shown with priority in |


## gap:cc-approval（14 条）

| 严重度 | 工作量 | 验证 | 差距 | 我们的现状 | 参考方行为 |
|---|---|---|---|---|---|
| high | L | confirmed | 无 /permissions 规则管理界面（规则列表/增删/来源/最近拒绝重试） | absent — 没有任何权限规则管理界面；sessionApprovals 是只写 Set，用户无法查看或撤销 | Claude Code 有 /permissions 命令，打开全屏管理界面，5 个 tab：recent（最近拒绝+重试）、allow、ask、deny、workspace（工作目录管理）。支持规则列表、添加规则（AddPermissionRules）、删除规则（RuleDetails 删除流程）、查看规则来源（us |
| high | M | confirmed | '不再询问'授权仅本会话内存有效，重启/resume 后丢失 | sessionApprovals 是进程内 Set<string>，不日志、不持久化；重启/resume/换客户端全部重新问 | Claude Code 的 'Yes, and don't ask again for [tool] commands in this project' 把规则持久化到 localSettings（项目级 settings.json），重启后仍然生效。FallbackPermissionRequest 的 yes-do |
| high | L | confirmed | 审批对话框无'允许命令前缀'选项（Bash prefix rule） | absent — 审批对话框只有'允许一次/本会话不再问（按工具名）'，无命令前缀选项 | Claude Code 的 Bash 审批对话框提供 'Yes, and don't ask again for' 可编辑前缀输入（如 npm run:*），以及 'Yes, and apply suggestions'（Haiku 生成的前缀规则+Read 规则+目录建议）。bashToolUseOptions.ts |
| high | M | confirmed | 切换到 danger-full-access 无危险操作确认对话框 | danger-full-access 是 /permission 静默切换，无任何确认对话框；Shift+Tab 有意不包含它（需手打命令），但命令本身无警告 | Claude Code 在进入 bypassPermissions 模式时弹 WARNING 对话框：'In Bypass Permissions mode, Claude Code will not ask for your approval before running potentially dangerous  |
| medium | L | confirmed | 无 deny 规则（硬屏蔽工具/命令） | absent — 无 deny 规则概念 | Claude Code 支持 permissions.deny 规则列表，在 settings.json 中配置，匹配的工具调用直接拒绝不询问。PermissionRule.ts 定义 'deny' behavior，/permissions 界面有 deny tab 管理。 |
| medium | M | confirmed | Plan 审批（exit_plan_mode）无专用呈现，仅渲染为通用问题对话框 | plan-review 渲染为通用 QuestionDialog（plan 作为 detail 文本显示），无专用 plan 审批 UI，无执行模式选择 | Claude Code 的 ExitPlanModePermissionRequest 是专用对话框：展示 plan 内容，提供多种执行模式选项（yes-bypass-permissions / yes-accept-edits / yes-default-keep-context / yes-accept-edits |
| low | S | confirmed | 审批对话框无规则匹配解释（Ctrl+E）和调试信息（Ctrl+D） | 审批对话框只显示 asker 提供的 reason 文本，无规则匹配解释，无调试信息切换 | Claude Code 审批对话框中 Ctrl+E 切换 PermissionRuleExplanation（显示哪条规则匹配导致询问，如 'Matched rule: Bash(npm:*)'），Ctrl+D 切换 PermissionDecisionDebugInfo（决策调试信息）。 |
| low | S | confirmed | 审批对话框内无法用 Shift+Tab 循环权限模式 | Shift+Tab 只在主输入框循环模式；审批对话框打开时按键被对话框吞掉，无法切换模式 | Claude Code 审批对话框中 Shift+Tab（confirm:cycleMode）可直接循环权限模式（default/acceptEdits/plan/bypassPermissions），无需关闭对话框。 |
| low | S | confirmed | 批准时无法附加反馈（'Yes, and tell Claude what to do next'） | 只有拒绝时可附反馈（reject-with-feedback 行）；批准时无法附言 | Claude Code 审批对话框中 Tab 可在选项上展开输入框，允许在批准时附加反馈（'Yes, and tell Claude what to do next'）。PermissionPrompt.tsx 的 acceptFeedback 状态和 feedbackConfig.type='accept' 支持此功 |
| low | S | confirmed | 审批对话框无 Tab/Space 导航和 per-option 可定制快捷键 | 只有 Up/Down 导航 + 1-4 直答 + Enter 确认；无 Tab 切字段、无 Space 切换 | Claude Code 审批对话框支持 Tab（confirm:nextField 切换字段/展开反馈输入）、Space（confirm:toggle 切换选项）、以及可自定义的 per-option keybinding（PermissionPrompt 的 keybindingHandlers）。 |
| medium | M | confirmed | 无 /add-dir 命令（扩展权限范围到额外工作目录） | absent — 无 /add-dir 命令，无 additionalDirectories 概念 | Claude Code 有 /add-dir 命令，将额外目录加入会话的允许工具访问根（permissions.additionalDirectories）。/permissions 的 workspace tab 也可管理。add-dir.tsx 验证目录后写入 addDirectories permission u |
| low | S | confirmed | 审批对话框无风险等级指示（LOW/MED/HIGH） | 无风险等级指示 | Claude Code 的 PermissionExplanation 组件显示风险等级（LOW/MED/HIGH），带颜色编码（绿/黄/红），由 permissionExplainer 生成。 |
| low | S | confirmed | /config 面板无默认权限模式设置行 | /config 面板无权限模式行；/status 只读显示当前 preset；无法在 TUI 中设置默认 permission preset | Claude Code 支持 permissions.defaultMode 设置（default/acceptEdits/plan/bypassPermissions），新会话自动使用该模式。 |
| low | S | confirmed | 无最近拒绝历史查看与重试 | absent — 无拒绝历史记录 | Claude Code /permissions 的 recent tab 列出最近被拒绝的命令，提供重试按钮（onRetryDenials 把被拒命令重新发给模型执行）。 |


## gap:cc-polish（30 条）

| 严重度 | 工作量 | 验证 | 差距 | 我们的现状 | 参考方行为 |
|---|---|---|---|---|---|
| medium | S | fixed@0.2.0 | Session rename command | Session titles are read-only from backend events; no /rename command exists. Users cannot manually rename sessions. | Claude Code has /rename command to rename sessions |
| medium | S | fixed@0.2.0 | Manual compaction trigger | Only auto-compaction exists; no /compact command for manual context compaction. | Claude Code has /compact command for manual context compaction |
| medium | M | confirmed | Memory file management | No /memory command or memory file system for persistent project knowledge across sessions. | Claude Code has /memory command and CLAUDE.md memory files |
| low | S | confirmed | Feedback command | No /feedback command for users to submit feedback. | Claude Code has /feedback command |
| low | M | confirmed | Diff viewer command | Diff rendering exists inline but no dedicated /diff command or viewer. | Claude Code has /diff command |
| medium | L | confirmed | Background task management | No background task system; users cannot run tasks in background. | Claude Code supports background tasks with /tasks command |
| medium | L | confirmed | User-configurable hooks | No user-configurable hooks system; only internal lifecycle hooks exist. | Claude Code has comprehensive hooks system |
| low | M | confirmed | Vim editing mode | No vim mode; only basic emacs-style keybindings. | Claude Code has vim mode support |
| low | S | confirmed | Undo/redo for input | No proper undo/redo; only basic kill ring exists. | Claude Code has proper undo/redo |
| low | S | partial | Output token limit warnings | Only input token limit warnings; no output token limit warnings. | Claude Code warns about both input and output token limits |
| low | L | confirmed | IDE integration | No IDE integration (VS Code, JetBrains). | Claude Code has VS Code and JetBrains extensions |
| low | S | confirmed | Project initialization | No /init command for project setup. | Claude Code has /init command |
| low | M | confirmed | Transcript sharing | No share functionality; only local export to file. | Claude Code has transcript sharing via URL |
| low | M | confirmed | Model comparison | No side-by-side model comparison feature. | Claude Code has model comparison features |
| low | M | partial | Custom slash commands | No custom command support; users cannot define their own slash commands. | Claude Code supports custom slash commands |
| low | M | confirmed | Session templates | No session templates for quick session creation. | Claude Code has session templates |
| low | L | confirmed | Scheduled tasks | No cron/scheduled task support. | Claude Code has scheduled task support |
| low | L | confirmed | Webhook support | No webhook integration for event notifications. | Claude Code has webhook support |
| medium | M | confirmed | Cost budget limits | No cost budget configuration; users cannot set spending limits. | Claude Code has cost budget limits |
| low | S | confirmed | Rate limit display | No rate limit information display in UI. | Claude Code displays rate limit info |
| medium | L | confirmed | Multi-session view | No multi-session support; only single session at a time. | Claude Code has multi-session support |
| medium | M | confirmed | Message editing | No ability to edit previous messages and resubmit. | Claude Code allows message editing |
| low | M | confirmed | Token usage breakdown by tool | No per-tool token usage breakdown in status. | Claude Code has per-tool token breakdown |
| low | M | confirmed | Custom status line | No customizable status line; users cannot configure displayed info. | Claude Code has customizable status line |
| low | L | confirmed | Plugin marketplace | No plugin marketplace; users must manually install plugins. | Claude Code has plugin marketplace |
| low | L | confirmed | Skill marketplace | No skill marketplace; users must manually create skills. | Claude Code has skill marketplace |
| low | L | confirmed | Agent marketplace | No agent marketplace; users must manually configure agents. | Claude Code has agent marketplace |

