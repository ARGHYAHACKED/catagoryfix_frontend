import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  Req,
  Sse,
  UseGuards,
} from '@nestjs/common';
import { AuditEvent, Plan, prisma } from '@catalogfix/database';
import { createQueue, QUEUE_NAMES, bullConnection, type ImportJobPayload } from '@catalogfix/queue';
import { loadConfig } from '@catalogfix/config';
import { CATALOG_TARGET_FIELDS } from '@catalogfix/types';
import { AuthGuard, type AuthUser } from '../common/auth.guard';
import { OrganizationGuard } from '../common/organization.guard';
import { currentPeriod } from '../common/crypto';
import { EntitlementService } from '../common/entitlements';
import { interval, map, type Observable } from 'rxjs';
import type { Request } from 'express';

type SseMessage = { data: { importId: string; organizationId?: string } };

function queues() {
  const config = loadConfig();
  const connection = bullConnection(config.REDIS_URL);
  return {
    import: createQueue(QUEUE_NAMES.CATALOG_IMPORT, connection),
    normalize: createQueue(QUEUE_NAMES.CATALOG_NORMALIZE, connection),
  };
}

@Controller('imports')
@UseGuards(AuthGuard, OrganizationGuard)
export class ImportsController {
  private entitlements = new EntitlementService();

  @Post()
  async create(
    @Req() req: Request & { user?: AuthUser; organizationId?: string },
    @Body() body: { name?: string; sourcePlatform?: string; targetPlatform?: string },
  ) {
    const orgId = req.organizationId!;
    const subscription = await prisma.subscription.findUnique({ where: { organizationId: orgId } });
    const period = currentPeriod();
    const usage = await prisma.usageRecord.upsert({
      where: { organizationId_period: { organizationId: orgId, period } },
      update: {},
      create: { organizationId: orgId, period },
    });
    const plan = subscription?.plan ?? Plan.FREE;
    // Monthly import limit bypassed for development
    const job = await prisma.$transaction(async (tx) => {
      const created = await tx.importJob.create({
        data: {
          organizationId: orgId,
          createdByUserId: req.user!.id,
          name: body.name?.trim() || 'Untitled import',
          sourcePlatform: (body.sourcePlatform as never) ?? 'GENERIC',
          targetPlatform: (body.targetPlatform as never) ?? 'SHOPIFY',
          status: 'CREATED',
        },
      });
      await tx.usageRecord.update({
        where: { organizationId_period: { organizationId: orgId, period } },
        data: { importsCreated: { increment: 1 } },
      });
      await tx.auditLog.create({
        data: {
          organizationId: orgId,
          userId: req.user!.id,
          event: AuditEvent.IMPORT_CREATED,
          metadata: { importId: created.id },
        },
      });
      return created;
    });
    return job;
  }

  @Get()
  async list(
    @Req() req: Request & { organizationId?: string },
    @Query('cursor') cursor?: string,
    @Query('limit') limit = '20',
  ) {
    const take = Math.min(Number(limit) || 20, 100);
    const items = await prisma.importJob.findMany({
      where: { organizationId: req.organizationId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const next = items.length > take ? items.pop() : undefined;
    return { items, nextCursor: next?.id ?? null };
  }

  @Get(':id')
  async get(@Req() req: Request & { organizationId?: string }, @Param('id') id: string) {
    const job = await prisma.importJob.findFirst({
      where: { id, organizationId: req.organizationId, deletedAt: null },
      include: { files: true, mappings: true },
    });
    if (!job) {
      throw new NotFoundException({ code: 'IMPORT_NOT_FOUND', message: 'Import could not be found.' });
    }
    return job;
  }

  @Delete(':id')
  async remove(@Req() req: Request & { organizationId?: string }, @Param('id') id: string) {
    const job = await prisma.importJob.findFirst({
      where: { id, organizationId: req.organizationId, deletedAt: null },
    });
    if (!job) {
      throw new NotFoundException({ code: 'IMPORT_NOT_FOUND', message: 'Import could not be found.' });
    }
    await prisma.importJob.update({ where: { id }, data: { deletedAt: new Date(), status: 'CANCELLED' } });
    return { ok: true };
  }

  @Post(':id/files/confirm')
  async confirmFile(
    @Req() req: Request & { organizationId?: string; user?: AuthUser },
    @Param('id') id: string,
    @Body()
    body: {
      storageKey: string;
      originalName: string;
      mimeType: string;
      fileSize: number;
      checksum?: string;
      type?: 'CATALOG' | 'IMAGE_ZIP' | 'OTHER';
    },
  ) {
    const job = await prisma.importJob.findFirst({
      where: { id, organizationId: req.organizationId, deletedAt: null },
    });
    if (!job) {
      throw new NotFoundException({ code: 'IMPORT_NOT_FOUND', message: 'Import could not be found.' });
    }
    if (!body.storageKey.startsWith(`org/${req.organizationId}/imports/${job.id}/`)) {
      throw new ForbiddenException({ code: 'INVALID_STORAGE_KEY', message: 'Storage key is invalid.' });
    }
    const file = await prisma.importFile.create({
      data: {
        importId: job.id,
        type: body.type ?? 'CATALOG',
        originalName: body.originalName,
        storageKey: body.storageKey,
        mimeType: body.mimeType,
        fileSize: body.fileSize,
        checksum: body.checksum,
      },
    });
    await prisma.importJob.update({
      where: { id: job.id },
      data: { status: 'UPLOADED', name: job.name === 'Untitled import' ? body.originalName : job.name },
    });
    if ((body.type ?? 'CATALOG') === 'CATALOG') {
      const { import: importQueue } = queues();
      await importQueue.add(
        'parse-headers',
        { importId: job.id, organizationId: req.organizationId!, stage: 'parse-headers' } satisfies ImportJobPayload,
        { jobId: `import-parse-${job.id}` },
      );
      await prisma.importJob.update({ where: { id: job.id }, data: { status: 'QUEUED' } });
    }
    return file;
  }

  @Get(':id/columns')
  async columns(@Req() req: Request & { organizationId?: string }, @Param('id') id: string) {
    const job = await prisma.importJob.findFirst({
      where: { id, organizationId: req.organizationId, deletedAt: null },
    });
    if (!job) {
      throw new NotFoundException({ code: 'IMPORT_NOT_FOUND', message: 'Import could not be found.' });
    }
    return {
      headers: job.detectedHeaders,
      encoding: job.detectedEncoding,
      delimiter: job.detectedDelimiter,
      sampleRows: job.sampleRows,
      targetFields: CATALOG_TARGET_FIELDS,
    };
  }

  @Get(':id/mappings')
  async mappings(@Req() req: Request & { organizationId?: string }, @Param('id') id: string) {
    const job = await prisma.importJob.findFirst({
      where: { id, organizationId: req.organizationId, deletedAt: null },
    });
    if (!job) {
      throw new NotFoundException({ code: 'IMPORT_NOT_FOUND', message: 'Import could not be found.' });
    }
    return prisma.columnMapping.findMany({ where: { importId: id } });
  }

  @Put(':id/mappings')
  async saveMappings(
    @Req() req: Request & { organizationId?: string },
    @Param('id') id: string,
    @Body() body: { mappings: Array<{ sourceColumn: string; targetField: string }> },
  ) {
    const job = await prisma.importJob.findFirst({
      where: { id, organizationId: req.organizationId, deletedAt: null },
    });
    if (!job) {
      throw new NotFoundException({ code: 'IMPORT_NOT_FOUND', message: 'Import could not be found.' });
    }
    if (!Array.isArray(body.mappings) || body.mappings.length === 0) {
      throw new BadRequestException({ code: 'INVALID_MAPPING', message: 'Mappings are required.' });
    }
    await prisma.$transaction([
      prisma.columnMapping.deleteMany({ where: { importId: id } }),
      prisma.columnMapping.createMany({
        data: body.mappings.map((mapping) => ({
          importId: id,
          sourceColumn: mapping.sourceColumn,
          targetField: mapping.targetField,
          confidence: 1,
          autoDetected: false,
          confirmedByUser: true,
        })),
      }),
    ]);
    return prisma.columnMapping.findMany({ where: { importId: id } });
  }

  @Post(':id/process')
  async process(
    @Req() req: Request & { organizationId?: string; user?: AuthUser },
    @Param('id') id: string,
  ) {
    const job = await prisma.importJob.findFirst({
      where: { id, organizationId: req.organizationId, deletedAt: null },
      include: { mappings: true },
    });
    if (!job) {
      throw new NotFoundException({ code: 'IMPORT_NOT_FOUND', message: 'Import could not be found.' });
    }
    if (job.mappings.length === 0) {
      throw new BadRequestException({ code: 'MAPPING_REQUIRED', message: 'Confirm column mappings first.' });
    }
    if (['PROCESSING', 'VALIDATING'].includes(job.status)) {
      return job;
    }
    const { normalize } = queues();
    await prisma.importJob.update({
      where: { id },
      data: { status: 'QUEUED', startedAt: new Date(), currentStage: 'Queued for processing' },
    });
    await prisma.auditLog.create({
      data: {
        organizationId: req.organizationId,
        userId: req.user!.id,
        event: AuditEvent.IMPORT_STARTED,
        metadata: { importId: id },
      },
    });
    await normalize.add(
      'normalize',
      { importId: id, organizationId: req.organizationId!, stage: 'normalize' } satisfies ImportJobPayload,
      { jobId: `import-normalize-${id}-${Date.now()}` },
    );
    return prisma.importJob.findUnique({ where: { id } });
  }

  @Get(':id/progress')
  async progress(@Req() req: Request & { organizationId?: string }, @Param('id') id: string) {
    const job = await prisma.importJob.findFirst({
      where: { id, organizationId: req.organizationId, deletedAt: null },
      select: {
        id: true,
        status: true,
        progressPercentage: true,
        currentStage: true,
        processedRows: true,
        totalRows: true,
        failedRows: true,
        warningRows: true,
        successfulRows: true,
        errorMessage: true,
      },
    });
    if (!job) {
      throw new NotFoundException({ code: 'IMPORT_NOT_FOUND', message: 'Import could not be found.' });
    }
    return job;
  }

  @Sse(':id/events')
  events(
    @Req() req: Request & { organizationId?: string },
    @Param('id') id: string,
  ): Observable<SseMessage> {
    return interval(2500).pipe(
      map(() => ({ data: { importId: id, organizationId: req.organizationId } })),
    );
  }

  @Get(':id/products')
  async products(
    @Req() req: Request & { organizationId?: string },
    @Param('id') id: string,
    @Query('cursor') cursor?: string,
    @Query('q') q?: string,
    @Query('status') status?: string,
    @Query('filter') filter?: string,
    @Query('limit') limit = '50',
  ) {
    const job = await prisma.importJob.findFirst({
      where: { id, organizationId: req.organizationId, deletedAt: null },
    });
    if (!job) {
      throw new NotFoundException({ code: 'IMPORT_NOT_FOUND', message: 'Import could not be found.' });
    }
    const take = Math.min(Number(limit) || 50, 100);
    const items = await prisma.product.findMany({
      where: {
        importId: id,
        deletedAt: null,
        ...(status ? { status: status as never } : {}),
        ...(q
          ? {
              OR: [
                { title: { contains: q, mode: 'insensitive' } },
                { sku: { contains: q, mode: 'insensitive' } },
              ],
            }
          : {}),
        ...(filter === 'missing_image' ? { images: { none: {} } } : {}),
        ...(filter === 'error' ? { issues: { some: { severity: 'ERROR', resolved: false } } } : {}),
        ...(filter === 'warning' ? { issues: { some: { severity: 'WARNING', resolved: false } } } : {}),
      },
      include: {
        images: { take: 1, orderBy: { position: 'asc' } },
        variants: true,
        issues: { where: { resolved: false } },
        _count: { select: { variants: true } },
      },
      orderBy: { createdAt: 'asc' },
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const next = items.length > take ? items.pop() : undefined;
    return { items, nextCursor: next?.id ?? null };
  }

  @Get(':id/issues')
  async issues(@Req() req: Request & { organizationId?: string }, @Param('id') id: string) {
    const job = await prisma.importJob.findFirst({
      where: { id, organizationId: req.organizationId, deletedAt: null },
    });
    if (!job) {
      throw new NotFoundException({ code: 'IMPORT_NOT_FOUND', message: 'Import could not be found.' });
    }
    return prisma.validationIssue.findMany({
      where: { importId: id },
      orderBy: [{ severity: 'asc' }, { createdAt: 'asc' }],
      take: 500,
    });
  }

  @Get(':id/validation-summary')
  async summary(@Req() req: Request & { organizationId?: string }, @Param('id') id: string) {
    const job = await prisma.importJob.findFirst({
      where: { id, organizationId: req.organizationId, deletedAt: null },
    });
    if (!job) {
      throw new NotFoundException({ code: 'IMPORT_NOT_FOUND', message: 'Import could not be found.' });
    }
    const [errors, warnings, ready, duplicateSku, missingImages, missingTitles, invalidPrices] =
      await Promise.all([
        prisma.validationIssue.count({ where: { importId: id, severity: 'ERROR', resolved: false } }),
        prisma.validationIssue.count({ where: { importId: id, severity: 'WARNING', resolved: false } }),
        prisma.product.count({ where: { importId: id, status: 'READY' } }),
        prisma.validationIssue.count({ where: { importId: id, code: 'DUPLICATE_SKU', resolved: false } }),
        prisma.validationIssue.count({ where: { importId: id, code: 'IMAGE_NOT_FOUND', resolved: false } }),
        prisma.validationIssue.count({ where: { importId: id, code: 'PRODUCT_MISSING_TITLE', resolved: false } }),
        prisma.validationIssue.count({
          where: { importId: id, code: { in: ['INVALID_PRICE', 'NEGATIVE_PRICE'] }, resolved: false },
        }),
      ]);
    return { errors, warnings, ready, duplicateSku, missingImages, missingTitles, invalidPrices };
  }
}
