/**
 * 设置面板的"测试连接 / 获取上游模型 / 发送测试消息"实现。
 * 直接从渲染进程请求上游接口(思源桌面端 webSecurity 关闭,无 CORS 限制)。
 */
import {completeSimple} from "@mariozechner/pi-ai";
import type {AgentPluginConfig} from "./agent-runner";
import {buildModel, resolveActiveModel} from "./agent-runner";

export interface UpstreamModelInfo {
    id: string;
    name?: string;
}

export interface TestOutcome {
    ok: boolean;
    /** 一行结论,直接展示给用户 */
    message: string;
    /** 可选的补充细节(错误响应体等) */
    details?: string;
    latencyMs?: number;
}

interface HttpError extends Error {
    status?: number;
    body?: string;
}

const joinUrl = (base: string, path: string): string => base.replace(/\/+$/, "") + path;

async function fetchJson(url: string, init: RequestInit, timeoutMs = 20000): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, {...init, signal: controller.signal});
        const text = await res.text();
        if (!res.ok) {
            const err = new Error(`HTTP ${res.status} ${res.statusText || ""}`.trim()) as HttpError;
            err.status = res.status;
            err.body = text.slice(0, 600);
            throw err;
        }
        try {
            return JSON.parse(text);
        } catch {
            throw new Error(`响应不是有效 JSON:${text.slice(0, 200)}`);
        }
    } finally {
        clearTimeout(timer);
    }
}

function describeError(e: unknown): {message: string; details?: string} {
    const err = e as HttpError;
    if (err?.name === "AbortError") {
        return {message: "请求超时(20 秒)", details: urlSafe(err?.message)};
    }
    if (err instanceof TypeError && /failed to fetch/i.test(err?.message ?? "")) {
        return {
            message: "网络请求失败",
            details: "无法连接到接口地址。请检查地址是否正确、网络是否可达;若在浏览器中访问思源,受 CORS 限制属正常现象,思源桌面端不受影响。",
        };
    }
    if (typeof err?.status === "number") {
        let upstream = "";
        try {
            const body = JSON.parse(err.body ?? "");
            upstream = body?.error?.message ?? body?.message ?? body?.error ?? "";
        } catch {
            upstream = err.body ?? "";
        }
        return {message: `HTTP ${err.status}`, details: String(upstream).slice(0, 400) || undefined};
    }
    return {message: err?.message ? String(err.message) : String(e), details: urlSafe(err?.message)};
}

function urlSafe(v: unknown): string | undefined {
    return v ? String(v) : undefined;
}

/** 按协议调用上游"列出模型"接口;不支持在线列出的协议抛错并提示用目录。 */
export async function listUpstreamModels(cfg: AgentPluginConfig): Promise<{models: UpstreamModelInfo[]; latencyMs: number}> {
    const started = performance.now();
    const base = cfg.baseURL.trim();
    const key = cfg.apiKey.trim();
    if (!base) {
        throw new Error("请先填写接口地址");
    }

    let models: UpstreamModelInfo[];
    if (cfg.api === "openai-completions" || cfg.api === "openai-responses") {
        const headers = {Authorization: `Bearer ${key}`};
        let data: any;
        try {
            data = await fetchJson(joinUrl(base, "/models"), {headers});
        } catch (e) {
            const err = e as HttpError;
            // 有的网关不带 /v1 前缀,补一次
            if (err.status === 404 && !/\/v\d+([/.]|$)/.test(base)) {
                data = await fetchJson(joinUrl(base, "/v1/models"), {headers});
            } else {
                throw e;
            }
        }
        models = (data?.data ?? [])
            .map((m: any) => ({id: String(m.id), name: m.display_name || m.name || undefined}))
            .filter((m: UpstreamModelInfo) => m.id);
        models.sort((a, b) => a.id.localeCompare(b.id));
    } else if (cfg.api === "anthropic-messages") {
        const data = await fetchJson(joinUrl(base, "/v1/models"), {
            headers: {
                "x-api-key": key,
                "anthropic-version": "2023-06-01",
                "anthropic-dangerous-direct-browser-access": "true",
            },
        });
        models = (data?.data ?? [])
            .map((m: any) => ({id: String(m.id), name: m.display_name || undefined}))
            .filter((m: UpstreamModelInfo) => m.id);
        models.sort((a, b) => a.id.localeCompare(b.id));
    } else if (cfg.api === "google-generative-ai") {
        const url = `${joinUrl(base, "/models")}?pageSize=200&key=${encodeURIComponent(key)}`;
        const data = await fetchJson(url, {});
        models = (data?.models ?? [])
            .filter((m: any) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes("generateContent"))
            .map((m: any) => ({id: String(m.name ?? "").replace(/^models\//, ""), name: m.displayName || undefined}))
            .filter((m: UpstreamModelInfo) => m.id);
        models.sort((a, b) => a.id.localeCompare(b.id));
    } else {
        throw new Error(`协议 ${cfg.api} 暂不支持在线获取模型列表,请使用 pi 内置目录或手动填写模型 ID`);
    }
    return {models, latencyMs: Math.round(performance.now() - started)};
}

/** 测试连接:等价于一次零成本的模型列表请求,验证地址与密钥。 */
export async function testConnection(cfg: AgentPluginConfig): Promise<TestOutcome> {
    try {
        const {models, latencyMs} = await listUpstreamModels(cfg);
        const sample = models.slice(0, 3).map((m) => m.id).join("、");
        return {
            ok: true,
            latencyMs,
            message: `连接成功:发现 ${models.length} 个模型(${latencyMs}ms)`,
            details: sample ? `示例:${sample}${models.length > 3 ? " …" : ""}` : undefined,
        };
    } catch (e) {
        return {ok: false, ...describeError(e)};
    }
}

/** 发送测试消息:走 pi 完整管线(协议适配 + 流式),验证密钥、模型与协议是否真正可用。 */
export async function testChat(cfg: AgentPluginConfig): Promise<TestOutcome> {
    if (!resolveActiveModel(cfg).id) {
        return {ok: false, message: "请先添加并启用模型"};
    }
    if (!cfg.apiKey) {
        return {ok: false, message: "请先填写 API Key"};
    }
    const started = performance.now();
    try {
        const reply = await completeSimple(buildModel(cfg), {
            messages: [{role: "user", content: [{type: "text", text: "连通性测试,请只回复:pong"}], timestamp: Date.now()}],
        }, {
            apiKey: cfg.apiKey,
            maxTokens: Math.min(Math.max(cfg.maxTokens, 16), 64),
        });
        const latencyMs = Math.round(performance.now() - started);
        if (reply.stopReason === "error") {
            return {ok: false, message: `模型返回错误:${reply.errorMessage ?? "未知错误"}`, latencyMs};
        }
        const text = reply.content
            .filter((c): c is {type: "text"; text: string} => c.type === "text")
            .map((c) => c.text)
            .join("")
            .trim();
        return {
            ok: true,
            latencyMs,
            message: `对话成功(${latencyMs}ms),模型回复:「${text.slice(0, 60) || "(空)"}」`,
            details: `tokens:输入 ${reply.usage.input} / 输出 ${reply.usage.output}`,
        };
    } catch (e) {
        return {ok: false, ...describeError(e)};
    }
}
