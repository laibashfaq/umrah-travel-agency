import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  refreshSchema,
  registerSchema,
  resendVerificationSchema,
  resetPasswordSchema,
  twoFactorManageSchema,
  twoFactorSetupConfirmSchema,
  twoFactorSetupStartSchema,
  twoFactorVerifySchema,
  verifyEmailSchema,
} from '@umrah/shared';
import type { Request } from 'express';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { ZodPipe } from '../common/http/zod.pipe';
import { ApiZodBody } from '../docs/zod-openapi';
import type { AuthUser } from './auth.types';
import { AuthService } from './auth.service';
import { CurrentUser, Public } from './decorators';

const min = (limit: number) => ({ default: { limit, ttl: 60_000 } });
const familyParam = z.string().uuid();

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly audit: AuditService,
  ) {}

  /* ------------------------------ registration ------------------------------ */

  @Public()
  @Post('register')
  @HttpCode(202)
  @Throttle(min(5))
  @ApiOperation({ summary: 'Create a customer account', description: 'Always answers the same way, whether or not the email is already registered, to prevent account enumeration.' })
  @ApiZodBody(registerSchema)
  register(@Body(new ZodPipe(registerSchema)) body: z.infer<typeof registerSchema>, @Req() req: Request) {
    return this.auth.register(body, this.audit.context(req));
  }

  @Public()
  @Post('verify-email')
  @HttpCode(200)
  @Throttle(min(10))
  @ApiZodBody(verifyEmailSchema)
  verifyEmail(@Body(new ZodPipe(verifyEmailSchema)) body: z.infer<typeof verifyEmailSchema>, @Req() req: Request) {
    return this.auth.verifyEmail(body.token, this.audit.context(req));
  }

  @Public()
  @Post('resend-verification')
  @HttpCode(202)
  @Throttle(min(5))
  @ApiZodBody(resendVerificationSchema)
  resend(@Body(new ZodPipe(resendVerificationSchema)) body: z.infer<typeof resendVerificationSchema>) {
    return this.auth.resendVerification(body.email);
  }

  /* --------------------------------- sign in --------------------------------- */

  @Public()
  @Post('login')
  @HttpCode(200)
  @Throttle(min(10))
  @ApiOperation({
    summary: 'Sign in',
    description: 'Returns tokens, or a two-factor step for staff: `two_factor_required` (enter a code) or `two_factor_setup_required` (enrol an authenticator first).',
  })
  @ApiZodBody(loginSchema)
  login(@Body(new ZodPipe(loginSchema)) body: z.infer<typeof loginSchema>, @Req() req: Request) {
    return this.auth.login(body, this.audit.context(req));
  }

  @Public()
  @Post('2fa/verify')
  @HttpCode(200)
  @Throttle(min(10))
  @ApiZodBody(twoFactorVerifySchema)
  twoFactorVerify(@Body(new ZodPipe(twoFactorVerifySchema)) body: z.infer<typeof twoFactorVerifySchema>, @Req() req: Request) {
    return this.auth.verifyTwoFactor(body, this.audit.context(req));
  }

  @Public()
  @Post('2fa/setup/start')
  @HttpCode(200)
  @Throttle(min(10))
  @ApiZodBody(twoFactorSetupStartSchema)
  twoFactorSetupStart(@Body(new ZodPipe(twoFactorSetupStartSchema)) body: z.infer<typeof twoFactorSetupStartSchema>) {
    return this.auth.startTwoFactorSetup(body.setupToken);
  }

  @Public()
  @Post('2fa/setup/confirm')
  @HttpCode(200)
  @Throttle(min(10))
  @ApiZodBody(twoFactorSetupConfirmSchema)
  twoFactorSetupConfirm(@Body(new ZodPipe(twoFactorSetupConfirmSchema)) body: z.infer<typeof twoFactorSetupConfirmSchema>, @Req() req: Request) {
    return this.auth.confirmTwoFactorSetup(body.setupToken, body.code, this.audit.context(req));
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  @Throttle(min(60))
  @ApiOperation({ summary: 'Rotate the refresh token', description: 'Each refresh token works once. Replaying an old one revokes the whole login.' })
  @ApiZodBody(refreshSchema)
  refresh(@Body(new ZodPipe(refreshSchema)) body: z.infer<typeof refreshSchema>, @Req() req: Request) {
    return this.auth.refresh(body.refreshToken, this.audit.context(req));
  }

  /* -------------------------------- passwords -------------------------------- */

  @Public()
  @Post('forgot-password')
  @HttpCode(202)
  @Throttle(min(5))
  @ApiZodBody(forgotPasswordSchema)
  forgot(@Body(new ZodPipe(forgotPasswordSchema)) body: z.infer<typeof forgotPasswordSchema>, @Req() req: Request) {
    return this.auth.forgotPassword(body.email, this.audit.context(req));
  }

  @Public()
  @Post('reset-password')
  @HttpCode(200)
  @Throttle(min(10))
  @ApiZodBody(resetPasswordSchema)
  reset(@Body(new ZodPipe(resetPasswordSchema)) body: z.infer<typeof resetPasswordSchema>, @Req() req: Request) {
    return this.auth.resetPassword(body.token, body.password, this.audit.context(req));
  }

  /* ----------------------------- signed-in endpoints ----------------------------- */

  @ApiBearerAuth('bearer')
  @Get('me')
  @ApiOperation({ summary: 'Current user with roles and effective permissions' })
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user);
  }

  @ApiBearerAuth('bearer')
  @Post('logout')
  @HttpCode(204)
  async logout(@CurrentUser() user: AuthUser, @Req() req: Request): Promise<void> {
    await this.auth.logout(user, this.audit.context(req));
  }

  @ApiBearerAuth('bearer')
  @Post('logout-all')
  @HttpCode(204)
  async logoutAll(@CurrentUser() user: AuthUser, @Req() req: Request): Promise<void> {
    await this.auth.logoutAll(user, this.audit.context(req));
  }

  @ApiBearerAuth('bearer')
  @Post('change-password')
  @HttpCode(200)
  @Throttle(min(5))
  @ApiZodBody(changePasswordSchema)
  changePassword(@CurrentUser() user: AuthUser, @Body(new ZodPipe(changePasswordSchema)) body: z.infer<typeof changePasswordSchema>, @Req() req: Request) {
    return this.auth.changePassword(user, body.currentPassword, body.newPassword, this.audit.context(req));
  }

  @ApiBearerAuth('bearer')
  @Get('sessions')
  @ApiOperation({ summary: 'Devices currently signed in' })
  sessions(@CurrentUser() user: AuthUser) {
    return this.auth.listSessions(user);
  }

  @ApiBearerAuth('bearer')
  @Delete('sessions/:id')
  @HttpCode(204)
  async revokeSession(@CurrentUser() user: AuthUser, @Param('id', new ZodPipe(familyParam)) id: string, @Req() req: Request): Promise<void> {
    await this.auth.revokeSession(user, id, this.audit.context(req));
  }

  @ApiBearerAuth('bearer')
  @Post('2fa/backup-codes')
  @HttpCode(200)
  @Throttle(min(5))
  @ApiOperation({ summary: 'Replace backup codes (needs password and a current code)' })
  @ApiZodBody(twoFactorManageSchema)
  async backupCodes(@CurrentUser() user: AuthUser, @Body(new ZodPipe(twoFactorManageSchema)) body: z.infer<typeof twoFactorManageSchema>, @Req() req: Request) {
    return { backupCodes: await this.auth.regenerateBackupCodes(user, body.password, body.code, this.audit.context(req)) };
  }

  @ApiBearerAuth('bearer')
  @Post('2fa/disable')
  @HttpCode(200)
  @Throttle(min(5))
  @ApiZodBody(twoFactorManageSchema)
  disable2fa(@CurrentUser() user: AuthUser, @Body(new ZodPipe(twoFactorManageSchema)) body: z.infer<typeof twoFactorManageSchema>, @Req() req: Request) {
    return this.auth.disableTwoFactor(user, body.password, body.code, this.audit.context(req));
  }
}
