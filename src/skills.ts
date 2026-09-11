/**
 * 技能管理:内置技能(随插件发布) + 外部技能(SKILL.md 目录扫描)。
 * 外部技能扫描两个根目录:
 *   1. 全局用户目录 ~/.agents/skills(用户手工维护);
 *   2. 本插件数据存储目录 <工作区>/data/storage/petal/siyuan-ai-agent/skills
 *      (约定给别的插件安装技能用;同名 id 时本目录优先于全局目录)。
 * 启用的技能正文会注入系统提示词,引导智能体按技能流程工作。
 * 参考思源原生 设置-人工智能-技能:外部技能默认关闭、逐个启用。
 */
import type {AgentPluginConfig} from "./agent-runner";
import {isZh, t} from "./i18n";

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

/** 插件内置技能(名称/描述/正文跟随界面语言)。 */
export const BUILTIN_SKILLS: SkillInfo[] = [
    {
        id: "siyuan-daily-note",
        name: t("skillDailyName"),
        description: t("skillDailyDesc"),
        source: "builtin",
        body: t("skillDailyBody"),
    },
    {
        id: "siyuan-meeting-notes",
        name: t("skillMeetingName"),
        description: t("skillMeetingDesc"),
        source: "builtin",
        body: t("skillMeetingBody"),
    },
    {
        id: "siyuan-web-research",
        name: t("skillResearchName"),
        description: t("skillResearchDesc"),
        source: "builtin",
        body: t("skillResearchBody"),
    },
    {
        id: "siyuan-sql-query",
        name: t("skillSqlName"),
        description: t("skillSqlDesc"),
        source: "builtin",
        defaultEnabled: false,
        body: t("skillSqlBody"),
    },
    {
        id: "siyuan-batch-backup",
        name: t("skillBackupName"),
        description: t("skillBackupDesc"),
        source: "builtin",
        defaultEnabled: false,
        body: t("skillBackupBody"),
    },
    {
        id: "siyuan-tag-governance",
        name: t("skillTagsName"),
        description: t("skillTagsDesc"),
        source: "builtin",
        defaultEnabled: false,
        body: t("skillTagsBody"),
    },
    {
        id: "siyuan-doc-organize",
        name: t("skillOrganizeName"),
        description: t("skillOrganizeDesc"),
        source: "builtin",
        defaultEnabled: false,
        body: t("skillOrganizeBody"),
    },
];

/** 用户技能缓存(listUserSkills 异步加载,runner 同步读取)。 */
let userSkillsCache: SkillInfo[] = [];

/** 全局用户技能目录展示路径。 */
const GLOBAL_SKILLS_DISPLAY = "~/.agents/skills";
/** 插件存储技能目录(相对工作区),约定给其他插件安装技能用。 */
const STORAGE_SKILLS_REL = "data/storage/petal/siyuan-ai-agent/skills";
/** 插件存储技能目录展示路径(相对工作区,跨平台展示用 / 分隔)。 */
const STORAGE_SKILLS_DISPLAY = `${isZh() ? "<工作区>" : "<workspace>"}/${STORAGE_SKILLS_REL}`;

/**
 * 插件存储技能目录的绝对路径(仅桌面端可解析工作区路径;否则返回 null)。
 * 别的插件安装技能到此目录:<工作区>/data/storage/petal/siyuan-ai-agent/skills/<id>/SKILL.md
 */
export function getStorageSkillDir(): string | null {
    const workspaceDir = (window as any).siyuan?.config?.system?.workspaceDir;
    if (!workspaceDir) {
        return null;
    }
    const req = (window as any).require;
    if (!req) {
        return null;
    }
    const path = req("path") as typeof import("path");
    return path.join(workspaceDir, ...STORAGE_SKILLS_REL.split("/"));
}

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

/** 扫描单个技能根目录,返回其中的技能列表。 */
function scanSkillsDir(fs: typeof import("fs"), path: typeof import("path"), root: string, display: string): SkillInfo[] {
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
                path: `${display}/${dirent.name}`,
            });
        } catch {
            // 单个技能读取失败不影响整体
        }
    }
    return out;
}

/**
 * 扫描外部技能:插件存储目录(优先) + 全局 ~/.agents/skills。
 * 同名 id 去重(存储目录优先)。仅桌面端可用 node fs;浏览器/移动端返回空。
 */
export async function listUserSkills(): Promise<SkillInfo[]> {
    try {
        const req = (window as any).require;
        if (!req) {
            return [];
        }
        const fs = req("fs") as typeof import("fs");
        const path = req("path") as typeof import("path");
        const os = req("os") as typeof import("os");
        const out: SkillInfo[] = [];
        const seen = new Set<string>();
        // 插件存储目录:别的插件安装技能用;不存在则自动创建,方便第三方直接写入
        const storageDir = getStorageSkillDir();
        if (storageDir) {
            try {
                fs.mkdirSync(storageDir, {recursive: true});
            } catch {
                // 创建失败仍可继续扫描
            }
            for (const s of scanSkillsDir(fs, path, storageDir, STORAGE_SKILLS_DISPLAY)) {
                seen.add(s.id);
                out.push(s);
            }
        }
        // 全局用户目录
        const globalDir = path.join(os.homedir(), ".agents", "skills");
        for (const s of scanSkillsDir(fs, path, globalDir, GLOBAL_SKILLS_DISPLAY)) {
            if (seen.has(s.id)) {
                continue;
            }
            out.push(s);
        }
        return out;
    } catch {
        return [];
    }
}

/** 刷新用户技能缓存(插件加载与设置面板打开时调用,重新扫描两个技能目录)。 */
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
    const parts: string[] = ["", t("skillsSectionTitle"), t("skillsSectionIntro")];
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
