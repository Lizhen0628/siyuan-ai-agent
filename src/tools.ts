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

/** 返回给模型的正文最大长度,避免工具结果撑爆上下文。 */
const MAX_CONTENT = 12000;

function text(s: string): TextContent[] {
    return [{type: "text", text: s}];
}

function truncate(s: string, max = MAX_CONTENT): string {
    if (s.length <= max) {
        return s;
    }
    return `${s.slice(0, max)}\n…(内容过长已截断,共 ${s.length} 字符)`;
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
            return {...r, via: "内核代理"};
        }
    } catch { /* 内核网络不通,尝试渲染进程 */ }
    const resp = await fetch(url, {headers: {Accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.8"}});
    const body = await resp.text();
    if (!resp.ok && !body) {
        throw new Error(`HTTP ${resp.status}`);
    }
    return {body, contentType: resp.headers.get("content-type") ?? "", status: resp.status, via: "浏览器"};
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
    "append_block",
    "prepend_block",
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
];

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
            return {content: text(body ?? `${def.done ? def.done(params) : `${def.label}完成。`}\n${jsonText(data)}`), details: data};
        },
    });

    const tools: AgentTool<any>[] = [
        // ------------------------------------------------ 笔记本
        {
            name: "list_notebooks",
            label: "列出笔记本",
            description: "列出思源笔记中所有已打开的笔记本(id 与名称)。创建文档前需要先获取 notebook id。",
            parameters: Type.Object({}),
            execute: async () => {
                const notebooks = await client.listNotebooks();
                if (notebooks.length === 0) {
                    return {content: text("当前没有已打开的笔记本。"), details: {notebooks}};
                }
                const lines = notebooks.map((n) => `- ${n.name} (id: ${n.id})`);
                return {content: text(`共有 ${notebooks.length} 个笔记本:\n${lines.join("\n")}`), details: {notebooks}};
            },
        },
        apiTool({
            name: "create_notebook",
            label: "创建笔记本",
            description: "创建一个新笔记本。",
            endpoint: "/api/notebook/createNotebook",
            schema: Type.Object({name: Type.String({description: "笔记本名称"})}),
            map: (p) => ({name: p.name}),
        }),
        apiTool({
            name: "rename_notebook",
            label: "重命名笔记本",
            description: "重命名一个笔记本。",
            endpoint: "/api/notebook/renameNotebook",
            schema: Type.Object({
                id: Type.String({description: "笔记本 id"}),
                name: Type.String({description: "新名称"}),
            }),
        }),
        apiTool({
            name: "remove_notebook",
            label: "删除笔记本",
            description: "删除一个笔记本及其全部文档,不可恢复。这是高危破坏性操作。",
            endpoint: "/api/notebook/removeNotebook",
            schema: Type.Object({id: Type.String({description: "笔记本 id"})}),
        }),

        // ------------------------------------------------ 文档
        apiTool({
            name: "search_docs",
            label: "搜索文档",
            description: "按文件名关键字搜索文档,返回所在笔记本 id、路径与可读路径。",
            endpoint: "/api/filetree/searchDocs",
            schema: Type.Object({keyword: Type.String({description: "文档名关键字"})}),
            map: (p) => ({k: p.keyword}),
            present: (data) => {
                const list = Array.isArray(data) ? data : [];
                if (list.length === 0) {
                    return "没有找到匹配的文档。";
                }
                return `找到 ${list.length} 篇文档:\n` + list.map((d: any) =>
                    `- ${d.hPath || d.path} (笔记本 id: ${d.box}, path: ${d.path})`).join("\n");
            },
        }),
        {
            name: "list_docs",
            label: "列出文档",
            description: "列出指定笔记本(可选路径前缀)下的文档,返回文档 id 与路径。",
            parameters: Type.Object({
                notebook: Type.String({description: "笔记本 id"}),
                path: Type.Optional(Type.String({description: "路径前缀,如 /日记,默认为全部"})),
                limit: Type.Optional(Type.Number({description: "最多返回条数,默认 100"})),
            }),
            execute: async (_id, params: any) => {
                const limit = Math.min(Math.max(Math.trunc(params.limit ?? 100), 1), 500);
                const prefix = String(params.path ?? "");
                const rows = await client.sql<{id: string; hpath: string}>(
                    `SELECT id, hpath FROM blocks WHERE type='d' AND box='${sqlQuote(params.notebook)}' ` +
                    `AND hpath LIKE '${sqlQuote(prefix)}%' ORDER BY hpath LIMIT ${limit}`);
                if (rows.length === 0) {
                    return {content: text("该范围内没有文档。"), details: {rows}};
                }
                const lines = rows.map((r) => `- ${r.hpath} (id: ${r.id})`);
                return {content: text(`共 ${rows.length} 篇文档:\n${lines.join("\n")}`), details: {rows}};
            },
        },
        {
            name: "create_note",
            label: "创建文档",
            description: "在指定笔记本中以 Markdown 创建一篇新文档。path 为文档层级路径,如 \"/日记/2026/9月9日\"。",
            parameters: Type.Object({
                notebook: Type.String({description: "笔记本 id(用 list_notebooks 获取)"}),
                path: Type.String({description: "文档路径,以 / 开头,最后一段为文档标题"}),
                markdown: Type.String({description: "文档的 Markdown 内容"}),
            }),
            execute: async (_id, params: any) => {
                const docId = await client.createDocWithMd(params.notebook, params.path, params.markdown);
                return {
                    content: text(`已创建文档"${params.path}"(id: ${docId || "未知"})。`),
                    details: {docId, path: params.path},
                };
            },
        },
        {
            name: "read_note",
            label: "读取文档",
            description: "读取一篇完整文档并返回其 Markdown 内容。需要文档(或其中任意块)的 id;" +
                "文档 id 通常来自 search_notes 结果中的 root_id。",
            parameters: Type.Object({
                doc_id: Type.String({description: "文档 id 或文档内任意块的 id"}),
            }),
            execute: async (_id, params: any) => {
                const data = await client.exportDocMarkdown(String(params.doc_id));
                if (!data.content) {
                    return {content: text(`文档 ${params.doc_id} 为空或不存在。`), details: data};
                }
                return {content: text(`路径: ${data.hpath || "/"}\n\n${truncate(data.content)}`), details: data};
            },
        },
        apiTool({
            name: "rename_doc",
            label: "重命名文档",
            description: "修改文档标题(路径最后一段)。",
            endpoint: "/api/filetree/renameDocByID",
            schema: Type.Object({
                doc_id: Type.String({description: "文档 id"}),
                title: Type.String({description: "新标题"}),
            }),
            map: (p) => ({id: p.doc_id, title: p.title}),
        }),
        apiTool({
            name: "move_doc",
            label: "移动文档",
            description: "把文档移动到另一个位置:to 为目标父文档 id 或目标笔记本 id(移动到根)。",
            endpoint: "/api/filetree/moveDocsByID",
            schema: Type.Object({
                doc_id: Type.String({description: "要移动的文档 id"}),
                to: Type.String({description: "目标父文档 id 或目标笔记本 id"}),
            }),
            map: (p) => ({fromIDs: [p.doc_id], toID: p.to}),
        }),
        apiTool({
            name: "remove_doc",
            label: "删除文档",
            description: "删除整篇文档,不可恢复。这是破坏性操作。",
            endpoint: "/api/filetree/removeDocByID",
            schema: Type.Object({doc_id: Type.String({description: "文档 id"})}),
            map: (p) => ({id: p.doc_id}),
        }),

        // ------------------------------------------------ 块
        {
            name: "search_notes",
            label: "搜索笔记",
            description:
                "在思源笔记全文中搜索包含关键词的块。返回块 id、所在文档路径、块类型和内容摘要。" +
                "优先使用单个关键词或短语;多个关键词可用空格分隔(AND 语义)。",
            parameters: Type.Object({
                query: Type.String({description: "搜索关键词或短语"}),
                limit: Type.Optional(Type.Number({description: "最多返回条数,默认 20,最大 50"})),
            }),
            execute: async (_id, params: any) => {
                const limit = Math.min(Math.max(Math.trunc(params.limit ?? 20), 1), 50);
                const words = String(params.query).trim().split(/\s+/).filter(Boolean);
                if (words.length === 0) {
                    throw new Error("query 不能为空");
                }
                const where = words.map((w) => `content LIKE '%${sqlQuote(w)}%'`).join(" AND ");
                const rows = await client.sql(
                    `SELECT id, root_id, hpath, type, content FROM blocks ` +
                    `WHERE ${where} AND type IN ${SEARCH_BLOCK_TYPES} ORDER BY updated DESC LIMIT ${limit + 1}`);
                const hasMore = rows.length > limit;
                const hits = rows.slice(0, limit);
                if (hits.length === 0) {
                    return {content: text(`没有找到包含"${params.query}"的块。`), details: {hits: []}};
                }
                const lines = hits.map((r: any, i: number) => {
                    const summary = String(r.content ?? "").replace(/\s+/g, " ").slice(0, 300);
                    return `${i + 1}. [${r.type}] ${r.hpath || "/"}\n   block_id: ${r.id} (文档 root_id: ${r.root_id})\n   ${summary}`;
                });
                const more = hasMore ? `\n(结果被截断,可缩小关键词或减小 limit)` : "";
                return {content: text(`找到 ${hits.length} 个相关块:\n${lines.join("\n")}${more}`), details: {hits}};
            },
        },
        {
            name: "read_block",
            label: "读取块",
            description: "读取单个块的 Kramdown 内容(比整篇文档更精准)。",
            parameters: Type.Object({
                block_id: Type.String({description: "块 id"}),
            }),
            execute: async (_id, params: any) => {
                const data = await client.getBlockKramdown(String(params.block_id));
                return {content: text(`块 ${data.id} 内容:\n\n${truncate(data.kramdown)}`), details: data};
            },
        },
        {
            name: "insert_block",
            label: "插入块",
            description: "在指定位置插入新的 Markdown 块。parent_id 表示插入为其子块;" +
                "previous_id 表示插入在该块之后。两者至少提供一个。",
            parameters: Type.Object({
                markdown: Type.String({description: "要插入的 Markdown 内容"}),
                parent_id: Type.Optional(Type.String({description: "父块 id"})),
                previous_id: Type.Optional(Type.String({description: "前一个块 id,新块插在其后"})),
            }),
            execute: async (_id, params: any) => {
                if (!params.parent_id && !params.previous_id) {
                    throw new Error("parent_id 与 previous_id 至少提供一个");
                }
                const ops = await client.insertBlock({
                    markdown: params.markdown,
                    parentID: params.parent_id,
                    previousID: params.previous_id,
                });
                return {content: text(`已插入块(共 ${Array.isArray(ops) ? ops.length : 0} 个操作)。`), details: {ops}};
            },
        },
        apiTool({
            name: "append_block",
            label: "追加块",
            description: "在指定父块的末尾追加 Markdown 内容。",
            endpoint: "/api/block/appendBlock",
            schema: Type.Object({
                parent_id: Type.String({description: "父块 id(文档则为文档 id)"}),
                markdown: Type.String({description: "Markdown 内容"}),
            }),
            map: (p) => ({dataType: "markdown", data: p.markdown, parentID: p.parent_id}),
        }),
        apiTool({
            name: "prepend_block",
            label: "前置块",
            description: "在指定父块的开头插入 Markdown 内容。",
            endpoint: "/api/block/prependBlock",
            schema: Type.Object({
                parent_id: Type.String({description: "父块 id(文档则为文档 id)"}),
                markdown: Type.String({description: "Markdown 内容"}),
            }),
            map: (p) => ({dataType: "markdown", data: p.markdown, parentID: p.parent_id}),
        }),
        {
            name: "update_block",
            label: "更新块",
            description: "用新的 Markdown/Kramdown 内容整体替换指定块。仅替换段落、标题等叶子块;" +
                "要修改文档请先 read_note 找到目标块 id。",
            parameters: Type.Object({
                block_id: Type.String({description: "要替换的块 id"}),
                markdown: Type.String({description: "新的 Markdown/Kramdown 内容"}),
            }),
            execute: async (_id, params: any) => {
                await client.updateBlock(String(params.block_id), params.markdown);
                return {content: text(`已更新块 ${params.block_id}。`), details: {blockId: params.block_id}};
            },
        },
        {
            name: "delete_block",
            label: "删除块",
            description: "删除指定块。删除文档请使用 remove_doc。这是破坏性操作,会先请求用户确认。",
            parameters: Type.Object({
                block_id: Type.String({description: "要删除的块 id"}),
            }),
            execute: async (_id, params: any) => {
                await client.deleteBlock(String(params.block_id));
                return {content: text(`已删除块 ${params.block_id}。`), details: {blockId: params.block_id}};
            },
        },
        apiTool({
            name: "move_block",
            label: "移动块",
            description: "移动块到新的位置:previous_id 表示排到该块之后,parent_id 表示成为其子块,至少提供一个。",
            endpoint: "/api/block/moveBlock",
            schema: Type.Object({
                block_id: Type.String({description: "要移动的块 id"}),
                previous_id: Type.Optional(Type.String({description: "目标位置前一块 id"})),
                parent_id: Type.Optional(Type.String({description: "目标父块 id"})),
            }),
            map: (p) => ({id: p.block_id, previousID: p.previous_id, parentID: p.parent_id}),
        }),

        // ------------------------------------------------ 标签
        apiTool({
            name: "search_tags",
            label: "搜索标签",
            description: "按关键字搜索工作区中的标签,返回标签与引用数。",
            endpoint: "/api/search/searchTag",
            schema: Type.Object({keyword: Type.Optional(Type.String({description: "关键字,留空列出全部"}))}),
            map: (p) => ({k: p.keyword ?? ""}),
            present: (data) => {
                const tags = data?.tags ?? [];
                if (tags.length === 0) {
                    return "没有找到标签。";
                }
                return `共 ${tags.length} 个标签:\n` + tags.map((t: any) => `- ${t.label ?? t.name} (${t.count ?? 0} 次引用)`).join("\n");
            },
        }),
        apiTool({
            name: "rename_tag",
            label: "重命名标签",
            description: "把工作区中的某个标签整体改名。",
            endpoint: "/api/tag/renameTag",
            schema: Type.Object({
                old: Type.String({description: "原标签名"}),
                new: Type.String({description: "新标签名"}),
            }),
            map: (p) => ({oldLabel: p.old, newLabel: p.new}),
        }),
        apiTool({
            name: "remove_tag",
            label: "移除标签",
            description: "从工作区中移除某个标签(不影响正文内容)。",
            endpoint: "/api/tag/removeTag",
            schema: Type.Object({label: Type.String({description: "标签名"})}),
        }),

        // ------------------------------------------------ 书签
        apiTool({
            name: "list_bookmarks",
            label: "列出书签",
            description: "列出工作区中的全部书签。",
            endpoint: "/api/attr/getBookmarkLabels",
            schema: Type.Object({}),
            present: (data) => {
                const list = Array.isArray(data) ? data : [];
                if (list.length === 0) {
                    return "当前没有书签。";
                }
                return `共 ${list.length} 个书签:\n` + list.map((b: any) => `- ${typeof b === "string" ? b : b.label ?? b.name}`).join("\n");
            },
        }),
        apiTool({
            name: "rename_bookmark",
            label: "重命名书签",
            description: "重命名一个书签。",
            endpoint: "/api/bookmark/renameBookmark",
            schema: Type.Object({
                old: Type.String({description: "原书签名"}),
                new: Type.String({description: "新书签名"}),
            }),
            map: (p) => ({oldLabel: p.old, newLabel: p.new}),
        }),
        apiTool({
            name: "remove_bookmark",
            label: "移除书签",
            description: "移除一个书签(不影响被书签的内容)。",
            endpoint: "/api/bookmark/removeBookmark",
            schema: Type.Object({label: Type.String({description: "书签名"})}),
        }),

        // ------------------------------------------------ 属性
        apiTool({
            name: "get_block_attrs",
            label: "获取块属性",
            description: "读取指定块的自定义属性(custom-*)。",
            endpoint: "/api/attr/getBlockAttrs",
            schema: Type.Object({block_id: Type.String({description: "块 id"})}),
            map: (p) => ({id: p.block_id}),
        }),
        apiTool({
            name: "set_block_attrs",
            label: "设置块属性",
            description: "为指定块设置自定义属性,键名须以 custom- 开头,值为空字符串表示删除该属性。",
            endpoint: "/api/attr/setBlockAttrs",
            schema: Type.Object({
                block_id: Type.String({description: "块 id"}),
                attrs: Type.Record(Type.String(), Type.String(), {description: "属性键值对,如 {\"custom-priority\": \"high\"}"}),
            }),
            map: (p) => ({id: p.block_id, attrs: p.attrs}),
        }),

        // ------------------------------------------------ 资源文件
        apiTool({
            name: "list_doc_assets",
            label: "列出文档资源",
            description: "列出指定文档引用/包含的资源文件。",
            endpoint: "/api/asset/getDocAssets",
            schema: Type.Object({doc_id: Type.String({description: "文档 id"})}),
            map: (p) => ({id: p.doc_id}),
        }),
        apiTool({
            name: "get_asset_content",
            label: "读取资源内容",
            description: "读取工作区内文本类资源文件的内容(如 assets 中的文本/Markdown)。",
            endpoint: "/api/search/getAssetContent",
            schema: Type.Object({path: Type.String({description: "资源路径,如 assets/xxx.md"})}),
            present: (data) => truncate(String(data?.content ?? jsonText(data))),
        }),
        apiTool({
            name: "rename_asset",
            label: "重命名资源",
            description: "重命名/移动资源文件。",
            endpoint: "/api/asset/renameAsset",
            schema: Type.Object({
                old_path: Type.String({description: "原路径"}),
                new_path: Type.String({description: "新路径"}),
            }),
            map: (p) => ({oldPath: p.old_path, newPath: p.new_path}),
        }),

        // ------------------------------------------------ 日记
        apiTool({
            name: "create_daily_note",
            label: "创建日记",
            description: "在指定笔记本中创建(或获取已有的)当天日记,返回文档 id。写日记前必须先调用本工具。",
            endpoint: "/api/filetree/createDailyNote",
            schema: Type.Object({notebook: Type.String({description: "笔记本 id"})}),
            map: (p) => ({id: p.notebook}),
            present: (data) => `今日日记文档 id: ${data?.id ?? "未知"}`,
        }),
        apiTool({
            name: "append_daily_note",
            label: "追加日记",
            description: "向指定笔记本的当天日记末尾追加 Markdown 内容。",
            endpoint: "/api/block/appendDailyNoteBlock",
            schema: Type.Object({
                notebook: Type.String({description: "笔记本 id"}),
                markdown: Type.String({description: "Markdown 内容"}),
            }),
            map: (p) => ({id: p.notebook, dataType: "markdown", data: p.markdown}),
        }),

        // ------------------------------------------------ 快照与查询
        apiTool({
            name: "list_snapshots",
            label: "列出数据快照",
            description: "列出本地数据仓库的快照列表(用于数据历史/回滚参考)。",
            endpoint: "/api/repo/getRepoSnapshots",
            schema: Type.Object({}),
            present: (data) => {
                const list = data?.snapshots ?? [];
                if (list.length === 0) {
                    return "还没有数据快照。";
                }
                return `共 ${list.length} 个快照:\n` + list.slice(0, 30).map((s: any) =>
                    `- ${s.created ?? ""} ${s.memo ?? ""} (id: ${s.id})`).join("\n");
            },
        }),
        apiTool({
            name: "create_snapshot",
            label: "创建数据快照",
            description: "为整个工作空间创建一次数据快照(索引可能耗时)。",
            endpoint: "/api/repo/createSnapshot",
            schema: Type.Object({memo: Type.Optional(Type.String({description: "快照备注"}))}),
            map: (p) => ({memo: p.memo ?? "由 SiYuan Agent 创建"}),
        }),
        {
            name: "query_sql",
            label: "SQL 查询",
            description: "对思源块数据库执行只读 SQL(SELECT)查询,表为 blocks,字段含 id/root_id/box/type/content/hpath 等。",
            parameters: Type.Object({
                stmt: Type.String({description: "SELECT 语句,如 SELECT id, hpath FROM blocks WHERE type='d' LIMIT 10"}),
            }),
            execute: async (_id, params: any) => {
                const stmt = String(params.stmt ?? "").trim();
                if (!/^select\s/i.test(stmt)) {
                    throw new Error("仅允许 SELECT 只读查询");
                }
                const rows = await client.sql(stmt);
                return {content: text(`共 ${rows.length} 行:\n${jsonText(rows)}`), details: {rows}};
            },
        },

        // ------------------------------------------------ 联网(走内核转发代理,绕过 CORS)
        {
            name: "web_search",
            label: "联网搜索",
            description:
                "在互联网上搜索关键词,返回标题、链接与摘要(首选引擎可在设置中配置,失败自动换引擎)。" +
                "用于查资料、新闻、文档等笔记本之外的信息;找到目标后用 web_fetch 读取全文。",
            parameters: Type.Object({
                query: Type.String({description: "搜索关键词,尽量精炼"}),
                limit: Type.Optional(Type.Number({description: "最多返回条数,默认 8,最大 20"})),
            }),
            execute: async (_id, params: any) => {
                const limit = Math.min(Math.max(Math.trunc(params.limit ?? 8), 1), 20);
                const q = String(params.query ?? "").trim();
                if (!q) {
                    throw new Error("query 不能为空");
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
                    return {content: text(`联网搜索没有找到与“${q}”相关的结果。可能是网络不可用或被搜索引擎拦截;请检查网络与代理设置后重试。`), details: {hits}};
                }
                const lines = hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}${h.snippet ? `\n   ${h.snippet}` : ""}`);
                return {
                    content: text(`联网搜索结果(${engine},共 ${hits.length} 条):\n${lines.join("\n")}\n\n如需正文请用 web_fetch 抓取对应链接。`),
                    details: {engine, hits},
                };
            },
        },
        {
            name: "web_fetch",
            label: "抓取网页",
            description:
                "抓取指定 URL 的网页并返回纯文本正文(自动去除脚本/样式)。" +
                "与 web_search 配合:先搜索找到链接,再抓取需要细读的页面。仅支持公开可访问的页面。",
            parameters: Type.Object({
                url: Type.String({description: "完整的 http(s) 链接"}),
                max_length: Type.Optional(Type.Number({description: `正文最大字符数,默认 ${MAX_CONTENT}`})),
            }),
            execute: async (_id, params: any) => {
                const url = String(params.url ?? "").trim();
                if (!/^https?:\/\//i.test(url)) {
                    throw new Error("url 必须是 http(s) 链接");
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
                    return {content: text(`抓取失败(${url}):网络不可用或目标站点拒绝访问。请检查网络与代理设置。`), details: {url}};
                }
                return {
                    content: text(`网页正文(${url},HTTP ${status || 200},经由${via}):\n\n${truncate(body, max)}`),
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
                label: "打开文档",
                description: "在思源编辑器中打开指定文档(按块 id)。",
                parameters: Type.Object({id: Type.String({description: "文档或块 id"})}),
                execute: async (_id, params: any) => {
                    if (!params.id) {
                        throw new Error("缺少参数: id");
                    }
                    await openTab({app, doc: {id: String(params.id)}});
                    return {content: text(`已打开文档 ${params.id}。`), details: {id: params.id}};
                },
            }),
            frontend({
                name: "focus_block",
                label: "定位块",
                description: "把已加载在编辑器中的某个块滚动到可视区域并高亮。",
                parameters: Type.Object({id: Type.String({description: "块 id"})}),
                execute: async (_id, params: any) => {
                    const target = document.querySelector(`.protyle-wysiwyg [data-node-id="${params.id}"]`);
                    if (!target) {
                        return {content: text(`块 ${params.id} 当前未加载在任何编辑器中,可先用 open_document 打开所在文档。`), details: {found: false}};
                    }
                    target.scrollIntoView({behavior: "smooth", block: "center"});
                    target.classList.add("sy-agent-focus-flash");
                    setTimeout(() => target.classList.remove("sy-agent-focus-flash"), 2000);
                    return {content: text(`已定位到块 ${params.id}。`), details: {found: true}};
                },
            }),
            frontend({
                name: "open_search",
                label: "打开搜索",
                description: "打开思源全局搜索界面,可选填入搜索词。",
                parameters: Type.Object({query: Type.Optional(Type.String({description: "搜索关键词"}))}),
                execute: async (_id, params: any) => {
                    const btn = document.getElementById("barSearch");
                    if (!btn) {
                        throw new Error("未找到搜索入口");
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
                    return {content: text(q ? `已打开搜索并填入"${q}"。` : "已打开搜索界面。"), details: {query: q}};
                },
            }),
            frontend({
                name: "open_setting",
                label: "打开设置",
                description: "打开思源设置窗口,可选按关键词过滤设置项。",
                parameters: Type.Object({query: Type.Optional(Type.String({description: "设置搜索关键词"}))}),
                execute: async (_id, params: any) => {
                    const more = document.getElementById("barMore");
                    if (!more) {
                        throw new Error("未找到设置入口");
                    }
                    more.click();
                    await new Promise((r) => setTimeout(r, 200));
                    const menuEl = (window as any).siyuan?.menus?.menu?.element as HTMLElement | undefined;
                    const label = (window as any).siyuan?.languages?.config ?? "设置";
                    const item = menuEl
                        ? Array.from(menuEl.querySelectorAll<HTMLElement>(".b3-menu__item"))
                            .find((i) => i.textContent?.includes(label))
                        : undefined;
                    if (!item) {
                        throw new Error("未能打开设置菜单");
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
                    return {content: text(q ? `已打开设置并过滤"${q}"。` : "已打开设置。"), details: {query: q}};
                },
            }),
        );
    }

    return tools;
}
