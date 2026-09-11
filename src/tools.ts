/**
 * 思源笔记工具集：把内核 REST API 与前端界面操作包装成 pi 的 AgentTool。
 * 能力面参考思源原生智能体(后端内置 + 前端内置):
 * 笔记本/文档/块/标签/书签/属性/资源/日记/快照/SQL + 打开文档/定位块/打开搜索/打开设置。
 *
 * pi 的 AgentTool = {name, label, description, parameters(typebox), execute}.
 * 只读工具直接执行；写操作工具由 Agent 的 beforeToolCall 钩子按批准策略确认(见 agent-runner.ts)。
 */
import {openTab} from "siyuan";
import type {App} from "siyuan";
import type {AgentTool} from "@mariozechner/pi-agent-core";
import type {TextContent} from "@mariozechner/pi-ai";
import {Type} from "@mariozechner/pi-ai";
import {SiYuanClient} from "./siyuan-client";
import {t} from "./i18n";

/** 返回给模型的正文最大长度,避免工具结果撑爆上下文。 */
const MAX_CONTENT = 12000;

function text(s: string): TextContent[] {
    return [{type: "text", text: s}];
}

function truncate(s: string, max = MAX_CONTENT): string {
    if (s.length <= max) {
        return s;
    }
    return `${s.slice(0, max)}\n${t("tool.truncated", {total: s.length})}`;
}

/** 对结构不确定的响应,直接给 JSON(截断)。 */
function jsonText(data: unknown): string {
    try {
        return truncate(JSON.stringify(data, null, 1) ?? "null");
    } catch {
        return String(data);
    }
}

function sqlQuote(s: string): string {
    return s.replace(/'/g, "''");
}

const SEARCH_BLOCK_TYPES = "('p','h','c','t','b','s','html','math','code','table','audio','video')";

/** 网络请求用的桌面浏览器 UA,降低被搜索引擎拦截的概率。 */
const WEB_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

interface WebHit {
    title: string;
    url: string;
    snippet: string;
}

/** DuckDuckGo HTML 版搜索解析(无 API key)。 */
function parseDuckDuckGo(html: string, limit: number): WebHit[] {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const hits: WebHit[] = [];
    doc.querySelectorAll(".result").forEach((el) => {
        const a = el.querySelector(".result__a");
        if (!a) {
            return;
        }
        let url = a.getAttribute("href") ?? "";
        try {
            // DDG 跳转链接 /l/?uddg=<真实地址>
            const real = new URL(url, "https://duckduckgo.com").searchParams.get("uddg");
            if (real) {
                url = real;
            }
        } catch { /* 保留原样 */ }
        hits.push({
            title: (a.textContent ?? "").trim(),
            url,
            snippet: (el.querySelector(".result__snippet")?.textContent ?? "").replace(/\s+/g, " ").trim(),
        });
    });
    return hits.slice(0, limit);
}

/** Bing 搜索解析(DDG 失败时的后备)。 */
function parseBing(html: string, limit: number): WebHit[] {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const hits: WebHit[] = [];
    doc.querySelectorAll("li.b_algo").forEach((el) => {
        const a = el.querySelector("h2 a");
        if (!a) {
            return;
        }
        hits.push({
            title: (a.textContent ?? "").trim(),
            url: a.getAttribute("href") ?? "",
            snippet: (el.querySelector(".b_caption p")?.textContent ?? "").replace(/\s+/g, " ").trim(),
        });
    });
    return hits.filter((h) => h.url.startsWith("http")).slice(0, limit);
}

/** 百度搜索解析(国内网络环境下更稳)。 */
function parseBaidu(html: string, limit: number): WebHit[] {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const hits: WebHit[] = [];
    doc.querySelectorAll(".result, .c-container").forEach((el) => {
        const a = el.querySelector("h3 a, h3.t a");
        if (!a) {
            return;
        }
        const snippet = (el.querySelector(".c-abstract, [class*='content-right'], .c-span-last")?.textContent ?? "")
            .replace(/\s+/g, " ").trim();
        hits.push({title: (a.textContent ?? "").trim(), url: a.getAttribute("href") ?? "", snippet});
    });
    return hits.filter((h) => h.url.startsWith("http")).slice(0, limit);
}

/** Google 搜索解析(需要能访问 google.com 的网络环境)。 */
function parseGoogle(html: string, limit: number): WebHit[] {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const hits: WebHit[] = [];
    doc.querySelectorAll<HTMLAnchorElement>("a").forEach((a) => {
        const h3 = a.querySelector("h3");
        if (!h3) {
            return;
        }
        let url = a.getAttribute("href") ?? "";
        try {
            // Google 跳转链接 /url?q=<真实地址>
            const u = new URL(url, "https://www.google.com");
            url = u.searchParams.get("q") ?? url;
        } catch { /* 保留原样 */ }
        if (!url.startsWith("http") || url.includes("google.com")) {
            return;
        }
        hits.push({title: (h3.textContent ?? "").trim(), url, snippet: ""});
    });
    const seen = new Set<string>();
    return hits.filter((h) => !seen.has(h.url) && seen.add(h.url)).slice(0, limit);
}

type EngineId = "duckduckgo" | "bing" | "baidu" | "google";

interface SearchEngineDef {
    id: EngineId;
    name: string;
    url: (q: string) => string;
    parse: (html: string, limit: number) => WebHit[];
}

const SEARCH_ENGINES: SearchEngineDef[] = [
    {id: "duckduckgo", name: "DuckDuckGo", url: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, parse: parseDuckDuckGo},
    {id: "bing", name: "Bing", url: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`, parse: parseBing},
    {id: "baidu", name: "百度", url: (q) => `https://www.baidu.com/s?wd=${encodeURIComponent(q)}`, parse: parseBaidu},
    {id: "google", name: "Google", url: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}&num=20`, parse: parseGoogle},
];

/** HTML → 纯文本(去掉脚本/样式/注释,压缩空白)。 */
function htmlToText(html: string): string {
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("script,style,noscript,iframe,svg,template").forEach((el) => el.remove());
    return (doc.body?.textContent ?? "").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim();
}

/**
 * 联网抓取:优先走内核转发代理(无 CORS 限制);
 * 内核网络不通时回退到渲染进程 fetch(Chromium 走系统代理,但受 CORS 限制)。
 */
async function webGet(client: SiYuanClient, url: string): Promise<{body: string; contentType: string; status: number; via: string}> {
    try {
        const r = await client.webRequest({url, headers: {"User-Agent": WEB_UA}});
        if (r.body) {
            return {...r, via: t("tool.viaKernel")};
        }
    } catch { /* 内核网络不通,尝试渲染进程 */ }
    const resp = await fetch(url, {headers: {Accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.8"}});
    const body = await resp.text();
    if (!resp.ok && !body) {
        throw new Error(`HTTP ${resp.status}`);
    }
    return {body, contentType: resp.headers.get("content-type") ?? "", status: resp.status, via: t("tool.viaBrowser")};
}

/** Jina Reader(免 key, CORS 友好)抓取网页正文,内核/直连都失败时的最后手段。 */
async function jinaReaderGet(client: SiYuanClient, url: string): Promise<string> {
    const r = await webGet(client, `https://r.jina.ai/${url}`);
    return r.body ?? "";
}

/** 解析 Jina Reader 返回的搜索结果页(Markdown 链接)。 */
function parseJinaSearch(md: string, limit: number): WebHit[] {
    const hits: WebHit[] = [];
    const seen = new Set<string>();
    const re = /\[([^\]\n]{4,120})\]\((https?:\/\/[^)\s]+)\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(md)) && hits.length < limit) {
        const [, title, url] = m;
        if (seen.has(url) || /duckduckgo\.com|bing\.com|jina\.ai/.test(url)) {
            continue;
        }
        seen.add(url);
        hits.push({title: title.trim(), url, snippet: ""});
    }
    return hits;
}


/**
 * 写操作能力清单(需要按批准策略确认)。
 * 能力设置页用它渲染「写」徽章与批准方式下拉。
 */
export const WRITE_TOOLS: readonly string[] = [
    "create_notebook",
    "rename_notebook",
    "remove_notebook",
    "create_note",
    "rename_doc",
    "move_doc",
    "remove_doc",
    "insert_block",
    "update_block",
    "delete_block",
    "move_block",
    "rename_tag",
    "remove_tag",
    "rename_bookmark",
    "remove_bookmark",
    "set_block_attrs",
    "rename_asset",
    "create_daily_note",
    "append_daily_note",
    "create_snapshot",
    // 数据库(属性视图)
    "create_database",
    "add_database_row",
    "update_database_cell",
    "remove_database_rows",
    "add_database_column",
    "rename_database_column",
    "remove_database_column",
];

/** 属性视图(数据库)列定义。 */
interface AvKey {
    id: string;
    name: string;
    type: string;
    icon?: string;
    options?: {name: string; color?: string}[];
}

/** 生成思源风格的块/值 id:14 位时间戳 + 7 位随机字符。 */
function newAvId(): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    return `${ts}-${Math.random().toString(36).slice(2, 9).padEnd(7, "0")}`;
}

/** 数据库元信息(名称 + 视图列表 + 列定义;keyValues 内含选项列的候选值)。 */
async function getAvMeta(client: SiYuanClient, avID: string): Promise<{name: string; views: {id: string; name: string; type?: string}[]; keys: AvKey[]}> {
    const data = await client.request<any>("/api/av/getAttributeView", {id: avID});
    const av = data?.av ?? data ?? {};
    let keys: AvKey[] = (av.keyValues ?? []).map((kv: any) => kv?.key).filter((k: any) => k?.id);
    if (keys.length === 0) {
        // 兜底:部分版本 getAttributeView 不含 keyValues
        keys = ((await client.request<any>("/api/av/getAttributeViewKeysByAvID", {avID})) ?? []) as AvKey[];
    }
    return {name: av.name ?? "", views: Array.isArray(av.views) ? av.views : [], keys};
}

/** 数据库列清单(含选项列的候选值)。 */
async function getAvKeys(client: SiYuanClient, avID: string): Promise<AvKey[]> {
    return (await getAvMeta(client, avID)).keys;
}

/**
 * 提交属性视图事务。
 * 3.8+ 内核的列增删改、单元格写入、库命名均走 /api/transactions(旧 REST 接口已移除)。
 * reqId 为顶层必填数字;session/app 只需是非空字符串。
 */
async function avTx(client: SiYuanClient, ops: Array<Record<string, unknown>>): Promise<void> {
    await client.request("/api/transactions", {
        session: newAvId(),
        app: "siyuan-ai-agent",
        reqId: Date.now(),
        transactions: [{doOperations: ops}],
    });
}

/** 按列名找列定义,找不到时报错并列出可用列。 */
function findAvKey(keys: AvKey[], name: string): AvKey {
    const key = keys.find((k) => k.name === name);
    if (!key) {
        throw new Error(t("tool.av.unknownColumn", {name, columns: keys.map((k) => k.name).join(", ")}));
    }
    return key;
}

/** 展示用:单元格值 → 文本。 */
function avCellText(value: any): string {
    if (!value) {
        return "";
    }
    switch (value.type) {
        case "block": return value.block?.content ?? "";
        case "text": return value.text?.content ?? "";
        case "number": return value.number?.formattedContent ?? (value.number?.isNotEmpty ? String(value.number?.content ?? "") : "");
        case "select":
        case "mSelect": {
            // 3.8+: 单选/多选统一存 mSelect 数组;兼容旧版 {mSelect:{content:[...]}} 与 {select:{content}}
            const list: any[] = Array.isArray(value.mSelect) ? value.mSelect
                : (value.mSelect?.content ?? (value.select ? [value.select] : []));
            return list.map((o: any) => o?.content ?? "").filter(Boolean).join(", ");
        }
        case "date": return value.date?.formattedContent ?? (value.date?.content ? new Date(value.date.content).toISOString().slice(0, 10) : "");
        case "url": return value.url?.content ?? "";
        case "email": return value.email?.content ?? "";
        case "phone": return value.phone?.content ?? "";
        case "checkbox": return value.checkbox?.checked ? "✓" : "✗";
        case "mAsset": return (value.mAsset ?? []).map((a: any) => a?.name || a?.content || "").filter(Boolean).join(", ");
        case "relation": return (value.relation?.contents ?? []).filter(Boolean).join(", ");
        case "template": return value.template?.content ?? "";
        case "created": return value.created?.formattedContent ?? "";
        case "updated": return value.updated?.formattedContent ?? "";
        default: return "";
    }
}

/** 把用户输入按列类型构造为 av.Value 的内容片段(不含 keyID/id)。 */
function avValueFor(key: AvKey, input: unknown): Record<string, any> {
    const s = input == null ? "" : String(input);
    switch (key.type) {
        case "block": return {block: {content: s}};
        case "text": return {text: {content: s}};
        case "number": {
            const n = typeof input === "number" ? input : Number(s);
            if (s.trim() === "" || Number.isNaN(n)) {
                throw new Error(t("tool.av.badNumber", {name: key.name, value: s}));
            }
            return {number: {content: n, isNotEmpty: true, formattedContent: s || String(n)}};
        }
        case "select":
        case "mSelect": {
            // 3.8+: 单选也以 mSelect 单元素数组存储;颜色取自列选项,新选项用递增色
            const names = key.type === "select" ? (s.trim() ? [s.trim()] : []) : mSelectNames(input);
            const options = key.options ?? [];
            return {mSelect: names.map((content) => ({
                content,
                color: options.find((o) => o.name === content)?.color ?? String((options.length % 13) + 1),
            }))};
        }
        case "date": {
            let ms: number;
            if (typeof input === "number") {
                ms = input;
            } else {
                // 本地时区解析 YYYY-MM-DD[ HH:mm],避免 ISO 解析的时区偏移
                const m = s.trim().match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/);
                ms = m ? new Date(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0)).getTime() : Date.parse(s);
            }
            if (!ms || Number.isNaN(ms)) {
                throw new Error(t("tool.av.badDate", {name: key.name, value: s}));
            }
            // formattedContent 由内核按 content 重算,无需提供
            return {date: {content: ms, isNotEmpty: true, isNotTime: !s.includes(":"), hasEndDate: false}};
        }
        case "url": return {url: {content: s}};
        case "email": return {email: {content: s}};
        case "phone": return {phone: {content: s}};
        case "checkbox": {
            const checked = typeof input === "boolean" ? input
                : ["true", "1", "yes", "是", "✓", "checked"].includes(s.trim().toLowerCase());
            return {checkbox: {checked}};
        }
        default:
            throw new Error(t("tool.av.readonlyType", {name: key.name, type: key.type}));
    }
}

/** 写入单选/多选前确保选项存在(缺失则以 updateAttrViewColOptions 事务全量补建)。 */
async function ensureSelectOptions(client: SiYuanClient, avID: string, key: AvKey, names: string[]): Promise<void> {
    const existing = new Set((key.options ?? []).map((o) => o.name));
    const missing = names.filter((n) => n && !existing.has(n));
    if (missing.length === 0) {
        return;
    }
    const options = [...(key.options ?? []), ...missing.map((name, i) => ({name, color: String(((existing.size + i) % 13) + 1)}))];
    await avTx(client, [{action: "updateAttrViewColOptions", id: key.id, avID, data: options}]);
    key.options = options;
}

/** 多选输入 → 选项名数组(支持数组或逗号分隔字符串)。 */
function mSelectNames(input: unknown): string[] {
    if (Array.isArray(input)) {
        return input.map(String).map((x) => x.trim()).filter(Boolean);
    }
    return String(input ?? "").split(/[,，]/).map((x) => x.trim()).filter(Boolean);
}

/**
 * 构造思源能力集。app 仅前端能力(打开文档等)需要,可无。
 */
export function createSiyuanTools(client: SiYuanClient, app?: App, options?: {searchEngine?: EngineId}): AgentTool<any>[] {
    /** 通用后端能力:schema + 参数映射 → 内核 REST 调用。 */
    const apiTool = (def: {
        name: string;
        label: string;
        description: string;
        endpoint: string;
        schema: any;
        map?: (p: any) => Record<string, unknown>;
        present?: (data: any, p: any) => string;
        done?: (p: any) => string;
    }): AgentTool<any> => ({
        name: def.name,
        label: def.label,
        description: def.description,
        parameters: def.schema,
        execute: async (_id: string, params: any) => {
            const data = await client.request(def.endpoint, def.map ? def.map(params) : params);
            const body = def.present ? def.present(data, params) : undefined;
            return {content: text(body ?? `${def.done ? def.done(params) : t("tool.done", {label: def.label})}\n${jsonText(data)}`), details: data};
        },
    });

    const tools: AgentTool<any>[] = [
        // ------------------------------------------------ 笔记本
        {
            name: "list_notebooks",
            label: t("tool.list_notebooks.label"),
            description: t("tool.list_notebooks.desc"),
            parameters: Type.Object({}),
            execute: async () => {
                const notebooks = await client.listNotebooks();
                if (notebooks.length === 0) {
                    return {content: text(t("tool.list_notebooks.empty")), details: {notebooks}};
                }
                const lines = notebooks.map((n) => `- ${n.name} (id: ${n.id})`);
                return {content: text(`${t("tool.list_notebooks.count", {count: notebooks.length})}\n${lines.join("\n")}`), details: {notebooks}};
            },
        },
        apiTool({
            name: "create_notebook",
            label: t("tool.create_notebook.label"),
            description: t("tool.create_notebook.desc"),
            endpoint: "/api/notebook/createNotebook",
            schema: Type.Object({name: Type.String({description: t("tool.create_notebook.p.name")})}),
            map: (p) => ({name: p.name}),
        }),
        apiTool({
            name: "rename_notebook",
            label: t("tool.rename_notebook.label"),
            description: t("tool.rename_notebook.desc"),
            endpoint: "/api/notebook/renameNotebook",
            schema: Type.Object({
                id: Type.String({description: t("tool.p.notebookId")}),
                name: Type.String({description: t("tool.rename_notebook.p.name")}),
            }),
        }),
        apiTool({
            name: "remove_notebook",
            label: t("tool.remove_notebook.label"),
            description: t("tool.remove_notebook.desc"),
            endpoint: "/api/notebook/removeNotebook",
            schema: Type.Object({id: Type.String({description: t("tool.p.notebookId")})}),
        }),

        // ------------------------------------------------ 文档
        apiTool({
            name: "search_docs",
            label: t("tool.search_docs.label"),
            description: t("tool.search_docs.desc"),
            endpoint: "/api/filetree/searchDocs",
            schema: Type.Object({keyword: Type.String({description: t("tool.search_docs.p.keyword")})}),
            map: (p) => ({k: p.keyword}),
            present: (data) => {
                const list = Array.isArray(data) ? data : [];
                if (list.length === 0) {
                    return t("tool.search_docs.empty");
                }
                return t("tool.search_docs.count", {count: list.length}) + "\n" + list.map((d: any) =>
                    t("tool.search_docs.item", {hpath: d.hPath || d.path, box: d.box, path: d.path})).join("\n");
            },
        }),
        {
            name: "list_docs",
            label: t("tool.list_docs.label"),
            description: t("tool.list_docs.desc"),
            parameters: Type.Object({
                notebook: Type.String({description: t("tool.p.notebookId")}),
                path: Type.Optional(Type.String({description: t("tool.list_docs.p.path")})),
                limit: Type.Optional(Type.Number({description: t("tool.list_docs.p.limit")})),
            }),
            execute: async (_id, params: any) => {
                const limit = Math.min(Math.max(Math.trunc(params.limit ?? 100), 1), 500);
                const prefix = String(params.path ?? "");
                const rows = await client.sql<{id: string; hpath: string}>(
                    `SELECT id, hpath FROM blocks WHERE type='d' AND box='${sqlQuote(params.notebook)}' ` +
                    `AND hpath LIKE '${sqlQuote(prefix)}%' ORDER BY hpath LIMIT ${limit}`);
                if (rows.length === 0) {
                    return {content: text(t("tool.list_docs.empty")), details: {rows}};
                }
                const lines = rows.map((r) => `- ${r.hpath} (id: ${r.id})`);
                return {content: text(`${t("tool.list_docs.count", {count: rows.length})}\n${lines.join("\n")}`), details: {rows}};
            },
        },
        {
            name: "create_note",
            label: t("tool.create_note.label"),
            description: t("tool.create_note.desc"),
            parameters: Type.Object({
                notebook: Type.String({description: t("tool.create_note.p.notebook")}),
                path: Type.String({description: t("tool.create_note.p.path")}),
                markdown: Type.String({description: t("tool.create_note.p.markdown")}),
            }),
            execute: async (_id, params: any) => {
                const docId = await client.createDocWithMd(params.notebook, params.path, params.markdown);
                return {
                    content: text(t("tool.create_note.done", {path: params.path, id: docId || t("tool.create_note.unknownId")})),
                    details: {docId, path: params.path},
                };
            },
        },
        {
            name: "read_note",
            label: t("tool.read_note.label"),
            description: t("tool.read_note.desc"),
            parameters: Type.Object({
                doc_id: Type.String({description: t("tool.read_note.p.doc_id")}),
            }),
            execute: async (_id, params: any) => {
                const data = await client.exportDocMarkdown(String(params.doc_id));
                if (!data.content) {
                    return {content: text(t("tool.read_note.empty", {id: params.doc_id})), details: data};
                }
                return {content: text(`${t("tool.read_note.path", {path: data.hpath || "/"})}\n\n${truncate(data.content)}`), details: data};
            },
        },
        apiTool({
            name: "rename_doc",
            label: t("tool.rename_doc.label"),
            description: t("tool.rename_doc.desc"),
            endpoint: "/api/filetree/renameDocByID",
            schema: Type.Object({
                doc_id: Type.String({description: t("tool.p.docId")}),
                title: Type.String({description: t("tool.rename_doc.p.title")}),
            }),
            map: (p) => ({id: p.doc_id, title: p.title}),
        }),
        apiTool({
            name: "move_doc",
            label: t("tool.move_doc.label"),
            description: t("tool.move_doc.desc"),
            endpoint: "/api/filetree/moveDocsByID",
            schema: Type.Object({
                doc_id: Type.String({description: t("tool.move_doc.p.doc_id")}),
                to: Type.String({description: t("tool.move_doc.p.to")}),
            }),
            map: (p) => ({fromIDs: [p.doc_id], toID: p.to}),
        }),
        apiTool({
            name: "remove_doc",
            label: t("tool.remove_doc.label"),
            description: t("tool.remove_doc.desc"),
            endpoint: "/api/filetree/removeDocByID",
            schema: Type.Object({doc_id: Type.String({description: t("tool.p.docId")})}),
            map: (p) => ({id: p.doc_id}),
        }),

        // ------------------------------------------------ 块
        {
            name: "search_notes",
            label: t("tool.search_notes.label"),
            description: t("tool.search_notes.desc"),
            parameters: Type.Object({
                query: Type.String({description: t("tool.search_notes.p.query")}),
                limit: Type.Optional(Type.Number({description: t("tool.search_notes.p.limit")})),
            }),
            execute: async (_id, params: any) => {
                const limit = Math.min(Math.max(Math.trunc(params.limit ?? 20), 1), 50);
                const words = String(params.query).trim().split(/\s+/).filter(Boolean);
                if (words.length === 0) {
                    throw new Error(t("tool.search_notes.queryEmpty"));
                }
                const where = words.map((w) => `content LIKE '%${sqlQuote(w)}%'`).join(" AND ");
                const rows = await client.sql(
                    `SELECT id, root_id, hpath, type, content FROM blocks ` +
                    `WHERE ${where} AND type IN ${SEARCH_BLOCK_TYPES} ORDER BY updated DESC LIMIT ${limit + 1}`);
                const hasMore = rows.length > limit;
                const hits = rows.slice(0, limit);
                if (hits.length === 0) {
                    return {content: text(t("tool.search_notes.empty", {query: params.query})), details: {hits: []}};
                }
                const lines = hits.map((r: any, i: number) => {
                    const summary = String(r.content ?? "").replace(/\s+/g, " ").slice(0, 300);
                    return `${i + 1}. [${r.type}] ${r.hpath || "/"}\n   block_id: ${r.id} ${t("tool.search_notes.rootId", {root: r.root_id})}\n   ${summary}`;
                });
                const more = hasMore ? `\n${t("tool.search_notes.truncated")}` : "";
                return {content: text(`${t("tool.search_notes.count", {count: hits.length})}\n${lines.join("\n")}${more}`), details: {hits}};
            },
        },
        {
            name: "read_block",
            label: t("tool.read_block.label"),
            description: t("tool.read_block.desc"),
            parameters: Type.Object({
                block_id: Type.String({description: t("tool.p.blockId")}),
            }),
            execute: async (_id, params: any) => {
                const data = await client.getBlockKramdown(String(params.block_id));
                return {content: text(`${t("tool.read_block.content", {id: data.id})}\n\n${truncate(data.kramdown)}`), details: data};
            },
        },
        {
            name: "insert_block",
            label: t("tool.insert_block.label"),
            description: t("tool.insert_block.desc"),
            parameters: Type.Object({
                markdown: Type.String({description: t("tool.insert_block.p.markdown")}),
                parent_id: Type.Optional(Type.String({description: t("tool.insert_block.p.parent_id")})),
                previous_id: Type.Optional(Type.String({description: t("tool.insert_block.p.previous_id")})),
                next_id: Type.Optional(Type.String({description: t("tool.insert_block.p.next_id")})),
            }),
            execute: async (_id, params: any) => {
                if (!params.parent_id && !params.previous_id && !params.next_id) {
                    throw new Error(t("tool.insert_block.needAnchor"));
                }
                const ops = await client.insertBlock({
                    markdown: params.markdown,
                    parentID: params.parent_id,
                    previousID: params.previous_id,
                    nextID: params.next_id,
                });
                return {content: text(t("tool.insert_block.done", {count: Array.isArray(ops) ? ops.length : 0})), details: {ops}};
            },
        },
        {
            name: "update_block",
            label: t("tool.update_block.label"),
            description: t("tool.update_block.desc"),
            parameters: Type.Object({
                block_id: Type.String({description: t("tool.update_block.p.block_id")}),
                markdown: Type.String({description: t("tool.update_block.p.markdown")}),
            }),
            execute: async (_id, params: any) => {
                await client.updateBlock(String(params.block_id), params.markdown);
                return {content: text(t("tool.update_block.done", {id: params.block_id})), details: {blockId: params.block_id}};
            },
        },
        {
            name: "delete_block",
            label: t("tool.delete_block.label"),
            description: t("tool.delete_block.desc"),
            parameters: Type.Object({
                block_id: Type.String({description: t("tool.delete_block.p.block_id")}),
            }),
            execute: async (_id, params: any) => {
                await client.deleteBlock(String(params.block_id));
                return {content: text(t("tool.delete_block.done", {id: params.block_id})), details: {blockId: params.block_id}};
            },
        },
        apiTool({
            name: "move_block",
            label: t("tool.move_block.label"),
            description: t("tool.move_block.desc"),
            endpoint: "/api/block/moveBlock",
            schema: Type.Object({
                block_id: Type.String({description: t("tool.move_block.p.block_id")}),
                previous_id: Type.Optional(Type.String({description: t("tool.move_block.p.previous_id")})),
                parent_id: Type.Optional(Type.String({description: t("tool.move_block.p.parent_id")})),
            }),
            map: (p) => ({id: p.block_id, previousID: p.previous_id, parentID: p.parent_id}),
        }),

        // ------------------------------------------------ 标签
        apiTool({
            name: "search_tags",
            label: t("tool.search_tags.label"),
            description: t("tool.search_tags.desc"),
            endpoint: "/api/search/searchTag",
            schema: Type.Object({keyword: Type.Optional(Type.String({description: t("tool.search_tags.p.keyword")}))}),
            map: (p) => ({k: p.keyword ?? ""}),
            present: (data) => {
                const tags = data?.tags ?? [];
                if (tags.length === 0) {
                    return t("tool.search_tags.empty");
                }
                return t("tool.search_tags.count", {count: tags.length}) + "\n" + tags.map((tag: any) =>
                    t("tool.search_tags.item", {label: tag.label ?? tag.name, count: tag.count ?? 0})).join("\n");
            },
        }),
        apiTool({
            name: "rename_tag",
            label: t("tool.rename_tag.label"),
            description: t("tool.rename_tag.desc"),
            endpoint: "/api/tag/renameTag",
            schema: Type.Object({
                old: Type.String({description: t("tool.rename_tag.p.old")}),
                new: Type.String({description: t("tool.rename_tag.p.new")}),
            }),
            map: (p) => ({oldLabel: p.old, newLabel: p.new}),
        }),
        apiTool({
            name: "remove_tag",
            label: t("tool.remove_tag.label"),
            description: t("tool.remove_tag.desc"),
            endpoint: "/api/tag/removeTag",
            schema: Type.Object({label: Type.String({description: t("tool.remove_tag.p.label")})}),
        }),

        // ------------------------------------------------ 书签
        apiTool({
            name: "list_bookmarks",
            label: t("tool.list_bookmarks.label"),
            description: t("tool.list_bookmarks.desc"),
            endpoint: "/api/attr/getBookmarkLabels",
            schema: Type.Object({}),
            present: (data) => {
                const list = Array.isArray(data) ? data : [];
                if (list.length === 0) {
                    return t("tool.list_bookmarks.empty");
                }
                return t("tool.list_bookmarks.count", {count: list.length}) + "\n" + list.map((b: any) => `- ${typeof b === "string" ? b : b.label ?? b.name}`).join("\n");
            },
        }),
        apiTool({
            name: "rename_bookmark",
            label: t("tool.rename_bookmark.label"),
            description: t("tool.rename_bookmark.desc"),
            endpoint: "/api/bookmark/renameBookmark",
            schema: Type.Object({
                old: Type.String({description: t("tool.rename_bookmark.p.old")}),
                new: Type.String({description: t("tool.rename_bookmark.p.new")}),
            }),
            map: (p) => ({oldLabel: p.old, newLabel: p.new}),
        }),
        apiTool({
            name: "remove_bookmark",
            label: t("tool.remove_bookmark.label"),
            description: t("tool.remove_bookmark.desc"),
            endpoint: "/api/bookmark/removeBookmark",
            schema: Type.Object({label: Type.String({description: t("tool.remove_bookmark.p.label")})}),
        }),

        // ------------------------------------------------ 属性
        apiTool({
            name: "get_block_attrs",
            label: t("tool.get_block_attrs.label"),
            description: t("tool.get_block_attrs.desc"),
            endpoint: "/api/attr/getBlockAttrs",
            schema: Type.Object({block_id: Type.String({description: t("tool.p.blockId")})}),
            map: (p) => ({id: p.block_id}),
        }),
        apiTool({
            name: "set_block_attrs",
            label: t("tool.set_block_attrs.label"),
            description: t("tool.set_block_attrs.desc"),
            endpoint: "/api/attr/setBlockAttrs",
            schema: Type.Object({
                block_id: Type.String({description: t("tool.p.blockId")}),
                attrs: Type.Record(Type.String(), Type.String(), {description: t("tool.set_block_attrs.p.attrs")}),
            }),
            map: (p) => ({id: p.block_id, attrs: p.attrs}),
        }),

        // ------------------------------------------------ 资源文件
        apiTool({
            name: "list_doc_assets",
            label: t("tool.list_doc_assets.label"),
            description: t("tool.list_doc_assets.desc"),
            endpoint: "/api/asset/getDocAssets",
            schema: Type.Object({doc_id: Type.String({description: t("tool.p.docId")})}),
            map: (p) => ({id: p.doc_id}),
        }),
        apiTool({
            name: "get_asset_content",
            label: t("tool.get_asset_content.label"),
            description: t("tool.get_asset_content.desc"),
            endpoint: "/api/search/getAssetContent",
            schema: Type.Object({path: Type.String({description: t("tool.get_asset_content.p.path")})}),
            present: (data) => truncate(String(data?.content ?? jsonText(data))),
        }),
        apiTool({
            name: "rename_asset",
            label: t("tool.rename_asset.label"),
            description: t("tool.rename_asset.desc"),
            endpoint: "/api/asset/renameAsset",
            schema: Type.Object({
                old_path: Type.String({description: t("tool.rename_asset.p.old_path")}),
                new_path: Type.String({description: t("tool.rename_asset.p.new_path")}),
            }),
            map: (p) => ({oldPath: p.old_path, newPath: p.new_path}),
        }),

        // ------------------------------------------------ 日记
        apiTool({
            name: "create_daily_note",
            label: t("tool.create_daily_note.label"),
            description: t("tool.create_daily_note.desc"),
            endpoint: "/api/filetree/createDailyNote",
            schema: Type.Object({notebook: Type.String({description: t("tool.p.notebookId")})}),
            map: (p) => ({id: p.notebook}),
            present: (data) => t("tool.create_daily_note.done", {id: data?.id ?? t("tool.create_note.unknownId")}),
        }),
        apiTool({
            name: "append_daily_note",
            label: t("tool.append_daily_note.label"),
            description: t("tool.append_daily_note.desc"),
            endpoint: "/api/block/appendDailyNoteBlock",
            schema: Type.Object({
                notebook: Type.String({description: t("tool.p.notebookId")}),
                markdown: Type.String({description: t("tool.p.markdown")}),
            }),
            map: (p) => ({id: p.notebook, dataType: "markdown", data: p.markdown}),
        }),

        // ------------------------------------------------ 数据库(属性视图)
        {
            name: "list_databases",
            label: t("tool.list_databases.label"),
            description: t("tool.list_databases.desc"),
            parameters: Type.Object({
                keyword: Type.Optional(Type.String({description: t("tool.list_databases.p.keyword")})),
                limit: Type.Optional(Type.Number({description: t("tool.list_databases.p.limit")})),
            }),
            execute: async (_id, params: any) => {
                const limit = Math.min(Math.max(Math.trunc(params.limit ?? 50), 1), 200);
                const kw = String(params.keyword ?? "").trim();
                // searchAttributeView 直接返回 avID/名称/所在文档/视图;SQL blocks 表里的 id 是块 id 而非 avID,不能直接用
                const data = await client.request<any>("/api/av/searchAttributeView", {keyword: kw});
                const rows = (data?.results ?? []).slice(0, limit);
                if (rows.length === 0) {
                    return {content: text(t("tool.list_databases.empty")), details: {rows}};
                }
                const lines = rows.map((r: any) => t("tool.list_databases.item", {
                    name: r.avName || t("tool.list_databases.unnamed"),
                    id: r.avID,
                    hpath: r.hPath || "/",
                    views: (r.children ?? []).map((v: any) => v.viewName).filter(Boolean).join("/") || "-",
                }));
                return {content: text(`${t("tool.list_databases.count", {count: rows.length})}\n${lines.join("\n")}`), details: {rows}};
            },
        },
        {
            name: "create_database",
            label: t("tool.create_database.label"),
            description: t("tool.create_database.desc"),
            parameters: Type.Object({
                parent_document_id: Type.String({description: t("tool.create_database.p.parent_document_id")}),
                name: Type.Optional(Type.String({description: t("tool.create_database.p.name")})),
                columns: Type.Optional(Type.Array(Type.Object({
                    name: Type.String({description: t("tool.create_database.p.colName")}),
                    type: Type.String({description: t("tool.add_database_column.p.type")}),
                    options: Type.Optional(Type.Array(Type.String(), {description: t("tool.add_database_column.p.options")})),
                }), {description: t("tool.create_database.p.columns")})),
            }),
            execute: async (_id, params: any) => {
                const parentID = String(params.parent_document_id).trim();
                // 1) 插入数据库块(内核会自动分配块 id 与 data-av-id)
                const insertData = await client.request<any>("/api/block/insertBlock", {
                    dataType: "dom",
                    data: "<div data-type=\"NodeAttributeView\" data-av-type=\"table\"></div>",
                    parentID,
                });
                const blockID = insertData?.[0]?.doOperations?.[0]?.id;
                if (!blockID) {
                    throw new Error(t("tool.create_database.insertFailed"));
                }
                // 2) 从渲染 DOM 取内核分配的 database_id(data-av-id)
                const dom = String((await client.request<any>("/api/block/getBlockDOM", {id: blockID}))?.dom ?? "");
                const avID = dom.match(/data-av-id="([^"]+)"/)?.[1];
                if (!avID) {
                    throw new Error(t("tool.create_database.noAvId"));
                }
                // 3) 渲染一次以初始化数据库文件(生成默认主键列与表格视图)
                const boot = await client.request<any>("/api/av/renderAttributeView", {id: avID, blockID});
                const bootCols: any[] = boot?.view?.columns ?? [];
                // 4) 命名 + 预建列(含单选/多选选项)
                const ops: Array<Record<string, unknown>> = [];
                const dbName = String(params.name ?? "").trim();
                if (dbName) {
                    ops.push({action: "setAttrViewName", id: avID, data: dbName});
                }
                let previousID = String(bootCols[bootCols.length - 1]?.id ?? "");
                for (const def of (Array.isArray(params.columns) ? params.columns : [])) {
                    const colID = newAvId();
                    const colType = String(def?.type ?? "text");
                    ops.push({action: "addAttrViewCol", id: colID, avID, name: String(def?.name ?? ""), type: colType, previousID});
                    const optNames = (def?.options ?? []).map(String).map((x: string) => x.trim()).filter(Boolean);
                    if (optNames.length > 0 && (colType === "select" || colType === "mSelect")) {
                        ops.push({
                            action: "updateAttrViewColOptions", id: colID, avID,
                            data: optNames.map((name: string, i: number) => ({name, color: String((i % 13) + 1)})),
                        });
                    }
                    previousID = colID;
                }
                if (ops.length > 0) {
                    await avTx(client, ops);
                }
                return {
                    content: text(t("tool.create_database.done", {name: dbName || avID, id: avID, block: blockID})),
                    details: {databaseID: avID, blockID, parentDocumentID: parentID},
                };
            },
        },
        {
            name: "get_database",
            label: t("tool.get_database.label"),
            description: t("tool.get_database.desc"),
            parameters: Type.Object({
                database_id: Type.String({description: t("tool.p.databaseId")}),
            }),
            execute: async (_id, params: any) => {
                const avID = String(params.database_id).trim();
                const meta = await getAvMeta(client, avID);
                const keys = meta.keys;
                const out = [t("tool.get_database.title", {name: meta.name || avID})];
                if (meta.views.length > 0) {
                    out.push(t("tool.get_database.views", {
                        views: meta.views.map((v) => `${v.name} (view_id: ${v.id})`).join("; "),
                    }));
                }
                out.push(t("tool.get_database.columns", {count: keys.length}));
                for (const k of keys) {
                    const opts = (k.type === "select" || k.type === "mSelect") && k.options?.length
                        ? t("tool.get_database.options", {options: k.options.map((o) => o.name).join("/")})
                        : "";
                    out.push(`- ${k.name} (${k.type}${opts})`);
                }
                return {content: text(out.join("\n")), details: {name: meta.name, views: meta.views, keys}};
            },
        },
        {
            name: "query_database",
            label: t("tool.query_database.label"),
            description: t("tool.query_database.desc"),
            parameters: Type.Object({
                database_id: Type.String({description: t("tool.p.databaseId")}),
                view_id: Type.Optional(Type.String({description: t("tool.query_database.p.view_id")})),
                page: Type.Optional(Type.Number({description: t("tool.query_database.p.page")})),
                page_size: Type.Optional(Type.Number({description: t("tool.query_database.p.page_size")})),
                query: Type.Optional(Type.String({description: t("tool.query_database.p.query")})),
            }),
            execute: async (_id, params: any) => {
                const avID = String(params.database_id).trim();
                let viewID = String(params.view_id ?? "").trim();
                let avName = "";
                if (!viewID) {
                    const meta = await getAvMeta(client, avID);
                    avName = meta.name;
                    viewID = meta.views.find((v) => v.type === "table")?.id ?? meta.views[0]?.id ?? "";
                }
                if (!viewID) {
                    throw new Error(t("tool.query_database.noView"));
                }
                const page = Math.max(1, Math.trunc(params.page ?? 1));
                const pageSize = Math.min(Math.max(Math.trunc(params.page_size ?? 50), 1), 200);
                const data = await client.request<any>("/api/av/renderAttributeView", {
                    id: avID, viewID, page, pageSize, query: String(params.query ?? ""),
                });
                const view = data?.view ?? data;
                // 3.8+: 列/行直接在 view 上;旧版在 view.table 下
                const table = view?.table ?? (Array.isArray(view?.columns) ? view : undefined);
                if (!table) {
                    throw new Error(t("tool.query_database.notTable"));
                }
                const columns: any[] = table.columns ?? [];
                const rows: any[] = table.rows ?? [];
                const out = [t("tool.query_database.header", {
                    name: avName || avID, view: view.name ?? viewID, page, total: table.rowCount ?? rows.length,
                })];
                if (rows.length === 0) {
                    out.push(t("tool.query_database.empty"));
                } else {
                    rows.forEach((r, i) => {
                        const cells = (r.cells ?? []).map((c: any) => avCellText(c?.value ?? c));
                        out.push(`${(page - 1) * pageSize + i + 1}. ${cells.join(" | ")} (row_id: ${r.id})`);
                    });
                }
                return {
                    content: text(truncate(out.join("\n"))),
                    details: {viewID, rowCount: table.rowCount ?? rows.length, columns, rows},
                };
            },
        },
        {
            name: "add_database_row",
            label: t("tool.add_database_row.label"),
            description: t("tool.add_database_row.desc"),
            parameters: Type.Object({
                database_id: Type.String({description: t("tool.p.databaseId")}),
                values: Type.Record(Type.String(), Type.Any(), {description: t("tool.add_database_row.p.values")}),
            }),
            execute: async (_id, params: any) => {
                const avID = String(params.database_id).trim();
                const keys = await getAvKeys(client, avID);
                const rowValues: any[] = [];
                for (const [colName, v] of Object.entries(params.values ?? {})) {
                    const key = findAvKey(keys, colName);
                    if (key.type === "select") {
                        await ensureSelectOptions(client, avID, key, [String(v)]);
                    } else if (key.type === "mSelect") {
                        await ensureSelectOptions(client, avID, key, mSelectNames(v));
                    }
                    rowValues.push({id: newAvId(), keyID: key.id, type: key.type, ...avValueFor(key, v)});
                }
                await client.request("/api/av/appendAttributeViewDetachedBlocksWithValues", {avID, blocksValues: [rowValues]});
                return {content: text(t("tool.add_database_row.done")), details: {added: 1}};
            },
        },
        {
            name: "update_database_cell",
            label: t("tool.update_database_cell.label"),
            description: t("tool.update_database_cell.desc"),
            parameters: Type.Object({
                database_id: Type.String({description: t("tool.p.databaseId")}),
                row_id: Type.String({description: t("tool.update_database_cell.p.row_id")}),
                column: Type.String({description: t("tool.update_database_cell.p.column")}),
                value: Type.Any({description: t("tool.update_database_cell.p.value")}),
            }),
            execute: async (_id, params: any) => {
                const avID = String(params.database_id).trim();
                const rowID = String(params.row_id).trim();
                const keys = await getAvKeys(client, avID);
                const key = findAvKey(keys, String(params.column));
                if (key.type === "select") {
                    await ensureSelectOptions(client, avID, key, [String(params.value)]);
                } else if (key.type === "mSelect") {
                    await ensureSelectOptions(client, avID, key, mSelectNames(params.value));
                }
                const value = {keyID: key.id, blockID: rowID, type: key.type, ...avValueFor(key, params.value)};
                await avTx(client, [{action: "updateAttrViewCell", id: "", avID, keyID: key.id, rowID, data: value}]);
                return {content: text(t("tool.update_database_cell.done", {row: rowID, column: key.name})), details: {rowID, keyID: key.id}};
            },
        },
        apiTool({
            name: "remove_database_rows",
            label: t("tool.remove_database_rows.label"),
            description: t("tool.remove_database_rows.desc"),
            endpoint: "/api/av/removeAttributeViewBlocks",
            schema: Type.Object({
                database_id: Type.String({description: t("tool.p.databaseId")}),
                row_ids: Type.Array(Type.String(), {description: t("tool.remove_database_rows.p.row_ids")}),
            }),
            map: (p) => ({avID: p.database_id, srcIDs: p.row_ids}),
            done: (p) => t("tool.remove_database_rows.done", {count: p.row_ids.length}),
        }),
        {
            name: "add_database_column",
            label: t("tool.add_database_column.label"),
            description: t("tool.add_database_column.desc"),
            parameters: Type.Object({
                database_id: Type.String({description: t("tool.p.databaseId")}),
                name: Type.String({description: t("tool.add_database_column.p.name")}),
                type: Type.String({description: t("tool.add_database_column.p.type")}),
                options: Type.Optional(Type.Array(Type.String(), {description: t("tool.add_database_column.p.options")})),
            }),
            execute: async (_id, params: any) => {
                const avID = String(params.database_id).trim();
                const keys = await getAvKeys(client, avID);
                const colID = newAvId();
                const colType = String(params.type);
                const ops: Array<Record<string, unknown>> = [{
                    action: "addAttrViewCol", id: colID, avID,
                    name: String(params.name), type: colType,
                    previousID: keys[keys.length - 1]?.id ?? "",
                }];
                const optNames = (params.options ?? []).map(String).map((x: string) => x.trim()).filter(Boolean);
                if (optNames.length > 0 && (colType === "select" || colType === "mSelect")) {
                    ops.push({
                        action: "updateAttrViewColOptions", id: colID, avID,
                        data: optNames.map((name: string, i: number) => ({name, color: String((i % 13) + 1)})),
                    });
                }
                await avTx(client, ops);
                return {
                    content: text(t("tool.add_database_column.done", {name: params.name, type: colType})),
                    details: {keyID: colID},
                };
            },
        },
        {
            name: "rename_database_column",
            label: t("tool.rename_database_column.label"),
            description: t("tool.rename_database_column.desc"),
            parameters: Type.Object({
                database_id: Type.String({description: t("tool.p.databaseId")}),
                column: Type.String({description: t("tool.rename_database_column.p.column")}),
                new_name: Type.String({description: t("tool.rename_database_column.p.new_name")}),
            }),
            execute: async (_id, params: any) => {
                const avID = String(params.database_id).trim();
                const key = findAvKey(await getAvKeys(client, avID), String(params.column));
                await avTx(client, [{action: "updateAttrViewCol", id: key.id, avID, name: String(params.new_name), type: key.type}]);
                return {content: text(t("tool.rename_database_column.done", {old: key.name, name: params.new_name})), details: {keyID: key.id}};
            },
        },
        {
            name: "remove_database_column",
            label: t("tool.remove_database_column.label"),
            description: t("tool.remove_database_column.desc"),
            parameters: Type.Object({
                database_id: Type.String({description: t("tool.p.databaseId")}),
                column: Type.String({description: t("tool.remove_database_column.p.column")}),
            }),
            execute: async (_id, params: any) => {
                const avID = String(params.database_id).trim();
                const key = findAvKey(await getAvKeys(client, avID), String(params.column));
                await avTx(client, [{action: "removeAttrViewCol", id: key.id, avID}]);
                return {content: text(t("tool.remove_database_column.done", {name: key.name})), details: {keyID: key.id}};
            },
        },

        // ------------------------------------------------ 快照与查询
        apiTool({
            name: "list_snapshots",
            label: t("tool.list_snapshots.label"),
            description: t("tool.list_snapshots.desc"),
            endpoint: "/api/repo/getRepoSnapshots",
            schema: Type.Object({}),
            present: (data) => {
                const list = data?.snapshots ?? [];
                if (list.length === 0) {
                    return t("tool.list_snapshots.empty");
                }
                return t("tool.list_snapshots.count", {count: list.length}) + "\n" + list.slice(0, 30).map((s: any) =>
                    `- ${s.created ?? ""} ${s.memo ?? ""} (id: ${s.id})`).join("\n");
            },
        }),
        apiTool({
            name: "create_snapshot",
            label: t("tool.create_snapshot.label"),
            description: t("tool.create_snapshot.desc"),
            endpoint: "/api/repo/createSnapshot",
            schema: Type.Object({memo: Type.Optional(Type.String({description: t("tool.create_snapshot.p.memo")}))}),
            map: (p) => ({memo: p.memo ?? t("tool.create_snapshot.defaultMemo")}),
        }),
        {
            name: "query_sql",
            label: t("tool.query_sql.label"),
            description: t("tool.query_sql.desc"),
            parameters: Type.Object({
                stmt: Type.String({description: t("tool.query_sql.p.stmt")}),
            }),
            execute: async (_id, params: any) => {
                const stmt = String(params.stmt ?? "").trim();
                if (!/^select\s/i.test(stmt)) {
                    throw new Error(t("tool.query_sql.onlySelect"));
                }
                const rows = await client.sql(stmt);
                return {content: text(`${t("tool.query_sql.count", {count: rows.length})}\n${jsonText(rows)}`), details: {rows}};
            },
        },

        // ------------------------------------------------ 联网(走内核转发代理,绕过 CORS)
        {
            name: "web_search",
            label: t("tool.web_search.label"),
            description: t("tool.web_search.desc"),
            parameters: Type.Object({
                query: Type.String({description: t("tool.web_search.p.query")}),
                limit: Type.Optional(Type.Number({description: t("tool.web_search.p.limit")})),
            }),
            execute: async (_id, params: any) => {
                const limit = Math.min(Math.max(Math.trunc(params.limit ?? 8), 1), 20);
                const q = String(params.query ?? "").trim();
                if (!q) {
                    throw new Error(t("tool.search_notes.queryEmpty"));
                }
                // 引擎顺序:设置页的首选引擎优先,其余自动作为后备,最后兜底 Jina Reader
                const preferred = options?.searchEngine ?? "duckduckgo";
                const order = [...SEARCH_ENGINES].sort((a, b) =>
                    (a.id === preferred ? -1 : 0) + (b.id === preferred ? 1 : 0));
                let hits: WebHit[] = [];
                let engine = "";
                for (const eng of order) {
                    try {
                        const resp = await webGet(client, eng.url(q));
                        hits = eng.parse(resp.body, limit);
                    } catch { /* 尝试下一个引擎 */ }
                    if (hits.length > 0) {
                        engine = eng.name;
                        break;
                    }
                }
                if (hits.length === 0) {
                    try {
                        const md = await jinaReaderGet(client, SEARCH_ENGINES[0].url(q));
                        hits = parseJinaSearch(md, limit);
                        if (hits.length > 0) {
                            engine = "DuckDuckGo (Jina Reader)";
                        }
                    } catch { /* 网络全断 */ }
                }
                if (hits.length === 0) {
                    return {content: text(t("tool.web_search.empty", {query: q})), details: {hits}};
                }
                const lines = hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}${h.snippet ? `\n   ${h.snippet}` : ""}`);
                return {
                    content: text(`${t("tool.web_search.header", {engine, count: hits.length})}\n${lines.join("\n")}\n\n${t("tool.web_search.useFetch")}`),
                    details: {engine, hits},
                };
            },
        },
        {
            name: "web_fetch",
            label: t("tool.web_fetch.label"),
            description: t("tool.web_fetch.desc"),
            parameters: Type.Object({
                url: Type.String({description: t("tool.web_fetch.p.url")}),
                max_length: Type.Optional(Type.Number({description: t("tool.web_fetch.p.max_length", {max: MAX_CONTENT})})),
            }),
            execute: async (_id, params: any) => {
                const url = String(params.url ?? "").trim();
                if (!/^https?:\/\//i.test(url)) {
                    throw new Error(t("tool.web_fetch.urlInvalid"));
                }
                const max = Math.min(Math.max(Math.trunc(params.max_length ?? MAX_CONTENT), 500), 40000);
                let body = "";
                let status = 0;
                let via = "";
                try {
                    const resp = await webGet(client, url);
                    status = resp.status;
                    via = resp.via;
                    const isHtml = /html|xml/i.test(resp.contentType) || /^\s*</.test(resp.body.slice(0, 200));
                    body = isHtml ? htmlToText(resp.body) : resp.body;
                } catch { /* 直连失败,尝试 Jina Reader */ }
                if (!body.trim()) {
                    via = "Jina Reader";
                    try {
                        body = await jinaReaderGet(client, url);
                    } catch { /* 网络全断 */ }
                }
                if (!body.trim()) {
                    return {content: text(t("tool.web_fetch.failed", {url})), details: {url}};
                }
                return {
                    content: text(`${t("tool.web_fetch.content", {url, status: status || 200, via})}\n\n${truncate(body, max)}`),
                    details: {url, status, via, length: body.length},
                };
            },
        },
    ];

    // ------------------------------------------------ 前端能力(操作思源界面)
    if (app) {
        const frontend = (def: Omit<AgentTool<any>, "execute"> & {execute: AgentTool<any>["execute"]}): AgentTool<any> =>
            Object.assign(def, {frontend: true} as any);

        tools.push(
            frontend({
                name: "open_document",
                label: t("tool.open_document.label"),
                description: t("tool.open_document.desc"),
                parameters: Type.Object({id: Type.String({description: t("tool.open_document.p.id")})}),
                execute: async (_id, params: any) => {
                    if (!params.id) {
                        throw new Error(t("tool.open_document.missingId"));
                    }
                    await openTab({app, doc: {id: String(params.id)}});
                    return {content: text(t("tool.open_document.done", {id: params.id})), details: {id: params.id}};
                },
            }),
            frontend({
                name: "focus_block",
                label: t("tool.focus_block.label"),
                description: t("tool.focus_block.desc"),
                parameters: Type.Object({id: Type.String({description: t("tool.focus_block.p.id")})}),
                execute: async (_id, params: any) => {
                    const target = document.querySelector(`.protyle-wysiwyg [data-node-id="${params.id}"]`);
                    if (!target) {
                        return {content: text(t("tool.focus_block.notLoaded", {id: params.id})), details: {found: false}};
                    }
                    target.scrollIntoView({behavior: "smooth", block: "center"});
                    target.classList.add("sy-ai-agent-focus-flash");
                    setTimeout(() => target.classList.remove("sy-ai-agent-focus-flash"), 2000);
                    return {content: text(t("tool.focus_block.done", {id: params.id})), details: {found: true}};
                },
            }),
            frontend({
                name: "open_search",
                label: t("tool.open_search.label"),
                description: t("tool.open_search.desc"),
                parameters: Type.Object({query: Type.Optional(Type.String({description: t("tool.open_search.p.query")}))}),
                execute: async (_id, params: any) => {
                    const btn = document.getElementById("barSearch");
                    if (!btn) {
                        throw new Error(t("tool.open_search.entryNotFound"));
                    }
                    btn.click();
                    const q = String(params.query ?? "").trim();
                    if (q) {
                        setTimeout(() => {
                            const input = document.querySelector<HTMLInputElement>("#searchInput");
                            if (input) {
                                input.value = q;
                                input.dispatchEvent(new Event("input", {bubbles: true}));
                            }
                        }, 400);
                    }
                    return {content: text(q ? t("tool.open_search.doneQuery", {query: q}) : t("tool.open_search.done")), details: {query: q}};
                },
            }),
            frontend({
                name: "open_setting",
                label: t("tool.open_setting.label"),
                description: t("tool.open_setting.desc"),
                parameters: Type.Object({query: Type.Optional(Type.String({description: t("tool.open_setting.p.query")}))}),
                execute: async (_id, params: any) => {
                    const more = document.getElementById("barMore");
                    if (!more) {
                        throw new Error(t("tool.open_setting.entryNotFound"));
                    }
                    more.click();
                    await new Promise((r) => setTimeout(r, 200));
                    const menuEl = (window as any).siyuan?.menus?.menu?.element as HTMLElement | undefined;
                    const label = (window as any).siyuan?.languages?.config ?? t("settings");
                    const item = menuEl
                        ? Array.from(menuEl.querySelectorAll<HTMLElement>(".b3-menu__item"))
                            .find((i) => i.textContent?.includes(label))
                        : undefined;
                    if (!item) {
                        throw new Error(t("tool.open_setting.menuFailed"));
                    }
                    item.click();
                    const q = String(params.query ?? "").trim();
                    if (q) {
                        setTimeout(() => {
                            const input = document.querySelector<HTMLInputElement>(".config__side .b3-text-field");
                            if (input) {
                                input.value = q;
                                input.dispatchEvent(new Event("input", {bubbles: true}));
                            }
                        }, 500);
                    }
                    return {content: text(q ? t("tool.open_setting.doneQuery", {query: q}) : t("tool.open_setting.done")), details: {query: q}};
                },
            }),
        );
    }

    return tools;
}
