import { CanActivate, ExecutionContext, Injectable, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import jwt from 'jsonwebtoken';
import { loadConfig } from '@catalogfix/config';
import { prisma } from '@catalogfix/database';

export interface AdminAuthUser {
  id: string;
  email: string;
  systemRole: string;
}

@Injectable()
export class AdminGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & { user?: AdminAuthUser }>();
    const authHeader = req.headers.authorization;
    let token = req.cookies?.cf_access as string | undefined;
    if (!token && authHeader?.startsWith('Bearer ')) {
      token = authHeader.slice(7).trim();
    }

    if (!token) {
      throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Admin authentication required.' });
    }

    try {
      const config = loadConfig();
      const payload = jwt.verify(token, config.JWT_ACCESS_SECRET) as { sub: string; email: string };
      const user = await prisma.user.findFirst({
        where: { id: payload.sub, status: 'ACTIVE', deletedAt: null },
      });

      if (!user) {
        throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'User not found or inactive.' });
      }

      // Check system role or allow if email is admin@catalogfix.io (fallback)
      const isAdmin = user.systemRole === 'ADMIN' || user.email === 'admin@catalogfix.io';

      if (!isAdmin) {
        throw new ForbiddenException({ code: 'FORBIDDEN', message: 'System Administrator privileges required.' });
      }

      req.user = { id: user.id, email: user.email, systemRole: user.systemRole || 'ADMIN' };
      return true;
    } catch (err) {
      if (err instanceof ForbiddenException || err instanceof UnauthorizedException) {
        throw err;
      }
      throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Invalid admin authentication token.' });
    }
  }
}
