import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import type { Response } from 'express';
import { loadConfig } from '@catalogfix/config';
import { AuditEvent, Plan, prisma, SubscriptionStatus, UserStatus } from '@catalogfix/database';
import { hashToken, randomToken, slugify } from '../common/crypto';

const SALT_ROUNDS = 12;

@Injectable()
export class AuthService {
  private cookieOptions() {
    const config = loadConfig();
    return {
      httpOnly: true,
      secure: config.COOKIE_SECURE,
      sameSite: 'lax' as const,
      domain: config.COOKIE_DOMAIN === 'localhost' ? undefined : config.COOKIE_DOMAIN,
      path: '/',
    };
  }

  setAuthCookies(res: Response, tokens: { access: string; refresh: string }): void {
    const config = loadConfig();
    res.cookie('cf_access', tokens.access, { ...this.cookieOptions(), maxAge: config.JWT_ACCESS_TTL * 1000 });
    res.cookie('cf_refresh', tokens.refresh, { ...this.cookieOptions(), maxAge: config.JWT_REFRESH_TTL * 1000 });
  }

  clearAuthCookies(res: Response): void {
    res.clearCookie('cf_access', this.cookieOptions());
    res.clearCookie('cf_refresh', this.cookieOptions());
  }

  private async issueTokens(userId: string, email: string) {
    const config = loadConfig();
    const access = jwt.sign({ sub: userId, email }, config.JWT_ACCESS_SECRET, {
      expiresIn: `${config.JWT_ACCESS_TTL}s`,
    });
    const refresh = randomToken();
    await prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: hashToken(refresh),
        expiresAt: new Date(Date.now() + config.JWT_REFRESH_TTL * 1000),
      },
    });
    return { access, refresh };
  }

  async register(input: { email: string; password: string; name: string; organizationName?: string }) {
    const email = input.email.trim().toLowerCase();
    if (!email || !input.password || input.password.length < 10 || !input.name) {
      throw new BadRequestException({
        code: 'INVALID_REGISTRATION',
        message: 'Name, email, and a password of at least 10 characters are required.',
      });
    }
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new BadRequestException({ code: 'EMAIL_IN_USE', message: 'Email is already registered.' });
    }
    const config = loadConfig();
    const passwordHash = await bcrypt.hash(`${input.password}${config.PASSWORD_PEPPER}`, SALT_ROUNDS);
    const orgName = input.organizationName?.trim() || `${input.name}'s workspace`;
    const baseSlug = slugify(orgName) || 'workspace';
    const result = await prisma.$transaction(async (tx: any) => {
      const user = await tx.user.create({
        data: { email, passwordHash, name: input.name, status: UserStatus.ACTIVE },
      });
      let slug = baseSlug;
      let n = 1;
      while (await tx.organization.findUnique({ where: { slug } })) {
        slug = `${baseSlug}-${n}`;
        n += 1;
      }
      const organization = await tx.organization.create({ data: { name: orgName, slug } });
      await tx.organizationMember.create({
        data: { userId: user.id, organizationId: organization.id, role: 'OWNER' },
      });
      await tx.subscription.create({
        data: {
          organizationId: organization.id,
          plan: Plan.FREE,
          status: SubscriptionStatus.ACTIVE,
        },
      });
      await tx.auditLog.create({
        data: {
          organizationId: organization.id,
          userId: user.id,
          event: AuditEvent.ORGANIZATION_CREATED,
          metadata: { slug },
        },
      });
      const verify = randomToken();
      await tx.emailVerificationToken.create({
        data: {
          userId: user.id,
          tokenHash: hashToken(verify),
          expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
        },
      });
      return { user, organization, verify };
    });
    const tokens = await this.issueTokens(result.user.id, result.user.email);
    return {
      user: { id: result.user.id, email: result.user.email, name: result.user.name, systemRole: result.user.systemRole },
      organization: { id: result.organization.id, name: result.organization.name, slug: result.organization.slug },
      verificationToken: process.env.NODE_ENV === 'production' ? undefined : result.verify,
      tokens,
    };
  }

  async login(emailRaw: string, password: string, ip?: string, userAgent?: string) {
    const email = emailRaw.trim().toLowerCase();
    const user = await prisma.user.findUnique({ where: { email } });
    const config = loadConfig();
    if (!user || user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException({ code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' });
    }
    const ok = await bcrypt.compare(`${password}${config.PASSWORD_PEPPER}`, user.passwordHash);
    if (!ok) {
      throw new UnauthorizedException({ code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' });
    }
    await prisma.session.create({
      data: {
        userId: user.id,
        ipAddress: ip,
        userAgent,
        expiresAt: new Date(Date.now() + config.JWT_REFRESH_TTL * 1000),
      },
    });
    await prisma.auditLog.create({
      data: { userId: user.id, event: AuditEvent.LOGIN, metadata: { ip } },
    });
    const tokens = await this.issueTokens(user.id, user.email);
    const memberships = await prisma.organizationMember.findMany({
      where: { userId: user.id },
      include: { organization: true },
    });
    return {
      user: { id: user.id, email: user.email, name: user.name, systemRole: user.systemRole },
      organizations: memberships.map((m: any) => ({
        id: m.organization.id,
        name: m.organization.name,
        slug: m.organization.slug,
        role: m.role,
      })),
      tokens,
    };
  }

  async refresh(refreshToken?: string) {
    if (!refreshToken) {
      throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Missing refresh token.' });
    }
    const tokenHash = hashToken(refreshToken);
    const stored = await prisma.refreshToken.findUnique({ where: { tokenHash } });
    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Refresh token is invalid.' });
    }
    const user = await prisma.user.findUnique({ where: { id: stored.userId } });
    if (!user) {
      throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Refresh token is invalid.' });
    }
    await prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });
    const tokens = await this.issueTokens(user.id, user.email);
    await prisma.refreshToken.update({
      where: { tokenHash: hashToken(tokens.refresh) },
      data: { replacedBy: stored.id },
    });
    return { user: { id: user.id, email: user.email, name: user.name, systemRole: user.systemRole }, tokens };
  }

  async logout(refreshToken?: string) {
    if (!refreshToken) return;
    await prisma.refreshToken.updateMany({
      where: { tokenHash: hashToken(refreshToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async logoutAll(userId: string) {
    await prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await prisma.auditLog.create({ data: { userId, event: AuditEvent.LOGOUT } });
  }

  async verifyEmail(token: string) {
    const stored = await prisma.emailVerificationToken.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!stored || stored.usedAt || stored.expiresAt < new Date()) {
      throw new BadRequestException({ code: 'INVALID_TOKEN', message: 'Verification token is invalid.' });
    }
    await prisma.$transaction([
      prisma.emailVerificationToken.update({ where: { id: stored.id }, data: { usedAt: new Date() } }),
      prisma.user.update({ where: { id: stored.userId }, data: { emailVerifiedAt: new Date() } }),
    ]);
  }

  async forgotPassword(emailRaw: string) {
    const email = emailRaw.trim().toLowerCase();
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return;
    }
    const token = randomToken();
    await prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + 1000 * 60 * 30),
      },
    });
  }

  async resetPassword(token: string, password: string) {
    if (!password || password.length < 10) {
      throw new BadRequestException({ code: 'WEAK_PASSWORD', message: 'Password must be at least 10 characters.' });
    }
    const stored = await prisma.passwordResetToken.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!stored || stored.usedAt || stored.expiresAt < new Date()) {
      throw new BadRequestException({ code: 'INVALID_TOKEN', message: 'Reset token is invalid.' });
    }
    const config = loadConfig();
    const passwordHash = await bcrypt.hash(`${password}${config.PASSWORD_PEPPER}`, SALT_ROUNDS);
    await prisma.$transaction([
      prisma.passwordResetToken.update({ where: { id: stored.id }, data: { usedAt: new Date() } }),
      prisma.user.update({ where: { id: stored.userId }, data: { passwordHash } }),
      prisma.refreshToken.updateMany({
        where: { userId: stored.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
  }
}
