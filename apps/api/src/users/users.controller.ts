import { Body, Controller, Get, Patch, Req, UseGuards } from '@nestjs/common';
import { prisma } from '@catalogfix/database';
import { AuthGuard, type AuthUser } from '../common/auth.guard';
import type { Request } from 'express';

@Controller('users')
@UseGuards(AuthGuard)
export class UsersController {
  @Get('me')
  async me(@Req() req: Request & { user?: AuthUser }) {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { id: true, email: true, name: true, avatarUrl: true, emailVerifiedAt: true, createdAt: true },
    });
    const memberships = await prisma.organizationMember.findMany({
      where: { userId: req.user!.id },
      include: { organization: true },
    });
    return {
      user,
      organizations: memberships.map((m: any) => ({
        id: m.organization.id,
        name: m.organization.name,
        slug: m.organization.slug,
        role: m.role,
      })),
    };
  }

  @Patch('me')
  async update(@Req() req: Request & { user?: AuthUser }, @Body() body: { name?: string }) {
    const name = body.name;
    const user = await prisma.user.update({
      where: { id: req.user!.id },
      data: { name: name?.trim() || undefined },
      select: { id: true, email: true, name: true, avatarUrl: true },
    });
    return { user };
  }
}
