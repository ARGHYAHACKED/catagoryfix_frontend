import { Injectable, NotFoundException } from '@nestjs/common';
import { prisma, Prisma, SystemRole, UserStatus } from '@catalogfix/database';

@Injectable()
export class AdminService {
  async getSystemStats() {
    try {
      const [
        totalUsers,
        totalOrgs,
        totalImports,
        completedImports,
        failedImports,
        totalExports,
        totalProducts,
        validProducts,
        invalidProducts,
        freeSubs,
        starterSubs,
        businessSubs,
        proSubs,
        activeSubs,
        pastDueSubs,
        cancelledSubs,
      ] = await Promise.all([
        prisma.user.count({ where: { deletedAt: null } }),
        prisma.organization.count({ where: { deletedAt: null } }),
        prisma.importJob.count({ where: { deletedAt: null } }),
        prisma.importJob.count({ where: { status: 'COMPLETED', deletedAt: null } }),
        prisma.importJob.count({ where: { status: 'FAILED', deletedAt: null } }),
        prisma.exportJob.count(),
        prisma.product.count({ where: { deletedAt: null } }),
        prisma.product.count({ where: { status: 'READY', deletedAt: null } }),
        prisma.product.count({ where: { status: 'INVALID', deletedAt: null } }),
        prisma.subscription.count({ where: { plan: 'FREE' } }),
        prisma.subscription.count({ where: { plan: 'STARTER' } }),
        prisma.subscription.count({ where: { plan: 'BUSINESS' } }),
        prisma.subscription.count({ where: { plan: 'PRO' } }),
        prisma.subscription.count({ where: { status: 'ACTIVE' } }),
        prisma.subscription.count({ where: { status: 'PAST_DUE' } }),
        prisma.subscription.count({ where: { status: 'CANCELLED' } }),
      ]);

      const rowSum = await prisma.importJob.aggregate({
        _sum: {
          totalRows: true,
          processedRows: true,
        },
        where: { deletedAt: null },
      });

      const estimatedMRR = starterSubs * 9 + businessSubs * 19 + proSubs * 49;

      return {
        users: {
          total: totalUsers || 0,
        },
        organizations: {
          total: totalOrgs || 0,
        },
        imports: {
          total: totalImports || 0,
          completed: completedImports || 0,
          failed: failedImports || 0,
          totalRows: rowSum?._sum?.totalRows ?? 0,
          processedRows: rowSum?._sum?.processedRows ?? 0,
        },
        exports: {
          total: totalExports || 0,
        },
        products: {
          total: totalProducts || 0,
          valid: validProducts || 0,
          invalid: invalidProducts || 0,
        },
        billing: {
          totalSubscriptions: freeSubs + starterSubs + businessSubs + proSubs,
          activeSubscriptions: activeSubs || 0,
          pastDueSubscriptions: pastDueSubs || 0,
          cancelledSubscriptions: cancelledSubs || 0,
          estimatedMRR,
          plans: {
            FREE: freeSubs || 0,
            STARTER: starterSubs || 0,
            BUSINESS: businessSubs || 0,
            PRO: proSubs || 0,
          },
        },
      };
    } catch (err) {
      console.error('Error fetching admin stats:', err);
      return {
        users: { total: 0 },
        organizations: { total: 0 },
        imports: { total: 0, completed: 0, failed: 0, totalRows: 0, processedRows: 0 },
        exports: { total: 0 },
        products: { total: 0, valid: 0, invalid: 0 },
        billing: {
          totalSubscriptions: 0,
          activeSubscriptions: 0,
          pastDueSubscriptions: 0,
          cancelledSubscriptions: 0,
          estimatedMRR: 0,
          plans: { FREE: 0, STARTER: 0, BUSINESS: 0, PRO: 0 },
        },
      };
    }
  }

  async getAllUsers(search?: string, limit = 50, offset = 0) {
    try {
      const whereClause: Prisma.UserWhereInput = { deletedAt: null };
      if (search) {
        whereClause.OR = [
          { email: { contains: search, mode: 'insensitive' } },
          { name: { contains: search, mode: 'insensitive' } },
        ];
      }

      const [users, total] = await Promise.all([
        prisma.user.findMany({
          where: whereClause,
          take: limit,
          skip: offset,
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            email: true,
            name: true,
            systemRole: true,
            status: true,
            createdAt: true,
            memberships: {
              select: {
                role: true,
                organization: {
                  select: {
                    id: true,
                    name: true,
                    slug: true,
                  },
                },
              },
            },
          },
        }),
        prisma.user.count({ where: whereClause }),
      ]);

      return { users, total };
    } catch (err) {
      console.error('Error fetching all users for admin:', err);
      return { users: [], total: 0 };
    }
  }

  async updateUserRole(userId: string, systemRole: SystemRole) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found.');
    }
    return prisma.user.update({
      where: { id: userId },
      data: { systemRole },
      select: { id: true, email: true, name: true, systemRole: true },
    });
  }

  async updateUserStatus(userId: string, status: UserStatus) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found.');
    }
    return prisma.user.update({
      where: { id: userId },
      data: { status },
      select: { id: true, email: true, status: true },
    });
  }

  async getAllOrganizations(limit = 50, offset = 0) {
    try {
      const [orgs, total] = await Promise.all([
        prisma.organization.findMany({
          where: { deletedAt: null },
          take: limit,
          skip: offset,
          orderBy: { createdAt: 'desc' },
          include: {
            subscription: true,
            _count: {
              select: {
                members: true,
                imports: true,
                exports: true,
              },
            },
          },
        }),
        prisma.organization.count({ where: { deletedAt: null } }),
      ]);

      return { organizations: orgs, total };
    } catch (err) {
      console.error('Error fetching organizations for admin:', err);
      return { organizations: [], total: 0 };
    }
  }

  async getAllImports(limit = 50, offset = 0) {
    try {
      const [imports, total] = await Promise.all([
        prisma.importJob.findMany({
          where: { deletedAt: null },
          take: limit,
          skip: offset,
          orderBy: { createdAt: 'desc' },
          include: {
            organization: { select: { id: true, name: true, slug: true } },
            createdBy: { select: { id: true, email: true, name: true } },
            files: true,
            _count: { select: { products: true, issues: true } },
          },
        }),
        prisma.importJob.count({ where: { deletedAt: null } }),
      ]);

      return { imports, total };
    } catch (err) {
      console.error('Error fetching imports for admin:', err);
      return { imports: [], total: 0 };
    }
  }

  async getAllExports(limit = 50, offset = 0) {
    try {
      const [exports, total] = await Promise.all([
        prisma.exportJob.findMany({
          take: limit,
          skip: offset,
          orderBy: { createdAt: 'desc' },
          include: {
            organization: { select: { id: true, name: true } },
            createdBy: { select: { id: true, email: true } },
            files: true,
          },
        }),
        prisma.exportJob.count(),
      ]);

      return { exports, total };
    } catch (err) {
      console.error('Error fetching exports for admin:', err);
      return { exports: [], total: 0 };
    }
  }

  async getAuditLogs(limit = 50, offset = 0) {
    try {
      const [logs, total] = await Promise.all([
        prisma.auditLog.findMany({
          take: limit,
          skip: offset,
          orderBy: { createdAt: 'desc' },
          include: {
            user: { select: { id: true, email: true } },
            organization: { select: { id: true, name: true } },
          },
        }),
        prisma.auditLog.count(),
      ]);

      return { logs, total };
    } catch (err) {
      console.error('Error fetching audit logs for admin:', err);
      return { logs: [], total: 0 };
    }
  }

  async getAllSubscriptions(limit = 50, offset = 0) {
    try {
      const [subscriptions, total] = await Promise.all([
        prisma.subscription.findMany({
          take: limit,
          skip: offset,
          orderBy: { createdAt: 'desc' },
          include: {
            organization: {
              select: {
                id: true,
                name: true,
                slug: true,
                members: {
                  select: {
                    user: { select: { email: true, name: true } },
                    role: true,
                  },
                },
              },
            },
          },
        }),
        prisma.subscription.count(),
      ]);

      return { subscriptions, total };
    } catch (err) {
      console.error('Error fetching subscriptions for admin:', err);
      return { subscriptions: [], total: 0 };
    }
  }

  async updateSubscription(
    subscriptionId: string,
    plan: 'FREE' | 'STARTER' | 'BUSINESS' | 'PRO',
    status?: 'ACTIVE' | 'PAST_DUE' | 'CANCELLED' | 'TRIALING' | 'EXPIRED',
  ) {
    const sub = await prisma.subscription.findUnique({ where: { id: subscriptionId } });
    if (!sub) {
      throw new NotFoundException('Subscription not found.');
    }
    return prisma.subscription.update({
      where: { id: subscriptionId },
      data: {
        plan,
        ...(status ? { status } : {}),
      },
      include: {
        organization: { select: { id: true, name: true } },
      },
    });
  }
}
