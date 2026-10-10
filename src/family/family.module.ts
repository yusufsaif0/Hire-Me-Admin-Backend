import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuthRepository } from '../auth/repository';
import { AuthSettings } from '../auth/settings';
import { AccessGuard } from '../auth/http';
import { backendRole } from '../environment';
import { FamilySettings } from './settings';
import { CustomerFamilyService } from './customer-service';
import { ConsentAdminService } from './admin-service';
import { CustomerFamilyController, ConsentAdminController, ConsentCsrfGuard } from './controllers';
@Module({
  imports: [AuthModule],
  controllers:
    (backendRole as string) === 'ADMIN' ? [ConsentAdminController] : [CustomerFamilyController],
  providers: [
    { provide: FamilySettings, useFactory: () => new FamilySettings() },
    {
      provide: CustomerFamilyService,
      useFactory: (a: AuthSettings, r: AuthRepository, s: FamilySettings) =>
        new CustomerFamilyService(a, r, s),
      inject: [AuthSettings, AuthRepository, FamilySettings],
    },
    {
      provide: ConsentAdminService,
      useFactory: (a: AuthSettings, r: AuthRepository, s: FamilySettings) =>
        new ConsentAdminService(a, r, s),
      inject: [AuthSettings, AuthRepository, FamilySettings],
    },
    AccessGuard,
    ConsentCsrfGuard,
  ],
  exports: [FamilySettings, CustomerFamilyService, ConsentAdminService],
})
export class FamilyModule {}
