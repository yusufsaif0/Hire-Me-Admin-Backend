import { AuthModule } from './auth/auth.module';
import { Module } from '@nestjs/common';
import { FamilyModule } from './family/family.module';
import { HealthController } from './health.controller';
import { MockIntegrations } from './integrations/mock-integrations';
@Module({
  imports: [AuthModule, FamilyModule],
  controllers: [HealthController],
  providers: [MockIntegrations],
})
export class AppModule {}
