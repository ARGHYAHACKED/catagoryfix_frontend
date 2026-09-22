import { Body, Controller, Get, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import type { Request, Response } from 'express';
import { AuthGuard, type AuthUser } from '../common/auth.guard';
import { prisma } from '@catalogfix/database';

@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @UseGuards(AuthGuard)
  @Get('me')
  async me(@Req() req: Request & { user?: AuthUser }) {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: {
        id: true,
        email: true,
        name: true,
        systemRole: true,
        status: true,
      },
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

  @Post('register')
  async register(
    @Body() body: { email: string; password: string; name: string; organizationName?: string },
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.register(body);
    this.auth.setAuthCookies(res, result.tokens);
    return { user: result.user, organization: result.organization };
  }

  @Post('login')
  async login(
    @Body() body: { email: string; password: string },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.login(body.email, body.password, req.ip, req.headers['user-agent']);
    this.auth.setAuthCookies(res, result.tokens);
    return { user: result.user, organizations: result.organizations };
  }

  @Post('refresh')
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = req.cookies?.cf_refresh as string | undefined;
    const result = await this.auth.refresh(token);
    this.auth.setAuthCookies(res, result.tokens);
    return { user: result.user };
  }

  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(req.cookies?.cf_refresh as string | undefined);
    this.auth.clearAuthCookies(res);
    return { ok: true };
  }

  @UseGuards(AuthGuard)
  @Post('logout-all')
  async logoutAll(@Req() req: Request & { user?: AuthUser }, @Res({ passthrough: true }) res: Response) {
    await this.auth.logoutAll(req.user!.id);
    this.auth.clearAuthCookies(res);
    return { ok: true };
  }

  @Post('verify-email')
  async verify(@Body() body: { token: string }) {
    await this.auth.verifyEmail(body.token);
    return { ok: true };
  }

  @Post('forgot-password')
  async forgot(@Body() body: { email: string }) {
    await this.auth.forgotPassword(body.email);
    return { ok: true };
  }

  @Post('reset-password')
  async reset(@Body() body: { token: string; password: string }) {
    await this.auth.resetPassword(body.token, body.password);
    return { ok: true };
  }
}

