/**
 * 思源笔记工具集：把内核 REST API 包装成 pi 的 AgentTool。
 *
 * pi 的 AgentTool = {name, label, description, parameters(typebox), execute}.
 * 只读工具直接执行；写操作工具(创建/更新/插入/删除)由 Agent 的 beforeToolCall
 * 钩子弹出确认框(见 agent-runner.ts)。
 */
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

function sqlQuote(s: string): string {
    return s.replace(/'/g, "''");
}

const SEARCH_BLOCK_TYPES = "('p','h','c','t','b','s','html','math','code','table','audio','video')";

export type WriteToolName =
    | "create_note"
    | "update_block"
    | "insert_block"
    | "delete_block";

export const WRITE_TOOLS: readonly WriteToolName[] = [
    "create_note",
    "update_block",
    "insert_block",
    "delete_block",
];

export function createSiyuanTools(client: SiYuanClient): AgentTool<any>[] {
    const listNotebooks: AgentTool<any> = {
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
    };

    const searchNotes: AgentTool<any> = {
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
    };

    const readNote: AgentTool<any> = {
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
    };

    const readBlock: AgentTool<any> = {
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
    };

    const createNote: AgentTool<any> = {
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
    };

    const updateBlock: AgentTool<any> = {
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
    };

    const insertBlock: AgentTool<any> = {
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
    };

    const deleteBlock: AgentTool<any> = {
        name: "delete_block",
        label: "删除块",
        description: "删除指定块。删除文档请使用文档块 id(root_id)。这是破坏性操作,会先请求用户确认。",
        parameters: Type.Object({
            block_id: Type.String({description: "要删除的块 id"}),
        }),
        execute: async (_id, params: any) => {
            await client.deleteBlock(String(params.block_id));
            return {content: text(`已删除块 ${params.block_id}。`), details: {blockId: params.block_id}};
        },
    };

    return [
        listNotebooks,
        searchNotes,
        readNote,
        readBlock,
        createNote,
        updateBlock,
        insertBlock,
        deleteBlock,
    ];
}
