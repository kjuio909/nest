import { Module } from '@nestjs/common';
import {
  AggregateParamErrorsBatchController,
  AggregateParamErrorsController,
} from './aggregate-param-errors.controller.js';

@Module({
  controllers: [
    AggregateParamErrorsController,
    AggregateParamErrorsBatchController,
  ],
})
export class AggregateParamErrorsModule {}
