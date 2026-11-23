import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { SessionsService } from './sessions.service';
import { TokenService } from './token.service';
import { TwoFactorService } from './two-factor.service';

@Module({
  providers: [AuthService, PasswordService, TokenService, SessionsService, TwoFactorService, AuthGuard],
  controllers: [AuthController],
  exports: [AuthGuard, AuthService, TokenService, PasswordService, TwoFactorService, SessionsService],
})
export class AuthModule {}
