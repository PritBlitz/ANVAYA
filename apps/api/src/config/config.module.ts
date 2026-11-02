import { Global, Module } from '@nestjs/common';
import { AppConfig } from './config.js';

@Global()
@Module({
  providers: [{ provide: AppConfig, useFactory: () => new AppConfig() }],
  exports: [AppConfig],
})
export class ConfigModule {}
