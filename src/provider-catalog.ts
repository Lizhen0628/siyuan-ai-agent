/**
 * pi 内置服务商目录的包装:为设置面板提供分组、中文标注、
 * 默认 Base URL / 协议 / 密钥提示,以及按 provider+modelId 查目录模型。
 */
import {getModels} from "@mariozechner/pi-ai";
import type {Api, Model} from "@mariozechner/pi-ai";

export type ProviderGroupId = "custom" | "plan" | "direct" | "gateway" | "cloud";

export interface ProviderMeta {
    id: string;
    /** 中文显示名 */
    label: string;
    group: ProviderGroupId;
    /** 目录中第一个模型的 baseUrl,作为默认接口地址 */
    defaultBase?: string;
    /** 该服务商目录中出现过的协议 */
    apis: Api[];
    modelCount: number;
    /** 对应的环境变量名,仅作提示展示 */
    envKey?: string;
    /** 额外说明 */
    note?: string;
}

export const PROVIDER_GROUPS: {id: ProviderGroupId; label: string}[] = [
    {id: "custom", label: "自定义"},
    {id: "plan", label: "订阅制 / Coding Plan"},
    {id: "direct", label: "直连 API"},
    {id: "gateway", label: "聚合 / 网关"},
    {id: "cloud", label: "云平台"},
];

/** id → 中文标注与分组;目录中的其余字段运行时从 pi 取。 */
const PROVIDER_LABELS: Record<string, {label: string; group: ProviderGroupId; envKey?: string; note?: string}> = {
    "openai-codex": {label: "ChatGPT Codex(Plus/Pro 订阅)", group: "plan", note: "订阅制,需粘贴 OAuth Token(可从 pi CLI 登录获取)"},
    "kimi-coding": {label: "Kimi Coding 会员", group: "plan", envKey: "KIMI_API_KEY"},
    "xiaomi-token-plan-cn": {label: "小米 Token 包(国内)", group: "plan", envKey: "XIAOMI_TOKEN_PLAN_CN_API_KEY"},
    "xiaomi-token-plan-ams": {label: "小米 Token 包(阿姆斯特丹)", group: "plan", envKey: "XIAOMI_TOKEN_PLAN_AMS_API_KEY"},
    "xiaomi-token-plan-sgp": {label: "小米 Token 包(新加坡)", group: "plan", envKey: "XIAOMI_TOKEN_PLAN_SGP_API_KEY"},
    "github-copilot": {label: "GitHub Copilot 订阅", group: "plan", note: "订阅制,需粘贴 Copilot OAuth Token"},
    "anthropic": {label: "Anthropic(Claude)", group: "direct", envKey: "ANTHROPIC_API_KEY"},
    "openai": {label: "OpenAI", group: "direct", envKey: "OPENAI_API_KEY"},
    "google": {label: "Google Gemini", group: "direct", envKey: "GEMINI_API_KEY"},
    "deepseek": {label: "DeepSeek 深度求索", group: "direct", envKey: "DEEPSEEK_API_KEY"},
    "xai": {label: "xAI(Grok)", group: "direct", envKey: "XAI_API_KEY"},
    "groq": {label: "Groq", group: "direct", envKey: "GROQ_API_KEY"},
    "cerebras": {label: "Cerebras", group: "direct", envKey: "CEREBRAS_API_KEY"},
    "zai": {label: "智谱 Z.AI", group: "direct", envKey: "ZAI_API_KEY"},
    "minimax": {label: "MiniMax(国际)", group: "direct", envKey: "MINIMAX_API_KEY"},
    "minimax-cn": {label: "MiniMax(国内)", group: "direct", envKey: "MINIMAX_CN_API_KEY"},
    "moonshotai": {label: "Moonshot AI(国际)", group: "direct", envKey: "MOONSHOT_API_KEY"},
    "moonshotai-cn": {label: "月之暗面 Kimi(国内)", group: "direct", envKey: "MOONSHOT_API_KEY"},
    "mistral": {label: "Mistral AI", group: "direct", envKey: "MISTRAL_API_KEY"},
    "fireworks": {label: "Fireworks AI", group: "direct", envKey: "FIREWORKS_API_KEY"},
    "xiaomi": {label: "小米(API 计费)", group: "direct", envKey: "XIAOMI_API_KEY"},
    "huggingface": {label: "Hugging Face", group: "direct"},
    "cloudflare-workers-ai": {label: "Cloudflare Workers AI", group: "direct", envKey: "CLOUDFLARE_API_KEY"},
    "openrouter": {label: "OpenRouter", group: "gateway", envKey: "OPENROUTER_API_KEY"},
    "opencode": {label: "OpenCode", group: "gateway", envKey: "OPENCODE_API_KEY"},
    "opencode-go": {label: "OpenCode GO", group: "gateway", envKey: "OPENCODE_API_KEY"},
    "vercel-ai-gateway": {label: "Vercel AI Gateway", group: "gateway", envKey: "AI_GATEWAY_API_KEY"},
    "cloudflare-ai-gateway": {label: "Cloudflare AI Gateway", group: "gateway", envKey: "CLOUDFLARE_API_KEY"},
    "amazon-bedrock": {label: "AWS Bedrock", group: "cloud", note: "依赖 AWS 云凭证,浏览器端插件内通常不可用"},
    "azure-openai-responses": {label: "Azure OpenAI", group: "cloud", envKey: "AZURE_OPENAI_API_KEY"},
    "google-vertex": {label: "Google Vertex AI", group: "cloud", envKey: "GOOGLE_CLOUD_API_KEY"},
};

let cachedProviders: ProviderMeta[] | null = null;

/** 全部可选服务商(自定义 + pi 目录 31 家),按分组排序。 */
export function listProviders(): ProviderMeta[] {
    if (cachedProviders) {
        return cachedProviders;
    }
    const result: ProviderMeta[] = [
        {
            id: "custom",
            label: "自定义(OpenAI 兼容等)",
            group: "custom",
            apis: ["openai-completions"],
            modelCount: 0,
            note: "任意 OpenAI 兼容 / Anthropic / Google 接口,手动填写地址与模型",
        },
    ];
    for (const [id, info] of Object.entries(PROVIDER_LABELS)) {
        const models = safeGetModels(id);
        result.push({
            id,
            label: info.label,
            group: info.group,
            defaultBase: models[0]?.baseUrl,
            apis: [...new Set(models.map((m) => m.api))] as Api[],
            modelCount: models.length,
            envKey: info.envKey,
            note: info.note,
        });
    }
    const order = PROVIDER_GROUPS.map((g) => g.id);
    result.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group) || a.label.localeCompare(b.label, "zh"));
    cachedProviders = result;
    return result;
}

export function providerMeta(id: string): ProviderMeta {
    return listProviders().find((p) => p.id === id) ?? listProviders()[0];
}

/** 在 pi 目录中查找模型(自定义 provider 或未收录模型返回 undefined)。 */
export function findCatalogModel(provider: string, modelId: string): Model<Api> | undefined {
    if (!provider || provider === "custom" || !modelId) {
        return undefined;
    }
    return safeGetModels(provider).find((m) => m.id === modelId);
}

function safeGetModels(provider: string): Model<Api>[] {
    try {
        return getModels(provider as never) as Model<Api>[];
    } catch {
        return [];
    }
}
