import crypto from "node:crypto";
import { db, decryptCloudSecret, encryptCloudSecret, getRepository } from "./db.js";
import { config } from "./env.js";

export type AppFieldKind =
  | "text"
  | "textarea"
  | "number"
  | "url"
  | "select"
  | "boolean";

export interface AppFieldDefinition {
  key: string;
  label: string;
  kind: AppFieldKind;
  required?: boolean;
  placeholder?: string;
  help?: string;
  options?: Array<{ value: string; label: string }>;
  defaultValue?: string | number | boolean;
  group?: string;
}

export interface AppTypeDefinition {
  id: string;
  label: string;
  short: string;
  description: string;
  fields: AppFieldDefinition[];
}

export interface ApplicationRecord {
  id: string;
  name: string;
  appType: string;
  appTypeLabel: string;
  repositoryId: string | null;
  repositoryName: string | null;
  targetProvider: string | null;
  environment: string;
  fields: Record<string, string | number | boolean>;
  status: string;
  isDemo: boolean;
  createdAt: string;
  updatedAt: string;
}

const APP_TYPE_DEFINITIONS: AppTypeDefinition[] = [
  {
    id: "web",
    label: "网站 / Web 应用",
    short: "WEB",
    description: "需要域名和网页访问地址的项目",
    fields: [
      {
        key: "runtimeKind",
        label: "运行方式",
        kind: "select",
        required: true,
        defaultValue: "static",
        options: [
          { value: "static", label: "静态网站（无需服务端）" },
          { value: "node", label: "Node 服务" },
          { value: "container", label: "通用容器" },
        ],
      },
      {
        key: "domain",
        label: "访问域名",
        kind: "text",
        required: false,
        placeholder: "例如 app.example.com",
        help: "留空时由平台自动分配预览地址",
      },
      {
        key: "port",
        label: "宿主机端口",
        kind: "number",
        required: false,
        defaultValue: 80,
      },
      {
        key: "containerPort",
        label: "容器端口",
        kind: "number",
        required: false,
        defaultValue: 80,
        help: "容器内部监听端口；静态站点通常为 80",
      },
      {
        key: "networkMode",
        label: "网络模式",
        kind: "select",
        required: false,
        defaultValue: "bridge",
        options: [
          { value: "bridge", label: "桥接网络（端口映射）" },
          { value: "host", label: "Host 网络（直连宿主机）" },
        ],
        help: "需要直连宿主机 MySQL 时选择 Host",
      },
      {
        key: "envFile",
        label: "环境变量文件",
        kind: "text",
        required: false,
        placeholder: "/home/user/app/.env",
        help: "服务器上的绝对路径，发布时通过 --env-file 注入",
      },
      {
        key: "volumes",
        label: "数据卷挂载",
        kind: "textarea",
        required: false,
        placeholder: "/host/data:/app/data",
        help: "每行一个“宿主机路径:容器路径”，用于上传文件等持久化数据",
      },
      {
        key: "healthPath",
        label: "健康检查路径",
        kind: "text",
        required: false,
        defaultValue: "/",
      },
      {
        key: "buildOutput",
        label: "构建产物目录",
        kind: "text",
        required: false,
        defaultValue: "dist",
      },
    ],
  },
  {
    id: "miniprogram",
    label: "小程序",
    short: "MP",
    description: "微信、支付宝、钉钉等小程序",
    fields: [
      {
        key: "platform",
        label: "小程序平台",
        kind: "select",
        required: true,
        defaultValue: "wechat",
        options: [
          { value: "wechat", label: "微信小程序" },
          { value: "alipay", label: "支付宝小程序" },
          { value: "dingtalk", label: "钉钉小程序" },
        ],
      },
      {
        key: "appId",
        label: "AppID",
        kind: "text",
        required: true,
        placeholder: "wx1234567890abcdef",
        help: "可在对应小程序开放平台查询，不属于密码",
      },
      {
        key: "projectRoot",
        label: "项目目录",
        kind: "text",
        required: false,
        defaultValue: ".",
      },
      {
        key: "buildCommand",
        label: "构建命令",
        kind: "text",
        required: false,
        defaultValue: "npm run build:mp",
      },
      {
        key: "publishEnv",
        label: "发布版本",
        kind: "select",
        required: false,
        defaultValue: "trial",
        options: [
          { value: "trial", label: "体验版" },
          { value: "production", label: "正式版" },
        ],
      },
    ],
  },
  {
    id: "api",
    label: "后端 API 服务",
    short: "API",
    description: "提供接口给网站、小程序或 App 调用",
    fields: [
      {
        key: "runtimeKind",
        label: "运行环境",
        kind: "select",
        required: true,
        defaultValue: "container",
        options: [
          { value: "container", label: "容器" },
          { value: "node", label: "Node.js" },
          { value: "java", label: "Java" },
          { value: "python", label: "Python" },
          { value: "go", label: "Go" },
        ],
      },
      {
        key: "port",
        label: "服务端口",
        kind: "number",
        required: true,
        defaultValue: 8080,
      },
      {
        key: "healthPath",
        label: "健康检查路径",
        kind: "text",
        required: false,
        defaultValue: "/health",
      },
      {
        key: "authType",
        label: "鉴权方式",
        kind: "select",
        required: false,
        defaultValue: "token",
        options: [
          { value: "none", label: "无鉴权（仅内网）" },
          { value: "token", label: "令牌" },
          { value: "oauth2", label: "OAuth2" },
        ],
      },
      {
        key: "databaseRef",
        label: "数据库引用",
        kind: "text",
        required: false,
        placeholder: "例如 DATABASE_URL（只填引用名，不填密码）",
      },
    ],
  },
  {
    id: "mobile",
    label: "移动端 App",
    short: "APP",
    description: "Android、iOS、HarmonyOS 应用",
    fields: [
      {
        key: "platform",
        label: "目标平台",
        kind: "select",
        required: true,
        defaultValue: "android",
        options: [
          { value: "android", label: "Android" },
          { value: "ios", label: "iOS" },
          { value: "harmonyos", label: "HarmonyOS" },
        ],
      },
      {
        key: "bundleId",
        label: "应用包名 / Bundle ID",
        kind: "text",
        required: true,
        placeholder: "com.example.app",
      },
      {
        key: "buildCommand",
        label: "构建命令",
        kind: "text",
        required: false,
        defaultValue: "npm run build:app",
      },
      {
        key: "storeUrl",
        label: "应用商店地址",
        kind: "url",
        required: false,
        placeholder: "https://…",
      },
    ],
  },
  {
    id: "service",
    label: "通用服务",
    short: "SVC",
    description: "其他后台任务、工具或服务",
    fields: [
      {
        key: "runtimeKind",
        label: "运行方式",
        kind: "select",
        required: true,
        defaultValue: "container",
        options: [
          { value: "container", label: "容器" },
          { value: "script", label: "脚本 / 任务" },
        ],
      },
      {
        key: "startCommand",
        label: "启动命令",
        kind: "text",
        required: false,
        placeholder: "例如 npm start",
      },
      {
        key: "healthPath",
        label: "健康检查路径",
        kind: "text",
        required: false,
      },
      {
        key: "notes",
        label: "备注",
        kind: "textarea",
        required: false,
        help: "写给自己或智能体的说明",
      },
    ],
  },
];

const insertApplication = db.prepare(`
  INSERT INTO applications
  (id, name, app_type, repository_id, target_provider, environment,
   fields_json, status, is_demo, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

function parseFields(value: string): ApplicationRecord["fields"] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as ApplicationRecord["fields"])
      : {};
  } catch {
    return {};
  }
}

interface ApplicationRow {
  id: string;
  name: string;
  app_type: string;
  repository_id: string | null;
  repository_name: string | null;
  target_provider: string | null;
  environment: string;
  fields_json: string;
  status: string;
  is_demo: number;
  created_at: string;
  updated_at: string;
}

function rowToApplication(row: ApplicationRow): ApplicationRecord {
  const type = APP_TYPE_DEFINITIONS.find((item) => item.id === row.app_type);
  return {
    id: row.id,
    name: row.name,
    appType: row.app_type,
    appTypeLabel: type?.label ?? row.app_type,
    repositoryId: row.repository_id,
    repositoryName: row.repository_name,
    targetProvider: row.target_provider,
    environment: row.environment,
    fields: parseFields(row.fields_json),
    status: row.status,
    isDemo: Boolean(row.is_demo),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listApplicationTypes(): AppTypeDefinition[] {
  return APP_TYPE_DEFINITIONS;
}

export function getApplicationType(
  id: unknown,
): AppTypeDefinition | undefined {
  return APP_TYPE_DEFINITIONS.find((item) => item.id === id);
}

export function listApplications(): ApplicationRecord[] {
  return db
    .prepare(`
      SELECT
        application.id,
        application.name,
        application.app_type,
        application.repository_id,
        repository.name AS repository_name,
        application.target_provider,
        application.environment,
        application.fields_json,
        application.status,
        application.is_demo,
        application.created_at,
        application.updated_at
      FROM applications application
      LEFT JOIN repositories repository ON repository.id = application.repository_id
      ORDER BY application.created_at ASC
    `)
    .all()
    .map((rawRow) => rowToApplication(rawRow as unknown as ApplicationRow));
}

export function getApplication(id: string): ApplicationRecord | undefined {
  const row = db
    .prepare(`
      SELECT
        application.id,
        application.name,
        application.app_type,
        application.repository_id,
        repository.name AS repository_name,
        application.target_provider,
        application.environment,
        application.fields_json,
        application.status,
        application.is_demo,
        application.created_at,
        application.updated_at
      FROM applications application
      LEFT JOIN repositories repository ON repository.id = application.repository_id
      WHERE application.id = ?
    `)
    .get(id) as unknown as ApplicationRow | undefined;
  return row ? rowToApplication(row) : undefined;
}

export interface ApplicationEnvStatus {
  configured: boolean;
  variableCount: number;
  updatedAt: string | null;
}

function envVariableCount(content: string): number {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && line.includes("=")).length;
}

export function getApplicationEnv(id: string): string {
  const row = db
    .prepare("SELECT env_content_enc FROM application_env WHERE application_id = ?")
    .get(id) as { env_content_enc: string } | undefined;
  return decryptCloudSecret(row?.env_content_enc ?? "");
}

export function getApplicationEnvStatus(id: string): ApplicationEnvStatus {
  const row = db
    .prepare("SELECT env_content_enc, updated_at FROM application_env WHERE application_id = ?")
    .get(id) as { env_content_enc: string; updated_at: string } | undefined;
  const content = decryptCloudSecret(row?.env_content_enc ?? "");
  return {
    configured: Boolean(content.trim()),
    variableCount: envVariableCount(content),
    updatedAt: row?.updated_at ?? null,
  };
}

export function setApplicationEnv(id: string, content: string): ApplicationEnvStatus {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO application_env(application_id, env_content_enc, updated_at)
     VALUES(?,?,?)
     ON CONFLICT(application_id) DO UPDATE SET
       env_content_enc = excluded.env_content_enc,
       updated_at = excluded.updated_at`,
  ).run(id, encryptCloudSecret(content), now);
  return getApplicationEnvStatus(id);
}

function normalizeFields(
  definition: AppTypeDefinition,
  input: unknown,
): Record<string, string | number | boolean> {
  const source =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};
  const result: Record<string, string | number | boolean> = {};

  for (const field of definition.fields) {
    const raw = source[field.key];
    const isEmpty =
      raw === undefined || raw === null || (typeof raw === "string" && !raw.trim());

    if (isEmpty) {
      if (field.required) {
        throw new Error(`请填写“${field.label}”。`);
      }
      continue;
    }

    switch (field.kind) {
      case "text":
      case "textarea": {
        if (typeof raw !== "string") {
          throw new Error(`“${field.label}”必须是文本。`);
        }
        const normalized = raw.trim();
        if (normalized.length > 500) {
          throw new Error(`“${field.label}”过长。`);
        }
        result[field.key] = normalized;
        break;
      }
      case "number": {
        const numeric = Number(raw);
        if (!Number.isFinite(numeric) || numeric < 0) {
          throw new Error(`“${field.label}”必须是有效数字。`);
        }
        if (field.key === "port" && (numeric < 1 || numeric > 65535)) {
          throw new Error(`“${field.label}”必须在 1 到 65535 之间。`);
        }
        result[field.key] = numeric;
        break;
      }
      case "url": {
        if (typeof raw !== "string") {
          throw new Error(`“${field.label}”必须是链接。`);
        }
        try {
          const parsed = new URL(raw.trim());
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            throw new Error("地址只支持 http 或 https。");
          }
          result[field.key] = parsed.toString();
        } catch {
          throw new Error(`“${field.label}”不是有效链接。`);
        }
        break;
      }
      case "select": {
        if (
          typeof raw !== "string" ||
          !field.options?.some((option) => option.value === raw)
        ) {
          throw new Error(`请选择正确的“${field.label}”。`);
        }
        result[field.key] = raw;
        break;
      }
      case "boolean": {
        result[field.key] = Boolean(raw);
        break;
      }
    }
  }
  return result;
}

export interface SaveApplicationInput {
  name: string;
  appType: string;
  repositoryId: string | null;
  targetProvider: string | null;
  environment: string;
  fields: Record<string, unknown>;
}

export function createApplication(
  input: SaveApplicationInput,
): ApplicationRecord {
  const definition = getApplicationType(input.appType);
  if (!definition) {
    throw new Error("未知的应用类型。");
  }
  if (input.repositoryId && !getRepository(input.repositoryId)) {
    throw new Error("所选代码仓库不存在。");
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const fields = normalizeFields(definition, input.fields);
  insertApplication.run(
    id,
    input.name,
    input.appType,
    input.repositoryId,
    input.targetProvider,
    input.environment,
    JSON.stringify(fields),
    "configured",
    0,
    now,
    now,
  );
  const application = getApplication(id);
  if (!application) {
    throw new Error("应用创建后无法读取，请重试。");
  }
  return application;
}

export function updateApplication(
  id: string,
  input: SaveApplicationInput,
): ApplicationRecord | undefined {
  const existing = getApplication(id);
  if (!existing) {
    return undefined;
  }
  const definition = getApplicationType(input.appType);
  if (!definition) {
    throw new Error("未知的应用类型。");
  }
  if (input.repositoryId && !getRepository(input.repositoryId)) {
    throw new Error("所选代码仓库不存在。");
  }
  const fields = normalizeFields(definition, input.fields);
  db.prepare(`
    UPDATE applications
    SET name = ?, app_type = ?, repository_id = ?, target_provider = ?,
        environment = ?, fields_json = ?, updated_at = ?
    WHERE id = ?
  `).run(
    input.name,
    input.appType,
    input.repositoryId,
    input.targetProvider,
    input.environment,
    JSON.stringify(fields),
    new Date().toISOString(),
    id,
  );
  return getApplication(id);
}

export function deleteApplication(id: string): boolean {
  const result = db
    .prepare("DELETE FROM applications WHERE id = ? AND is_demo = 0")
    .run(id);
  return result.changes > 0;
}

function seedDemoApplications(): void {
  if (!config.demoMode) {
    return;
  }
  const existing = db
    .prepare("SELECT COUNT(*) AS count FROM applications")
    .get() as { count: number };
  if (existing.count > 0) {
    return;
  }
  const now = new Date().toISOString();
  insertApplication.run(
    "app-demo-site",
    "品牌官网（演示）",
    "web",
    "repo-console",
    "tencent",
    "staging",
    JSON.stringify({
      runtimeKind: "static",
      domain: "",
      port: 80,
      healthPath: "/",
      buildOutput: "dist",
    }),
    "configured",
    1,
    now,
    now,
  );
  insertApplication.run(
    "app-demo-miniapp",
    "客户服务小程序（演示）",
    "miniprogram",
    "repo-checkout",
    "aliyun",
    "staging",
    JSON.stringify({
      platform: "wechat",
      appId: "wx-demo-placeholder",
      projectRoot: "miniapp",
      buildCommand: "npm run build:mp",
      publishEnv: "trial",
    }),
    "configured",
    1,
    now,
    now,
  );
}

seedDemoApplications();

