import { Module } from '@nestjs/common';
import { AggregateParamErrorsController } from './aggregate-param-errors.controller.js';

@Module({
  controllers: [AggregateParamErrorsController],
})
export class AggregateParamErrorsModule {}
