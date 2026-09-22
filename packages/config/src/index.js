"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadConfig = loadConfig;
exports.resetConfigCache = resetConfigCache;
const dotenv_1 = require("dotenv");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const zod_1 = require("zod");
function loadEnvFiles() {
    const candidates = [
        (0, node_path_1.resolve)(process.cwd(), '.env'),
        (0, node_path_1.resolve)(process.cwd(), '../../.env'),
        (0, node_path_1.resolve)(__dirname, '../../../.env'),
    ];
    for (const file of candidates) {
        if ((0, node_fs_1.existsSync)(file)) {
            (0, dotenv_1.config)({ path: file, override: false });
        }
    }
}
loadEnvFiles();
const booleanFromEnv = zod_1.z.preprocess((value) => {
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'string') {
        return value === 'true' || value === '1';
    }
    return false;
}, zod_1.z.boolean());
const envSchema = zod_1.z.object({
    NODE_ENV: zod_1.z.enum(['development', 'test', 'production']).default('development'),
    WEB_URL: zod_1.z.string().url(),
    API_URL: zod_1.z.string().url(),
    API_PREFIX: zod_1.z.string().default('/api/v1'),
    API_PORT: zod_1.z.coerce.number().default(3001),
    WORKER_CONCURRENCY: zod_1.z.coerce.number().default(5),
    DATABASE_URL: zod_1.z.string().min(1),
    REDIS_URL: zod_1.z.string().min(1),
    JWT_ACCESS_SECRET: zod_1.z.string().min(32),
    JWT_REFRESH_SECRET: zod_1.z.string().min(32),
    JWT_ACCESS_TTL: zod_1.z.coerce.number().default(900),
    JWT_REFRESH_TTL: zod_1.z.coerce.number().default(604800),
    PASSWORD_PEPPER: zod_1.z.string().min(8),
    ENCRYPTION_KEY: zod_1.z.string().min(32),
    COOKIE_DOMAIN: zod_1.z.string().default('localhost'),
    COOKIE_SECURE: booleanFromEnv.default(false),
    R2_ACCOUNT_ID: zod_1.z.string().min(1),
    R2_ACCESS_KEY_ID: zod_1.z.string().min(1),
    R2_SECRET_ACCESS_KEY: zod_1.z.string().min(1),
    R2_BUCKET: zod_1.z.string().min(1),
    R2_ENDPOINT: zod_1.z.string().url(),
    R2_PUBLIC_URL: zod_1.z.string().optional(),
    R2_FORCE_PATH_STYLE: booleanFromEnv.default(true),
    R2_REGION: zod_1.z.string().default('auto'),
    OPENAI_API_KEY: zod_1.z.string().optional().default(''),
    OPENAI_MODEL: zod_1.z.string().default('gpt-4o-mini'),
    STRIPE_SECRET_KEY: zod_1.z.string().optional().default(''),
    STRIPE_PUBLISHABLE_KEY: zod_1.z.string().optional().default(''),
    STRIPE_WEBHOOK_SECRET: zod_1.z.string().optional().default(''),
    STRIPE_STARTER_PRICE_ID: zod_1.z.string().optional().default(''),
    STRIPE_BUSINESS_PRICE_ID: zod_1.z.string().optional().default(''),
    STRIPE_PRO_PRICE_ID: zod_1.z.string().optional().default(''),
    RESEND_API_KEY: zod_1.z.string().optional().default(''),
    EMAIL_FROM: zod_1.z.string().default('CatalogFix <noreply@localhost>'),
    SENTRY_DSN: zod_1.z.string().optional().default(''),
    FILE_RETENTION_FREE_DAYS: zod_1.z.coerce.number().default(7),
    FILE_RETENTION_PAID_DAYS: zod_1.z.coerce.number().default(30),
    MAX_UPLOAD_BYTES: zod_1.z.coerce.number().default(52_428_800),
});
let cached;
function loadConfig(source = process.env) {
    if (cached) {
        return cached;
    }
    const parsed = envSchema.safeParse(source);
    if (!parsed.success) {
        const issues = parsed.error.issues
            .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
            .join('; ');
        throw new Error(`Invalid environment configuration: ${issues}`);
    }
    cached = parsed.data;
    return cached;
}
function resetConfigCache() {
    cached = undefined;
}
//# sourceMappingURL=index.js.map