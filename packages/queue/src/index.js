"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.defaultJobOptions = exports.QUEUE_NAMES = void 0;
exports.createRedisConnection = createRedisConnection;
exports.bullConnection = bullConnection;
exports.createQueue = createQueue;
const bullmq_1 = require("bullmq");
const ioredis_1 = __importDefault(require("ioredis"));
exports.QUEUE_NAMES = {
    CATALOG_IMPORT: 'catalog-import',
    CATALOG_NORMALIZE: 'catalog-normalize',
    CATALOG_VALIDATION: 'catalog-validation',
    CATALOG_AI: 'catalog-ai',
    IMAGE_PROCESSING: 'image-processing',
    CATALOG_EXPORT: 'catalog-export',
    SHOPIFY_SYNC: 'shopify-sync',
    EMAIL: 'email',
    WEBHOOKS: 'webhooks',
    RETENTION: 'retention-cleanup',
};
function createRedisConnection(url) {
    return new ioredis_1.default(url, { maxRetriesPerRequest: null });
}
function bullConnection(url) {
    const parsed = new URL(url);
    return {
        host: parsed.hostname,
        port: Number(parsed.port || 6379),
        password: parsed.password || undefined,
        maxRetriesPerRequest: null,
    };
}
exports.defaultJobOptions = {
    attempts: 5,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 500 },
};
function createQueue(name, connection) {
    return new bullmq_1.Queue(name, { connection, defaultJobOptions: exports.defaultJobOptions });
}
//# sourceMappingURL=index.js.map