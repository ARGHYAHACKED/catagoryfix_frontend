import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { AuditEvent, Plan, prisma, SubscriptionStatus } from '@catalogfix/database';
import { AuthGuard, type AuthUser } from '../common/auth.guard';
import { slugify } from '../common/crypto';
import type { Request } from 'express';

@Controller('organizations')
@UseGuards(AuthGuard)
export class OrganizationsController {
  @Get()
  async list(@Req() req: Request & { user?: AuthUser }) {
    const memberships = await prisma.organizationMember.findMany({
      where: { userId: req.user!.id },
      include: { organization: { include: { subscription: true } } },
    });
    return memberships.map((m) => ({
      id: m.organization.id,
      name: m.organization.name,
      slug: m.organization.slug,
      role: m.role,
      plan: m.organization.subscription?.plan ?? Plan.FREE,
    }));
  }

  @Post()
  async create(@Req() req: Request & { user?: AuthUser }, @Body() body: { name: string }) {
    const name = body.name?.trim();
    const base = slugify(name || 'workspace') || 'workspace';
    const result = await prisma.$transaction(async (tx) => {
      let slug = base;
      let n = 1;
      while (await tx.organization.findUnique({ where: { slug } })) {
        slug = `${base}-${n}`;
        n += 1;
      }
      const organization = await tx.organization.create({ data: { name: name || 'Workspace', slug } });
      await tx.organizationMember.create({
        data: { userId: req.user!.id, organizationId: organization.id, role: 'OWNER' },
      });
      await tx.subscription.create({
        data: { organizationId: organization.id, plan: Plan.FREE, status: SubscriptionStatus.ACTIVE },
      });
      await tx.auditLog.create({
        data: {
          organizationId: organization.id,
          userId: req.user!.id,
          event: AuditEvent.ORGANIZATION_CREATED,
        },
      });
      return organization;
    });
    return result;
  }

  @Get(':id')
  async get(@Req() req: Request & { user?: AuthUser }, @Param('id') id: string) {
    const membership = await prisma.organizationMember.findUnique({
      where: { userId_organizationId: { userId: req.user!.id, organizationId: id } },
      include: { organization: { include: { subscription: true } } },
    });
    if (!membership) {
      return null;
    }
    return { ...membership.organization, role: membership.role };
  }

  @Patch(':id')
  async patch(@Req() req: Request & { user?: AuthUser }, @Param('id') id: string, @Body() body: { name?: string }) {
    const membership = await prisma.organizationMember.findUnique({
      where: { userId_organizationId: { userId: req.user!.id, organizationId: id } },
    });
    if (!membership || (membership.role !== 'OWNER' && membership.role !== 'ADMIN')) {
      return null;
    }
    return prisma.organization.update({ where: { id }, data: { name: body.name?.trim() } });
  }

  @Get(':id/members')
  async members(@Req() req: Request & { user?: AuthUser }, @Param('id') id: string) {
    const membership = await prisma.organizationMember.findUnique({
      where: { userId_organizationId: { userId: req.user!.id, organizationId: id } },
    });
    if (!membership) {
      return [];
    }
    return prisma.organizationMember.findMany({
      where: { organizationId: id },
      include: { user: { select: { id: true, email: true, name: true } } },
    });
  }
}
