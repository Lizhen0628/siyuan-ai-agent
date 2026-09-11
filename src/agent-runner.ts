/**
 * pi 智能体运行器：组装 pi 的 Agent 循环(模型、工具、系统提示词),
 * 提供发送/停止/新会话能力,并把事件透传给 UI。
 */
import {Agent} from "@mariozechner/pi-agent-core";
import type {AgentEvent, AgentMessage, AgentTool, ThinkingLevel} from "@mariozechner/pi-agent-core";
import type {Api, ImageContent, Model} from "@mariozechner/pi-ai";
import type {App} from "siyuan";
import {SiYuanClient} from "./siyuan-client";
import {findCatalogModel} from "./provider-catalog";
import {skillsPromptSection} from "./skills";
import {WRITE_TOOLS, createSiyuanTools} from "./tools";
import {isZh, t} from "./i18n";

export type AgentApi = "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";

/**
 * pi-agent-core 0.73 的 ThinkingLevel 尚未包含 max(新版 pi CLI 已扩展),
 * 本地补齐为完整等级集:off / minimal / low / medium / high / xhigh / max。
 */
export type AgentThinkingLevel = ThinkingLevel | "max";

/** 全部思考等级(对齐 pi CLI 的 EXTENDED_THINKING_LEVELS 顺序)。 */
const ALL_THINKING_LEVELS: AgentThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** 单个模型配置(参考思源原生 设置-人工智能-API 提供商-模型设置)。 */
export interface AgentModelEntry {
    /** 模型 id,如 glm-5.3-flash */
    id: string;
    /** 可选显示名,展示在对话面板的模型切换器中 */
    displayName?: string;
    enabled: boolean;
    /** 该模型的上下文窗口,留空用全局默认 */
    contextWindow?: number;
}

export interface AgentPluginConfig {
    /** pi 目录中的服务商 id,"custom" 表示自定义接口 */
    provider: string;
    /** OpenAI 兼容等接口的 Base URL,如 https://api.example.com/v1 */
    baseURL: string;
    apiKey: string;
    /** 模型列表(可多个) */
    models: AgentModelEntry[];
    /** 对话当前使用的模型 id,由对话面板的模型切换器修改 */
    activeModelId: string;
    /** pi 协议适配器 */
    api: AgentApi;
    /** 全局默认上下文窗口(模型未单独设置时兜底) */
    contextWindow: number;
    maxTokens: number;
    /** 写操作工具是否需要逐次确认 */
    confirmWrites: boolean;
    /** 自定义系统提示词,留空使用默认 */
    systemPrompt: string;
    /** 思考等级(仅对支持推理的模型生效),off 关闭 */
    thinkingLevel: AgentThinkingLevel;
    /** 技能开关:内置技能默认启用(记录被禁用的),用户技能默认关闭(记录被启用的) */
    skills: {builtinDisabled: string[]; userEnabled: string[]};
    /** 能力(工具)管理:禁用的工具名 + 写工具的批准方式 */
    capabilities: {disabled: string[]; approval: Record<string, "follow" | "always" | "auto">};
    /** 联网搜索的首选引擎(失败时自动尝试其他引擎) */
    searchEngine: SearchEngine;
}

export type SearchEngine = "duckduckgo" | "bing" | "baidu" | "google";

/** 引用格式说明:对齐原生智能体——对话中提及笔记用 siyuan:// 链接(渲染为可点击/可悬停预览的引用)。 */
const CITATION_PROMPT_LINE = "- 提及可打开的文档/块时,把标题文本直接写成 Markdown 链接 [标题](siyuan://blocks/块id),如:详见 [第七章 大模型应用](siyuan://blocks/20240101120000-abcdefg) 的介绍;不要在原文旁边再用括号重复一份带链接的文本。块 id 必须来自工具调用结果(如 search_notes 的 block_id/root_id),严禁编造;不要输出 (hpath: ...) 之类的纯文本标注。";
/** 旧版引用说明(纯文本 hpath 标注 / 块引用语法 / 未禁止括号重复的链接格式),迁移时定向替换为新版。 */
const LEGACY_CITATION_PROMPT_LINES = [
    "- 引用笔记内容时注明来源路径(hpath)。",
    "- 引用笔记内容时使用思源块引用语法 ((块id '标题')),如 ((20240101120000-abcdefg '第七章 大模型应用')),块 id 见工具结果中的 block_id/root_id;该语法在对话中会渲染为可点击、可悬停预览的引用,不要输出 (hpath: ...) 之类的纯文本标注。",
    "- 提及可打开的文档/块时使用 Markdown 链接 [标题](siyuan://blocks/块id),块 id 必须来自工具调用结果(如 search_notes 的 block_id/root_id),严禁编造;该链接在对话中会渲染为可点击、可悬停预览的引用,不要输出 (hpath: ...) 之类的纯文本标注。",
];

export const DEFAULT_SYSTEM_PROMPT = `你是思源笔记中的智能体助手,可以借助工具对当前用户的笔记库进行检索、阅读和编辑。

工作准则:
- 涉及笔记内容的问题,先用 search_notes 检索,再 read_note 阅读,不要凭空编造笔记内容。
- 涉及数据库(属性视图)的问题,先用 list_databases / get_database / query_database 定位结构与行,再按行/列操作;行的 row_id 来自 query_database。
- 需要联网获取信息时,先用 web_search 搜索关键词找到相关链接,再用 web_fetch 抓取页面正文细读;把外部资料整理进笔记时注明来源链接。
- 创建/修改笔记前,先用 list_notebooks 确认笔记本 id;写操作会向用户请求确认,被拒绝时不要重试,改为询问用户意图。
${CITATION_PROMPT_LINE}
- 回答使用简体中文,输出使用 Markdown;列表/标题层级清晰,不要输出嵌套代码块包裹的普通文本。`;

/** 英文默认系统提示词(思源界面语言为英文时使用)。 */
const CITATION_PROMPT_LINE_EN = "- When mentioning an openable document/block, write the title directly as a Markdown link [title](siyuan://blocks/blockid), e.g. see the introduction of [Chapter 7 LLM Applications](siyuan://blocks/20240101120000-abcdefg); do not repeat the linked text in parentheses next to the original. Block ids must come from tool call results (e.g. block_id/root_id from search_notes); never make them up; do not output plain-text annotations like (hpath: ...).";

const DEFAULT_SYSTEM_PROMPT_EN = `You are an agent assistant inside SiYuan Notes, able to search, read and edit the user's notebook with tools.

Working rules:
- For questions about note content, search with search_notes first, then read with read_note; never fabricate note content.
- For questions about databases (attribute views), locate the structure and rows with list_databases / get_database / query_database first, then operate by row/column; row_id comes from query_database.
- When information from the internet is needed, search with web_search to find relevant links, then read the page content with web_fetch; cite source links when incorporating external material into notes.
- Before creating/modifying notes, confirm the notebook id with list_notebooks; write operations ask the user for confirmation — if rejected, do not retry, ask the user how to proceed instead.
${CITATION_PROMPT_LINE_EN}
- Reply in English and output Markdown; keep list/heading hierarchy clear; do not wrap plain text in nested code blocks.`;

/** 跟随界面语言的默认系统提示词。 */
export function defaultSystemPrompt(): string {
    return isZh() ? DEFAULT_SYSTEM_PROMPT : DEFAULT_SYSTEM_PROMPT_EN;
}

export const DEFAULT_CONFIG: AgentPluginConfig = {
    provider: "custom",
    baseURL: "https://api.openai.com/v1",
    apiKey: "",
    models: [],
    activeModelId: "",
    api: "openai-completions",
    contextWindow: 128000,
    maxTokens: 8192,
    confirmWrites: true,
    // 留空:运行时按界面语言取默认提示词(defaultSystemPrompt)
    systemPrompt: "",
    thinkingLevel: "off",
    skills: {builtinDisabled: [], userEnabled: []},
    capabilities: {disabled: [], approval: {}},
    searchEngine: "duckduckgo",
};

/** 旧版单模型配置(modelId)迁移为多模型列表,并修正悬空的活跃模型。 */
export function migrateConfig(raw: Partial<AgentPluginConfig> & {modelId?: string}): AgentPluginConfig {
    const cfg = {...DEFAULT_CONFIG, ...raw};
    if (!Array.isArray(raw.models)) {
        cfg.models = raw.modelId ? [{id: raw.modelId, enabled: true}] : [];
        cfg.activeModelId = raw.modelId ?? "";
    }
    cfg.models = cfg.models.filter((m) => m?.id);
    if (!cfg.models.some((m) => m.id === cfg.activeModelId && m.enabled)) {
        cfg.activeModelId = cfg.models.find((m) => m.enabled)?.id ?? "";
    }
    // 旧配置可能缺少后加的嵌套对象
    cfg.skills = {builtinDisabled: [], userEnabled: [], ...(raw.skills ?? {})};
    cfg.capabilities = {disabled: [], approval: {}, ...(raw.capabilities ?? {})};
    // 旧默认提示词未包含联网说明时升级到新版(自定义提示词不受影响)
    if (cfg.systemPrompt.includes("引用笔记内容时注明来源路径") && !cfg.systemPrompt.includes("web_search")) {
        cfg.systemPrompt = DEFAULT_SYSTEM_PROMPT;
    }
    // 引用说明升级为原生智能体的 siyuan:// 链接格式(定向替换该行,自定义提示词的其他内容不受影响)
    for (const legacy of LEGACY_CITATION_PROMPT_LINES) {
        if (cfg.systemPrompt.includes(legacy)) {
            cfg.systemPrompt = cfg.systemPrompt.replace(legacy, CITATION_PROMPT_LINE);
            break;
        }
    }
    if (!cfg.searchEngine) {
        cfg.searchEngine = "duckduckgo";
    }
    return cfg;
}

/** 当前生效模型:活跃且启用,否则回退到第一个启用的模型。 */
export function resolveActiveModel(cfg: AgentPluginConfig): {id: string; contextWindow: number; maxTokens: number} {
    const enabled = cfg.models.filter((m) => m.enabled && m.id);
    const entry = enabled.find((m) => m.id === cfg.activeModelId) ?? enabled[0];
    return {
        id: entry?.id ?? "",
        contextWindow: entry?.contextWindow || cfg.contextWindow,
        maxTokens: cfg.maxTokens,
    };
}

export const STORAGE_CONFIG = "agent-config";
export const STORAGE_SESSION = "agent-session";

/** 当前生效模型的能力:是否支持推理/图片输入,以及可选的思考等级。 */
export function modelCapabilities(cfg: AgentPluginConfig): {
    reasoning: boolean;
    image: boolean;
    thinkingLevels: AgentThinkingLevel[];
} {
    const active = resolveActiveModel(cfg);
    const catalog = findCatalogModel(cfg.provider, active.id);
    // 对齐 pi CLI getSupportedThinkingLevels:目录 map 中 null 表示该等级不支持;
    // xhigh/max 仅在目录显式映射时给出;未知(自定义)模型没有 map,全量放开由服务商自行兜底
    const map = catalog?.thinkingLevelMap as Partial<Record<AgentThinkingLevel, string | null>> | undefined;
    const levels = ALL_THINKING_LEVELS.filter((lv) => {
        if (map?.[lv] === null) {
            return false;
        }
        if (map && (lv === "xhigh" || lv === "max")) {
            return lv in map;
        }
        return true;
    });
    return {
        // 未知(自定义)模型默认放行思考,由服务商自行兜底(与图片输入策略一致);
        // 否则自定义服务商模型会被双重门控(本插件 + pi-ai)永久锁死思考参数
        reasoning: catalog?.reasoning ?? true,
        // 未知(自定义)模型默认放行图片,由服务商自行兜底
        image: catalog ? catalog.input.includes("image") : true,
        thinkingLevels: levels,
    };
}

/** 构造 pi 模型对象:命中 pi 目录时继承 cost/上下文等元数据,再以用户配置覆盖。 */
export function buildModel(cfg: AgentPluginConfig): Model<Api> {
    const active = resolveActiveModel(cfg);
    const catalog = findCatalogModel(cfg.provider, active.id);
    return {
        id: active.id,
        name: catalog?.name ?? active.id,
        api: cfg.api,
        provider: cfg.provider === "custom" ? "siyuan-ai-agent" : cfg.provider,
        baseUrl: cfg.baseURL.trim().replace(/\/+$/, ""),
        // 未知(自定义)模型默认放行思考,由服务商自行兜底;详见 modelCapabilities
        reasoning: catalog?.reasoning ?? true,
        // 未知(自定义)模型默认放行图片,与 modelCapabilities 一致;
        // 否则 pi-ai 的 transformMessages 会把图片块降级成 "(image omitted: model does not support images)" 占位文本
        input: catalog?.input ?? ["text", "image"],
        cost: catalog?.cost ?? {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
        contextWindow: active.contextWindow,
        maxTokens: active.maxTokens,
        ...(catalog?.thinkingLevelMap ? {thinkingLevelMap: catalog.thinkingLevelMap} : {}),
    };
}

export class AgentRunner {
    private agent: Agent | null = null;
    private readonly client: SiYuanClient;
    private sessionRestored = false;

    private systemPrompt(): string {
        const custom = this.cfgProvider().systemPrompt?.trim();
        return (custom || defaultSystemPrompt()) + skillsPromptSection(this.cfgProvider());
    }

    constructor(
        private cfgProvider: () => AgentPluginConfig,
        /** 写操作确认: resolve(true) 放行,resolve(false) 拒绝。 */
        private readonly confirmWrite: (toolName: string, label: string, args: unknown) => Promise<boolean>,
        private readonly onEvent: (event: AgentEvent) => void,
        private readonly onSessionChange: () => void,
        /** 思源 App 实例(前端能力需要)。 */
        private readonly app?: App,
    ) {
        this.client = new SiYuanClient();
    }

    /** 是否已有(可能从磁盘恢复的)会话。 */
    get hasSession(): boolean {
        return this.agent !== null && this.agent.state.messages.length > 0;
    }

    get isStreaming(): boolean {
        return this.agent?.state.isStreaming ?? false;
    }

    get messages(): AgentMessage[] {
        if (this.agent) {
            return this.agent.state.messages;
        }
        return this.pendingRestore ?? [];
    }

    /** 流式期间进行中的 assistant 消息(pi 在 message_end 时才并入 messages)。 */
    get streamingMessage(): AgentMessage | undefined {
        return this.agent?.state.streamingMessage;
    }

    get errorMessage(): string | undefined {
        return this.agent?.state.errorMessage;
    }

    /** 当前模型(供面板读取 contextWindow 等元信息);未初始化时按配置临时构建。 */
    get model(): Model<Api> | undefined {
        if (this.agent?.state.model) {
            return this.agent.state.model;
        }
        try {
            return buildModel(this.cfgProvider());
        } catch {
            return undefined;
        }
    }

    /** 调试:在控制台打印本轮请求实际携带的思考参数,便于验证思考强度是否生效。 */
    private attachPayloadDebug(agent: Agent, thinking: ThinkingLevel): void {
        agent.onPayload = (payload: unknown) => {
            const p = payload as Record<string, unknown>;
            const sent = p.reasoning_effort ?? (p.thinking as {type?: string} | undefined)?.type
                ?? (p.reasoning as {effort?: string} | undefined)?.effort ?? "(none)";
            console.debug(`[siyuan-ai-agent] thinking=${thinking}, wire param=`, sent);
        };
    }

    /** 创建(或按需恢复)智能体实例。 */
    private ensureAgent(): Agent {
        const cfg = this.cfgProvider();
        const model = buildModel(cfg);
        // 仅对支持推理的模型下发思考等级,避免不支持的接口报错;
        // 未知(自定义)模型 buildModel 已默认放行,由服务商自行兜底
        // pi-agent-core 0.73 的类型不含 max,这里按字符串透传,由服务商端自行处理
        const thinking = (model.reasoning ? (cfg.thinkingLevel ?? "off") : "off") as ThinkingLevel;
        if (this.agent) {
            // 配置可能已变化,重建模型对象但保留会话记录
            this.agent.state.model = model;
            this.agent.state.thinkingLevel = thinking;
            this.agent.state.tools = this.buildTools();
            this.agent.state.systemPrompt = this.systemPrompt();
            this.attachPayloadDebug(this.agent, thinking);
            return this.agent;
        }
        this.agent = new Agent({
            initialState: {
                systemPrompt: this.systemPrompt(),
                model,
                tools: this.buildTools(),
                messages: this.pendingRestore ?? [],
                thinkingLevel: thinking,
            },
            getApiKey: () => this.cfgProvider().apiKey,
            toolExecution: "sequential",
            beforeToolCall: async (ctx) => {
                const cfg = this.cfgProvider();
                if (!(WRITE_TOOLS as readonly string[]).includes(ctx.toolCall.name)) {
                    return undefined;
                }
                // 能力页的分级批准:auto 直接放行;always 每次确认;follow 跟随全局开关
                const approval = cfg.capabilities?.approval?.[ctx.toolCall.name] ?? "follow";
                const needConfirm = approval === "always" || (approval === "follow" && cfg.confirmWrites);
                if (!needConfirm) {
                    return undefined;
                }
                const tool = ctx.context.tools?.find((t) => t.name === ctx.toolCall.name);
                const allowed = await this.confirmWrite(ctx.toolCall.name, tool?.label ?? ctx.toolCall.name, ctx.args);
                if (!allowed) {
                    return {block: true, reason: t("writeRejected")};
                }
                return undefined;
            },
        });
        this.agent.subscribe((event) => {
            this.onEvent(event);
            if (event.type === "agent_end" || event.type === "turn_end") {
                this.onSessionChange();
            }
        });
        this.attachPayloadDebug(this.agent, thinking);
        // 恢复后清空暂存,避免重复
        this.pendingRestore = undefined;
        this.sessionRestored = true;
        return this.agent;
    }

    private pendingRestore: AgentMessage[] | undefined;

    private buildTools(): AgentTool<any>[] {
        const cfg = this.cfgProvider();
        const disabled = new Set(cfg.capabilities?.disabled ?? []);
        return createSiyuanTools(this.client, this.app, {searchEngine: cfg.searchEngine})
            .filter((t) => !disabled.has(t.name));
    }

    /** 从磁盘恢复的会话消息,在下一次 ensureAgent 时注入。 */
    scheduleRestore(messages: AgentMessage[]): void {
        if (this.sessionRestored || this.agent) {
            return;
        }
        this.pendingRestore = messages;
    }

    /**
     * 编辑重发的第一步:截断指定下标起的会话(该下标应为一条用户消息)。
     * 若正在生成,先中止并等待收尾再截断,避免后续 prompt 与进行中的运行冲突。
     * 截断后调用方应重绘会话,再以新内容调用 send()。
     */
    async truncateFrom(index: number): Promise<boolean> {
        const agent = this.ensureAgent();
        if (agent.state.messages[index]?.role !== "user") {
            return false;
        }
        if (agent.state.isStreaming) {
            agent.abort();
            await agent.waitForIdle();
        }
        agent.clearAllQueues();
        // 中止期间可能追加了未完成的部分消息,重新读取后再截断
        agent.state.messages = agent.state.messages.slice(0, index);
        this.onSessionChange();
        return true;
    }

    async send(text: string, images?: ImageContent[]): Promise<void> {
        const agent = this.ensureAgent();
        await agent.prompt(text, images && images.length > 0 ? images : undefined);
    }

    stop(): void {
        this.agent?.abort();
    }

    /** 开启全新会话(丢弃当前记录)。 */
    reset(): void {
        this.agent = null;
        this.pendingRestore = undefined;
        // 立即用最新配置重建,保证 UI 拿到空记录
        this.ensureAgent();
        this.onSessionChange();
    }

    serializeSession(): AgentMessage[] {
        return this.agent ? JSON.parse(JSON.stringify(this.agent.state.messages)) : [];
    }

    /** 载入一段历史会话(替换当前记录),并通知会话已变化。 */
    loadMessages(messages: AgentMessage[]): void {
        this.agent = null;
        this.pendingRestore = messages;
        this.sessionRestored = false;
        this.ensureAgent();
        this.onSessionChange();
    }
}
