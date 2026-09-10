/**
 * 技能管理:内置技能(随插件发布) + 用户技能(~/.agents/skills/<id>/SKILL.md)。
 * 启用的技能正文会注入系统提示词,引导智能体按技能流程工作。
 * 参考思源原生 设置-人工智能-技能:外部技能默认关闭、逐个启用。
 */
import type {AgentPluginConfig} from "./agent-runner";

export interface SkillInfo {
    /** 目录名/内置 id */
    id: string;
    name: string;
    description: string;
    /** SKILL.md 正文(注入系统提示词的内容) */
    body: string;
    source: "builtin" | "user";
    /** 用户技能的路径展示用 */
    path?: string;
    /** 内置技能默认关闭(默认启用的不设该字段):开关记录在 userEnabled 集合 */
    defaultEnabled?: boolean;
}

/** 插件内置技能。 */
export const BUILTIN_SKILLS: SkillInfo[] = [
    {
        id: "siyuan-daily-note",
        name: "日记整理",
        description: "把随手记录整理成结构化的日记:归类、提炼待办与亮点",
        source: "builtin",
        body: `当用户要求整理日记/随手记时:
1. 先用 search_notes 或 read_note 读取相关内容;
2. 按「今日要点 / 待办 / 想法与灵感 / 摘录」归类;
3. 创建或更新当日日记文档(路径形如 /日记/2026/1月2日),保持原有内容不丢失;
4. 完成后简要汇报改动。`,
    },
    {
        id: "siyuan-meeting-notes",
        name: "会议纪要",
        description: "把会议记录整理为「议题 / 结论 / 行动项(负责人+期限)」结构",
        source: "builtin",
        body: `当用户要求整理会议纪要时:
1. 读取用户提供的原始记录;
2. 提炼为三段结构:议题与讨论要点、达成结论、行动项(标注负责人与期限,未知的留空);
3. 写入新文档或追加到用户指定文档;
4. 行动项使用思源待办列表语法 * [ ]。`,
    },
    {
        id: "siyuan-web-research",
        name: "联网调研",
        description: "查找笔记库之外的最新信息/资料的标准流程:搜索→筛选→精读→交叉验证→整理入库",
        source: "builtin",
        body: `当用户要求调研、查找、总结互联网上的信息(新闻、文档、评测、资料等)时:
1. 明确问题:先想清楚要回答什么;问题模糊时先与用户确认范围与用途。
2. 设计查询:构造 2-3 个互补的关键词(中英文都可尝试);太宽泛时加限定词(年份、官方、教程、评测等)。
3. 搜索筛选:用 web_search 获取结果,优先官方文档、权威媒体、原始出处;避开内容农场与营销稿。
4. 精读验证:用 web_fetch 抓取 2-3 个高质量来源的正文;关键结论至少两个来源交叉验证。
5. 整理输出:用 Markdown 结构化输出,关键事实标注来源链接;无法证实的信息明确说明,不要编造。
6. 询问入库:主动询问用户是否将调研结果整理进笔记(文档或当天日记),得到确认后再写入。
注意:
- 搜索结果不理想时换关键词重试,不要凭空编造。
- 网页抓取失败(反爬/需登录)时换其他来源,不要反复重试同一链接。
- 区分事实与观点;时效性信息注明查询日期。`,
    },
];

/** 用户技能缓存(listUserSkills 异步加载,runner 同步读取)。 */
let userSkillsCache: SkillInfo[] = [];

/** 解析 SKILL.md 的 YAML frontmatter(仅取 name/description,够列表展示用)。 */
function parseFrontmatter(raw: string): {name?: string; description?: string; body: string} {
    const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!m) {
        return {body: raw};
    }
    const meta: {name?: string; description?: string} = {};
    for (const line of m[1].split(/\r?\n/)) {
        const kv = line.match(/^(\w[\w-]*):\s*(.+?)\s*$/);
        if (kv && (kv[1] === "name" || kv[1] === "description")) {
            meta[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
        }
    }
    return {...meta, body: m[2]};
}

/** 扫描 ~/.agents/skills 下的用户技能(仅桌面端可用 node fs;浏览器/移动端返回空)。 */
export async function listUserSkills(): Promise<SkillInfo[]> {
    try {
        const req = (window as any).require;
        if (!req) {
            return [];
        }
        const fs = req("fs") as typeof import("fs");
        const path = req("path") as typeof import("path");
        const os = req("os") as typeof import("os");
        const root = path.join(os.homedir(), ".agents", "skills");
        if (!fs.existsSync(root)) {
            return [];
        }
        const out: SkillInfo[] = [];
        for (const dirent of fs.readdirSync(root, {withFileTypes: true})) {
            if (!dirent.isDirectory()) {
                continue;
            }
            const file = path.join(root, dirent.name, "SKILL.md");
            if (!fs.existsSync(file)) {
                continue;
            }
            try {
                const raw = fs.readFileSync(file, "utf8");
                const {name, description, body} = parseFrontmatter(raw);
                out.push({
                    id: dirent.name,
                    name: name || dirent.name,
                    description: description ?? "",
                    body,
                    source: "user",
                    path: `~/.agents/skills/${dirent.name}`,
                });
            } catch {
                // 单个技能读取失败不影响整体
            }
        }
        return out;
    } catch {
        return [];
    }
}

/** 刷新用户技能缓存(插件加载与设置页「刷新」时调用)。 */
export async function refreshUserSkills(): Promise<SkillInfo[]> {
    userSkillsCache = await listUserSkills();
    return userSkillsCache;
}

export function getUserSkillsCache(): SkillInfo[] {
    return userSkillsCache;
}

/** 当前配置下启用的技能(内置默认启用,用户技能默认关闭、逐个启用)。 */
/** 判断技能是否启用:默认启用的内置技能看 builtinDisabled;其余(用户技能/默认关闭的内置)看 userEnabled。 */
export function skillEnabled(s: SkillInfo, cfg: AgentPluginConfig): boolean {
    if (s.source === "builtin" && s.defaultEnabled !== false) {
        return !(cfg.skills?.builtinDisabled ?? []).includes(s.id);
    }
    return (cfg.skills?.userEnabled ?? []).includes(s.id);
}

export function enabledSkills(cfg: AgentPluginConfig): SkillInfo[] {
    return [...BUILTIN_SKILLS, ...userSkillsCache].filter((s) => skillEnabled(s, cfg));
}

/** 拼接到系统提示词的技能段(限制总长度,避免 token 爆炸)。 */
export function skillsPromptSection(cfg: AgentPluginConfig): string {
    const skills = enabledSkills(cfg);
    if (skills.length === 0) {
        return "";
    }
    let budget = 12000;
    const parts: string[] = ["", "# 已启用技能", "当用户任务与某项技能匹配时,遵循该技能的流程指引。"];
    for (const s of skills) {
        const body = s.body.trim().slice(0, Math.max(0, budget));
        if (!body) {
            break;
        }
        budget -= body.length;
        parts.push(`\n## ${s.name}`, body);
    }
    return parts.join("\n");
}
