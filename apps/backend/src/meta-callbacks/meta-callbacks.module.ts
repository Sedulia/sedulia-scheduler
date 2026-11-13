import { Module } from '@nestjs/common';
import { RetentionService } from '@gitroom/nestjs-libraries/database/prisma/retention/retention.service';
import { MetaCallbacksController } from '@gitroom/backend/meta-callbacks/meta-callbacks.controller';
import { MetaCallbacksService } from '@gitroom/backend/meta-callbacks/meta-callbacks.service';

// PrismaService comes from the global DatabaseModule.
@Module({
  controllers: [MetaCallbacksController],
  providers: [MetaCallbacksService, RetentionService],
})
export class MetaCallbacksModule {}
