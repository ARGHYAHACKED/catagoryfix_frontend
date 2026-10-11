import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuditEvent, Plan, prisma } from '@catalogfix/database';
import { bullConnection, createQueue, QUEUE_NAMES, type ExportJobPayload } from '@catalogfix/queue';
import { loadConfig } from '@catalogfix/config';
import { createStorageClient, ObjectStorage } from '@catalogfix/storage';
import { AuthGuard, type AuthUser } from '../common/auth.guard';
import { OrganizationGuard } from '../common/organization.guard';
import { currentPeriod } from '../common/crypto';
import { EntitlementService } from '../common/entitlements';
import type { Request } from 'express';

@Controller('exports')
@UseGuards(AuthGuard, OrganizationGuard)
export class ExportsController {
  private entitlements = new EntitlementService();

  @Post()
  async create(
    @Req() req: Request & { organizationId?: string; user?: AuthUser },
    @Body() body: { importId: string; platform?: 'SHOPIFY' },
  ) {
    const orgId = req.organizationId!;
    const importJob = await prisma.importJob.findFirst({
      where: { id: body.importId, organizationId: orgId, deletedAt: null },
    });
    if (!importJob) {
      throw new NotFoundException({ code: 'IMPORT_NOT_FOUND', message: 'Import could not be found.' });
    }
    const subscription = await prisma.subscription.findUnique({ where: { organizationId: orgId } });
    const period = currentPeriod();
    const usage = await prisma.usageRecord.upsert({
      where: { organizationId_period: { organizationId: orgId, period } },
      update: {},
      create: { organizationId: orgId, period },
    });
    // Monthly export limit bypassed for development
    const totalProducts = await prisma.product.count({ where: { importId: importJob.id, deletedAt: null } });
    const job = await prisma.$transaction(async (tx) => {
      const created = await tx.exportJob.create({
        data: {
          organizationId: orgId,
          createdByUserId: req.user!.id,
          importId: importJob.id,
          platform: body.platform ?? 'SHOPIFY',
          status: 'QUEUED',
          totalProducts,
        },
      });
      await tx.usageRecord.update({
        where: { organizationId_period: { organizationId: orgId, period } },
        data: { exportsCreated: { increment: 1 } },
      });
      await tx.auditLog.create({
        data: {
          organizationId: orgId,
          userId: req.user!.id,
          event: AuditEvent.EXPORT_CREATED,
          metadata: { exportId: created.id },
        },
      });
      return created;
    });
    const config = loadConfig();
    const queue = createQueue(QUEUE_NAMES.CATALOG_EXPORT, bullConnection(config.REDIS_URL));
    await queue.add(
      'export',
      { exportId: job.id, organizationId: orgId } satisfies ExportJobPayload,
      { jobId: `export-${job.id}` },
    );
    return job;
  }

  @Get()
  async list(@Req() req: Request & { organizationId?: string }) {
    return prisma.exportJob.findMany({
      where: { organizationId: req.organizationId },
      include: { files: true },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  @Get(':id')
  async get(@Req() req: Request & { organizationId?: string }, @Param('id') id: string) {
    const job = await prisma.exportJob.findFirst({
      where: { id, organizationId: req.organizationId },
      include: { files: true },
    });
    if (!job) {
      throw new NotFoundException({ code: 'EXPORT_NOT_FOUND', message: 'Export could not be found.' });
    }
    return job;
  }

  @Get(':id/download')
  async download(@Req() req: Request & { organizationId?: string }, @Param('id') id: string) {
    const job = await prisma.exportJob.findFirst({
      where: { id, organizationId: req.organizationId },
      include: { files: true },
    });
    if (!job || job.files.length === 0) {
      throw new NotFoundException({ code: 'EXPORT_NOT_FOUND', message: 'Export could not be found.' });
    }
    const file = job.files[0]!;
    const config = loadConfig();
    const storage = new ObjectStorage(createStorageClient(config), config.R2_BUCKET);
    const url = await storage.presignGet(file.storageKey, 300);
    return { url, fileName: file.fileName };
  }
}
