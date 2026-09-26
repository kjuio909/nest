import { Module } from '@nestjs/common';
import {
  AggregateParamErrorsController,
  BatchController,
} from './aggregate-param-errors.controller.js';

@Module({
  controllers: [AggregateParamErrorsController, BatchController],
})
export class AggregateParamErrorsModule {}
