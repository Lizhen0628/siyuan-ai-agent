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

export type AgentApi = "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";

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
    thinkingLevel: ThinkingLevel;
    /** 技能开关:内置技能默认启用(记录被禁用的),用户技能默认关闭(记录被启用的) */
    skills: {builtinDisabled: string[]; userEnabled: string[]};
    /** 能力(工具)管理:禁用的工具名 + 写工具的批准方式 */
    capabilities: {disabled: string[]; approval: Record<string, "follow" | "always" | "auto">};
    /** 联网搜索的首选引擎(失败时自动尝试其他引擎) */
    searchEngine: SearchEngine;
}

export type SearchEngine = "duckduckgo" | "bing" | "baidu" | "google";

export const DEFAULT_SYSTEM_PROMPT = `你是思源笔记中的智能体助手,可以借助工具对当前用户的笔记库进行检索、阅读和编辑。

工作准则:
- 涉及笔记内容的问题,先用 search_notes 检索,再 read_note 阅读,不要凭空编造笔记内容。
- 需要联网获取信息时,先用 web_search 搜索关键词找到相关链接,再用 web_fetch 抓取页面正文细读;把外部资料整理进笔记时注明来源链接。
- 创建/修改笔记前,先用 list_notebooks 确认笔记本 id;写操作会向用户请求确认,被拒绝时不要重试,改为询问用户意图。
- 引用笔记内容时注明来源路径(hpath)。
- 回答使用简体中文,输出使用 Markdown;列表/标题层级清晰,不要输出嵌套代码块包裹的普通文本。`;

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
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
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
    thinkingLevels: ThinkingLevel[];
} {
    const active = resolveActiveModel(cfg);
    const catalog = findCatalogModel(cfg.provider, active.id);
    const levels: ThinkingLevel[] = ["off", "low", "medium", "high"];
    const map = catalog?.thinkingLevelMap;
    if (map && "minimal" in map) {
        levels.splice(1, 0, "minimal");
    }
    if (map && "xhigh" in map) {
        levels.push("xhigh");
    }
    return {
        reasoning: catalog?.reasoning ?? false,
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
        provider: cfg.provider === "custom" ? "siyuan-agent" : cfg.provider,
        baseUrl: cfg.baseURL.trim().replace(/\/+$/, ""),
        reasoning: catalog?.reasoning ?? false,
        input: catalog?.input ?? ["text"],
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
        return (custom || DEFAULT_SYSTEM_PROMPT) + skillsPromptSection(this.cfgProvider());
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

    /** 创建(或按需恢复)智能体实例。 */
    private ensureAgent(): Agent {
        const cfg = this.cfgProvider();
        const model = buildModel(cfg);
        // 仅对支持推理的模型下发思考等级,避免不支持的接口报错
        const thinking = model.reasoning ? (cfg.thinkingLevel ?? "off") : "off";
        if (this.agent) {
            // 配置可能已变化,重建模型对象但保留会话记录
            this.agent.state.model = model;
            this.agent.state.thinkingLevel = thinking;
            this.agent.state.tools = this.buildTools();
            this.agent.state.systemPrompt = this.systemPrompt();
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
                    return {block: true, reason: "用户拒绝了本次写操作。请询问用户应如何处理,不要自动重试。"};
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
