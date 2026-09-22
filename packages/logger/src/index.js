"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createLogger = createLogger;
const pino_1 = __importDefault(require("pino"));
const REDACT_PATHS = [
    'password',
    'passwordHash',
    'token',
    'refreshToken',
    'accessToken',
    'authorization',
    'cookie',
    'stripeSecret',
    'encryptedCredentials',
    'apiKey',
    'OPENAI_API_KEY',
    'JWT_ACCESS_SECRET',
    'JWT_REFRESH_SECRET',
];
function createLogger(service) {
    return (0, pino_1.default)({
        level: process.env.LOG_LEVEL ?? 'info',
        base: { service },
        timestamp: pino_1.default.stdTimeFunctions.isoTime,
        redact: {
            paths: REDACT_PATHS,
            censor: '[REDACTED]',
        },
        formatters: {
            level(label) {
                return { level: label };
            },
        },
    });
}
//# sourceMappingURL=index.js.map