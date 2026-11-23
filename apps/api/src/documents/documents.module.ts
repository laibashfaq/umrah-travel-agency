import { Module } from '@nestjs/common';
import { AdminDocumentsController, CustomerDocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { VisaService } from './visa.service';

@Module({
  controllers: [CustomerDocumentsController, AdminDocumentsController],
  providers: [DocumentsService, VisaService],
  exports: [DocumentsService, VisaService],
})
export class DocumentsModule {}
