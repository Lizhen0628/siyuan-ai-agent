/**
 * 思源内核 API 客户端。
 *
 * 插件运行在思源前端内，直接以同源相对路径请求内核即可；
 * Token 取自 window.siyuan.config.api.token（桌面端与浏览器端一致）。
 * 接口清单见内核源码 kernel/api/router.go。
 */
export class SiYuanClient {
    private get token(): string {
        return (window as any).siyuan?.config?.api?.token ?? "";
    }

    /** 通用内核 REST 调用(供能力工具使用)。 */
    async request<T = any>(endpoint: string, payload?: unknown): Promise<T> {
        return this.post<T>(endpoint, payload);
    }

    /**
     * 通过内核转发代理发起网络请求(内核侧执行 HTTP,天然绕过浏览器 CORS,
     * 与集市/推送走的通道一致)。timeout 单位为秒。
     */
    async webRequest(opts: {
        url: string;
        method?: string;
        timeout?: number;
        headers?: Record<string, string>;
        contentType?: string;
        payload?: string;
    }): Promise<{status: number; body: string; contentType: string}> {
        const headers = Object.entries(opts.headers ?? {}).map(([k, v]) => ({[k]: v}));
        const data = await this.post<any>("/api/network/forwardProxy", {
            url: opts.url,
            method: opts.method ?? "GET",
            timeout: opts.timeout ?? 60,
            headers,
            contentType: opts.contentType ?? "text/html",
            payload: opts.payload ?? "",
            responseEncoding: "text",
        });
        return {
            status: Number(data?.status ?? 0),
            body: typeof data?.body === "string" ? data.body : "",
            contentType: String(data?.contentType ?? ""),
        };
    }

    private async post<T = any>(endpoint: string, payload?: unknown): Promise<T> {
        const resp = await fetch(endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Token ${this.token}`,
            },
            body: JSON.stringify(payload ?? {}),
        });
        let data: any = null;
        try {
            data = await resp.json();
        } catch {
            throw new Error(`思源 API ${endpoint} 返回非 JSON(HTTP ${resp.status})`);
        }
        if (!resp.ok || (data && typeof data.code === "number" && data.code !== 0)) {
            throw new Error(`思源 API ${endpoint} 失败: HTTP ${resp.status} ${data?.msg ?? ""}`.trim());
        }
        return data.data as T;
    }

    async listNotebooks(): Promise<{id: string; name: string; closed: boolean}[]> {
        const data = await this.post<{notebooks: {id: string; name: string; closed: boolean}[]}>(
            "/api/notebook/lsNotebooks");
        return (data?.notebooks ?? []).filter((n) => !n.closed);
    }

    /** SQL 查询 blocks 表。 */
    async sql<T = Record<string, any>>(stmt: string): Promise<T[]> {
        const rows = await this.post<T[]>("/api/query/sql", {stmt});
        return rows ?? [];
    }

    /** 以 Markdown 导出整篇文档。 */
    async exportDocMarkdown(docId: string): Promise<{hpath: string; content: string}> {
        const data = await this.post<{hpath: string; content: string}>(
            "/api/export/exportMdContent", {id: docId});
        return {hpath: data?.hpath ?? "", content: data?.content ?? ""};
    }

    /** 读取单个块的 Kramdown。 */
    async getBlockKramdown(blockId: string): Promise<{id: string; kramdown: string; rootID: string}> {
        const data = await this.post<{id: string; kramdown: string; rootID: string}>(
            "/api/block/getBlockKramdown", {id: blockId});
        return data;
    }

    async createDocWithMd(notebook: string, path: string, markdown: string): Promise<string> {
        const data = await this.post<{data?: string}>("/api/filetree/createDocWithMd", {
            notebook, path, markdown,
        });
        return data?.data ?? "";
    }

    async insertBlock(opts: {
        markdown: string;
        parentID?: string;
        previousID?: string;
        nextID?: string;
    }): Promise<unknown[]> {
        const data = await this.post<unknown[]>("/api/block/insertBlock", {
            dataType: "markdown",
            data: opts.markdown,
            parentID: opts.parentID,
            previousID: opts.previousID,
            nextID: opts.nextID,
        });
        return data ?? [];
    }

    async updateBlock(blockId: string, markdown: string): Promise<unknown[]> {
        const data = await this.post<unknown[]>("/api/block/updateBlock", {
            dataType: "markdown",
            data: markdown,
            id: blockId,
        });
        return data ?? [];
    }

    async deleteBlock(blockId: string): Promise<unknown[]> {
        const data = await this.post<unknown[]>("/api/block/deleteBlock", {id: blockId});
        return data ?? [];
    }
}
