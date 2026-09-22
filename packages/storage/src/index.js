"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ObjectStorage = void 0;
exports.createStorageClient = createStorageClient;
exports.assertAllowedUpload = assertAllowedUpload;
exports.checksumBuffer = checksumBuffer;
exports.asNodeReadable = asNodeReadable;
const client_s3_1 = require("@aws-sdk/client-s3");
const s3_request_presigner_1 = require("@aws-sdk/s3-request-presigner");
const node_crypto_1 = require("node:crypto");
const node_stream_1 = require("node:stream");
const ALLOWED_EXTENSIONS = new Set(['.csv', '.xlsx', '.xls', '.zip']);
const ALLOWED_MIME = new Set([
    'text/csv',
    'application/csv',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/zip',
    'application/x-zip-compressed',
    'application/octet-stream',
]);
function createStorageClient(config) {
    return new client_s3_1.S3Client({
        region: config.R2_REGION,
        endpoint: config.R2_ENDPOINT,
        forcePathStyle: config.R2_FORCE_PATH_STYLE,
        credentials: {
            accessKeyId: config.R2_ACCESS_KEY_ID,
            secretAccessKey: config.R2_SECRET_ACCESS_KEY,
        },
    });
}
class ObjectStorage {
    client;
    bucket;
    constructor(client, bucket) {
        this.client = client;
        this.bucket = bucket;
    }
    async presignPut(key, contentType, expiresIn = 900) {
        return (0, s3_request_presigner_1.getSignedUrl)(this.client, new client_s3_1.PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            ContentType: contentType,
        }), { expiresIn });
    }
    async presignGet(key, expiresIn = 900) {
        return (0, s3_request_presigner_1.getSignedUrl)(this.client, new client_s3_1.GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn });
    }
    async putBuffer(key, body, contentType) {
        await this.client.send(new client_s3_1.PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            Body: body,
            ContentType: contentType,
        }));
    }
    async getBuffer(key) {
        const response = await this.client.send(new client_s3_1.GetObjectCommand({ Bucket: this.bucket, Key: key }));
        const stream = response.Body;
        if (!stream) {
            throw new Error('Empty object body');
        }
        const bytes = await stream.transformToByteArray();
        return Buffer.from(bytes);
    }
    async delete(key) {
        await this.client.send(new client_s3_1.DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    }
}
exports.ObjectStorage = ObjectStorage;
function assertAllowedUpload(fileName, mimeType, fileSize, maxBytes) {
    const ext = fileName.toLowerCase().slice(fileName.lastIndexOf('.'));
    if (!ALLOWED_EXTENSIONS.has(ext)) {
        throw Object.assign(new Error('File extension is not allowed.'), { code: 'INVALID_FILE_TYPE' });
    }
    if (!ALLOWED_MIME.has(mimeType)) {
        throw Object.assign(new Error('MIME type is not allowed.'), { code: 'INVALID_MIME_TYPE' });
    }
    if (fileSize <= 0 || fileSize > maxBytes) {
        throw Object.assign(new Error('File size is not allowed.'), { code: 'INVALID_FILE_SIZE' });
    }
}
function checksumBuffer(buffer) {
    return (0, node_crypto_1.createHash)('sha256').update(buffer).digest('hex');
}
function asNodeReadable(body) {
    if (body instanceof node_stream_1.Readable) {
        return body;
    }
    throw new Error('Unsupported body type');
}
//# sourceMappingURL=index.js.map