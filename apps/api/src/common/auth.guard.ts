import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import jwt from 'jsonwebtoken';
import { loadConfig } from '@catalogfix/config';
import { prisma } from '@catalogfix/database';

export interface AuthUser {
  id: string;
  email: string;
}

@Injectable()
export class AuthGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const authHeader = req.headers.authorization;
    let token = req.cookies?.cf_access as string | undefined;
    if (!token && authHeader?.startsWith('Bearer ')) {
      token = authHeader.slice(7).trim();
    }
    if (!token) {
      throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Authentication required.' });
    }
    try {
      const config = loadConfig();
      const payload = jwt.verify(token, config.JWT_ACCESS_SECRET) as { sub: string; email: string };
      const user = await prisma.user.findFirst({
        where: { id: payload.sub, status: 'ACTIVE', deletedAt: null },
      });
      if (!user) {
        throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Authentication required.' });
      }
      req.user = { id: user.id, email: user.email };
      return true;
    } catch {
      throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Authentication required.' });
    }
  }
}
