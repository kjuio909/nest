import { EventEmitter } from 'events';
import { of } from 'rxjs';
import { PassThrough } from 'stream';
import { CUSTOM_ROUTE_ARGS_METADATA } from '../../../common/constants.js';
import { RouteParamtypes } from '../../../common/enums/route-paramtypes.enum.js';
import {
  AggregateParamErrors,
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  PipeTransform,
  RouteParamMetadata,
} from '../../../common/index.js';
import { AbstractHttpAdapter } from '../../adapters/index.js';
import { ApplicationConfig } from '../../application-config.js';
import { FORBIDDEN_MESSAGE } from '../../guards/constants.js';
import { GuardsConsumer } from '../../guards/guards-consumer.js';
import { GuardsContextCreator } from '../../guards/guards-context-creator.js';
import { HandlerResponseBasicFn } from '../../helpers/handler-metadata-storage.js';
import { NestContainer } from '../../injector/container.js';
import { InterceptorsConsumer } from '../../interceptors/interceptors-consumer.js';
import { InterceptorsContextCreator } from '../../interceptors/interceptors-context-creator.js';
import { PipesConsumer } from '../../pipes/pipes-consumer.js';
import { PipesContextCreator } from '../../pipes/pipes-context-creator.js';
import { RouteParamsFactory } from '../../router/route-params-factory.js';
import { RouterExecutionContext } from '../../router/router-execution-context.js';
import { HeaderStream } from '../../router/sse-stream.js';
import { NoopHttpAdapter } from '../utils/noop-adapter.js';

describe('RouterExecutionContext', () => {
  let contextCreator: RouterExecutionContext;
  let callback: any;
  let applySpy: ReturnType<typeof vi.fn>;
  let factory: RouteParamsFactory;
  let consumer: PipesConsumer;
  let guardsConsumer: GuardsConsumer;
  let interceptorsConsumer: InterceptorsConsumer;
  let adapter: AbstractHttpAdapter;

  const attachSocket = <T extends PassThrough>(request: T) =>
    Object.assign(request, {
      socket: Object.assign(new EventEmitter(), {
        setKeepAlive() {},
        setNoDelay() {},
        setTimeout() {},
      }),
    }) as T & {
      socket: EventEmitter & {
        setKeepAlive(): void;
        setNoDelay(): void;
        setTimeout(): void;
      };
    };

  beforeEach(() => {
    callback = {
      bind: () => ({}),
      apply: () => ({}),
    };
    applySpy = vi.spyOn(callback, 'apply');

    factory = new RouteParamsFactory();
    consumer = new PipesConsumer();
    guardsConsumer = new GuardsConsumer();
    interceptorsConsumer = new InterceptorsConsumer();
    adapter = new NoopHttpAdapter({});
    contextCreator = new RouterExecutionContext(
      factory,
      new PipesContextCreator(new NestContainer(), new ApplicationConfig()),
      consumer,
      new GuardsContextCreator(new NestContainer()),
      guardsConsumer,
      new InterceptorsContextCreator(new NestContainer()),
      interceptorsConsumer,
      adapter,
    );
  });
  describe('create', () => {
    it('should pass an unresolved Promise<Observable> to the SSE response handler', async () => {
      const result = Promise.resolve(of('test'));
      const fnHandleResponse = vi.fn().mockResolvedValue(undefined);

      vi.spyOn(contextCreator, 'getMetadata').mockReturnValue({
        argsLength: 0,
        fnHandleResponse,
        isSseHandler: true,
        paramtypes: [],
        getParamsMetadata: vi.fn().mockReturnValue([]),
        httpStatusCode: 200,
        hasCustomHeaders: false,
        responseHeaders: [],
      } as any);
      vi.spyOn(contextCreator, 'createGuardsFn').mockReturnValue(null as any);
      vi.spyOn(contextCreator, 'createPipesFn').mockReturnValue(null as any);
      vi.spyOn(interceptorsConsumer, 'intercept').mockReturnValue(
        result as any,
      );

      const proxy = contextCreator.create({} as any, callback, '', '', 0);
      await proxy({}, {}, vi.fn());

      expect(fnHandleResponse).toHaveBeenCalledOnce();
      expect(fnHandleResponse.mock.calls[0][0]).toBe(result);
    });

    describe('when callback metadata is not undefined', () => {
      let metadata: Record<number, RouteParamMetadata>;
      let exchangeKeysForValuesSpy: ReturnType<typeof vi.fn>;
      beforeEach(() => {
        metadata = {
          [RouteParamtypes.NEXT]: { index: 0 },
          [RouteParamtypes.BODY]: {
            index: 2,
            data: 'test',
          },
        };
        vi.spyOn(
          (contextCreator as any).contextUtils,
          'reflectCallbackMetadata',
        ).mockReturnValue(metadata);
        vi.spyOn(
          (contextCreator as any).contextUtils,
          'reflectCallbackParamtypes',
        ).mockReturnValue([]);
        exchangeKeysForValuesSpy = vi.spyOn(
          contextCreator,
          'exchangeKeysForValues',
        );
      });
      it('should call "exchangeKeysForValues" with expected arguments', () =>
        new Promise<void>(done => {
          const keys = Object.keys(metadata);

          contextCreator.create({ foo: 'bar' }, callback, '', '', 0);
          expect(exchangeKeysForValuesSpy).toHaveBeenCalled();
          expect(exchangeKeysForValuesSpy).toHaveBeenCalledWith(
            keys,
            metadata,
            '',
            expect.anything(),
            undefined,
            expect.any(Function),
          );
          done();
        }));
      describe('returns proxy function', () => {
        let proxyContext;
        let instance;
        let tryActivateStub;
        beforeEach(() => {
          instance = { foo: 'bar' };

          const canActivateFn = contextCreator.createGuardsFn(
            [1] as any,
            null!,
            null!,
          );
          vi.spyOn(contextCreator, 'createGuardsFn').mockReturnValue(
            canActivateFn,
          );
          tryActivateStub = vi
            .spyOn(guardsConsumer, 'tryActivate')
            .mockImplementation(async () => true);
          proxyContext = contextCreator.create(instance, callback, '', '', 0);
        });
        it('should be a function', () => {
          expect(proxyContext).toBeTypeOf('function');
        });
        describe('when proxy function called', () => {
          let request;
          const response = {
            status: () => response,
            send: () => response,
            json: () => response,
          };
          const next = {};

          beforeEach(() => {
            request = {
              body: {
                test: 3,
              },
            };
          });
          it('should apply expected context and arguments to callback', () =>
            new Promise<void>(done => {
              tryActivateStub.mockImplementation(async () => true);
              proxyContext(request, response, next).then(() => {
                const args = [next, undefined, request.body.test];
                expect(applySpy).toHaveBeenCalled();
                expect(applySpy).toHaveBeenCalledWith(instance, args);
                done();
              });
            }));
          it('should throw exception when "tryActivate" returns false', async () => {
            tryActivateStub.mockImplementation(async () => false);

            let error: HttpException;
            try {
              await proxyContext(request, response, next);
            } catch (e) {
              error = e;
            }
            expect(error!).toBeInstanceOf(ForbiddenException);
            expect(error!.message).toEqual('Forbidden resource');
            expect(error!.getResponse()).toEqual({
              statusCode: HttpStatus.FORBIDDEN,
              error: 'Forbidden',
              message: FORBIDDEN_MESSAGE,
            });
          });
          it('should apply expected context when "canActivateFn" apply', () => {
            proxyContext(request, response, next).then(() => {
              expect(tryActivateStub.mock.calls[0][1][0]).toBe(request);
              expect(tryActivateStub.mock.calls[0][1][1]).toBe(response);
              expect(tryActivateStub.mock.calls[0][1][2]).toBe(next);
            });
          });
          it('should apply expected context when "intercept" apply', () => {
            const interceptStub = vi
              .spyOn(interceptorsConsumer, 'intercept')
              .mockImplementation(() => ({}) as any);
            proxyContext(request, response, next).then(() => {
              expect(interceptStub.mock.calls[0][1][0]).toBe(request);
              expect(interceptStub.mock.calls[0][1][1]).toBe(response);
              expect(interceptStub.mock.calls[0][1][2]).toBe(next);
            });
          });
        });
      });
    });
  });

  describe('exchangeKeysForValues', () => {
    it('should exchange arguments keys for appropriate values', () => {
      const metadata = {
        [RouteParamtypes.REQUEST]: { index: 0, data: 'test', pipes: [] },
        [RouteParamtypes.BODY]: { index: 2, data: 'test', pipes: [] },
        [`key${CUSTOM_ROUTE_ARGS_METADATA}`]: {
          index: 3,
          data: 'custom',
          pipes: [],
        },
      };
      const keys = Object.keys(metadata);
      const values = contextCreator.exchangeKeysForValues(keys, metadata, '');
      const expectedValues = [
        { index: 0, type: RouteParamtypes.REQUEST, data: 'test' },
        { index: 2, type: RouteParamtypes.BODY, data: 'test' },
        { index: 3, type: `key${CUSTOM_ROUTE_ARGS_METADATA}`, data: 'custom' },
      ];
      expect(values[0]).toMatchObject(expectedValues[0]);
      expect(values[1]).toMatchObject(expectedValues[1]);
    });
  });

  describe('getParamValue', () => {
    let consumerApplySpy: ReturnType<typeof vi.fn>;
    const value = 3,
      metatype = null,
      transforms = [{ transform: vi.fn() }];

    beforeEach(() => {
      consumerApplySpy = vi.spyOn(consumer, 'apply');
    });
    describe('when paramtype is query, body, rawBody or param', () => {
      it('should call "consumer.apply" with expected arguments', async () => {
        await contextCreator.getParamValue(
          value,
          { metatype, type: RouteParamtypes.QUERY, data: null },
          transforms,
        );
        expect(consumerApplySpy).toHaveBeenCalledWith(
          value,
          { metatype, type: RouteParamtypes.QUERY, data: null },
          transforms,
        );

        await contextCreator.getParamValue(
          value,
          { metatype, type: RouteParamtypes.BODY, data: null },
          transforms,
        );
        expect(consumerApplySpy).toHaveBeenCalledWith(
          value,
          { metatype, type: RouteParamtypes.BODY, data: null },
          transforms,
        );

        await contextCreator.getParamValue(
          value,
          { metatype, type: RouteParamtypes.RAW_BODY, data: null },
          transforms,
        );
        expect(consumerApplySpy).toHaveBeenCalledWith(
          value,
          { metatype, type: RouteParamtypes.RAW_BODY, data: null },
          transforms,
        );

        await contextCreator.getParamValue(
          value,
          { metatype, type: RouteParamtypes.PARAM, data: null },
          transforms,
        );
        expect(consumerApplySpy).toHaveBeenCalledWith(
          value,
          { metatype, type: RouteParamtypes.PARAM, data: null },
          transforms,
        );
      });
    });
  });
  describe('isPipeable', () => {
    describe('when paramtype is not query, body, param and custom', () => {
      it('should return false', () => {
        const result = contextCreator.isPipeable(RouteParamtypes.NEXT);
        expect(result).toBe(false);
      });
      it('otherwise', () => {
        expect(contextCreator.isPipeable(RouteParamtypes.BODY)).toBe(true);
        expect(contextCreator.isPipeable(RouteParamtypes.RAW_BODY)).toBe(true);
        expect(contextCreator.isPipeable(RouteParamtypes.QUERY)).toBe(true);
        expect(contextCreator.isPipeable(RouteParamtypes.PARAM)).toBe(true);
        expect(contextCreator.isPipeable(RouteParamtypes.FILE)).toBe(true);
        expect(contextCreator.isPipeable(RouteParamtypes.FILES)).toBe(true);
        expect(contextCreator.isPipeable('custom')).toBe(true);
      });
    });
  });
  describe('createPipesFn', () => {
    describe('when "paramsOptions" is empty', () => {
      it('returns null', async () => {
        const pipesFn = contextCreator.createPipesFn([], []);
        expect(pipesFn).toBeNull();
      });
    });

    const buildParam = (
      index: number,
      type: number,
      value: unknown,
      paramPipes: PipeTransform[] = [],
    ) => ({
      index,
      type,
      data: undefined,
      pipes: paramPipes,
      extractValue: () => value,
    });

    const throwingPipe = (message: string): PipeTransform => ({
      transform: () => {
        throw new BadRequestException(message);
      },
    });

    describe('when "aggregateParamErrors" is not enabled', () => {
      it('rejects with the first thrown exception (existing path)', async () => {
        const pipesFn = contextCreator.createPipesFn(
          [],
          [
            buildParam(0, RouteParamtypes.PARAM, 'abc', [throwingPipe('A')]),
            buildParam(1, RouteParamtypes.QUERY, 'x', [throwingPipe('B')]),
          ],
        )!;

        let error: BadRequestException;
        try {
          await pipesFn!([undefined, undefined], {}, {}, () => {});
        } catch (e) {
          error = e;
        }
        expect(error!).toBeInstanceOf(BadRequestException);
        expect(error!.getResponse()).toEqual({
          statusCode: HttpStatus.BAD_REQUEST,
          error: 'Bad Request',
          message: expect.stringMatching(/A|B/),
        });
      });

      it('does not run @Headers() pipes (existing pipe-less behavior)', async () => {
        const headerPipe: PipeTransform = {
          transform: () => {
            throw new BadRequestException('H');
          },
        };
        const pipesFn = contextCreator.createPipesFn(
          [],
          [buildParam(0, RouteParamtypes.HEADERS, 'raw', [headerPipe])],
        )!;

        const args: unknown[] = [undefined];
        await pipesFn(args, {}, {}, () => {});
        expect(args).toEqual(['raw']);
      });
    });

    describe('when "aggregateParamErrors" is enabled', () => {
      it('resolves all parameters when every pipe succeeds', async () => {
        const pipesFn = contextCreator.createPipesFn(
          [],
          [
            buildParam(0, RouteParamtypes.PARAM, '7'),
            buildParam(1, RouteParamtypes.QUERY, '10'),
          ],
          true,
        )!;
        const args: unknown[] = [undefined, undefined];
        await pipesFn(args, {}, {}, () => {});

        expect(args).toEqual(['7', '10']);
      });

      it('throws a single BadRequestException with a one-element message on a single error', async () => {
        const pipesFn = contextCreator.createPipesFn(
          [],
          [
            buildParam(0, RouteParamtypes.PARAM, 'abc', [throwingPipe('A')]),
            buildParam(1, RouteParamtypes.QUERY, '10'),
          ],
          true,
        )!;

        let error: BadRequestException;
        try {
          await pipesFn([undefined, undefined], {}, {}, () => {});
        } catch (e) {
          error = e;
        }
        expect(error!).toBeInstanceOf(BadRequestException);
        expect(error!.getResponse()).toEqual({
          statusCode: HttpStatus.BAD_REQUEST,
          error: 'Bad Request',
          message: ['A'],
        });
      });

      it('collects @Param/@Query errors sorted by parameter index into one exception', async () => {
        // Passed in reverse declaration order on purpose: aggregation must
        // order messages by parameter index, not by metadata key order.
        const pipesFn = contextCreator.createPipesFn(
          [],
          [
            buildParam(1, RouteParamtypes.QUERY, 'x', [throwingPipe('B')]),
            buildParam(0, RouteParamtypes.PARAM, 'abc', [throwingPipe('A')]),
          ],
          true,
        )!;

        let error: BadRequestException;
        try {
          await pipesFn([undefined, undefined], {}, {}, () => {});
        } catch (e) {
          error = e;
        }
        expect(error!).toBeInstanceOf(BadRequestException);
        expect(error!.getResponse()).toEqual({
          statusCode: HttpStatus.BAD_REQUEST,
          error: 'Bad Request',
          message: ['A', 'B'],
        });
      });

      it('runs the aggregated parameter pipes serially', async () => {
        const started: string[] = [];
        let releaseFirst: () => void;
        const slowPipe: PipeTransform = {
          transform: () =>
            new Promise(resolve => {
              started.push('first');
              releaseFirst = () => resolve('7');
            }),
        };
        const secondPipe: PipeTransform = {
          transform: async (value: unknown) => {
            started.push('second');
            return value;
          },
        };

        const pipesFn = contextCreator.createPipesFn(
          [],
          [
            buildParam(0, RouteParamtypes.PARAM, '7', [slowPipe]),
            buildParam(1, RouteParamtypes.QUERY, '10', [secondPipe]),
          ],
          true,
        )!;

        const promise = pipesFn([undefined, undefined], {}, {}, () => {});
        await Promise.resolve();
        expect(started).toEqual(['first']);

        releaseFirst!();
        await promise;
        expect(started).toEqual(['first', 'second']);
      });

      it('lets errors of non-aggregated parameters (e.g. @Body) propagate immediately', async () => {
        const pipesFn = contextCreator.createPipesFn(
          [],
          [
            buildParam(0, RouteParamtypes.PARAM, 'abc', [throwingPipe('A')]),
            buildParam(1, RouteParamtypes.BODY, {}, [throwingPipe('BODY')]),
          ],
          true,
        )!;

        let error: BadRequestException;
        try {
          await pipesFn([undefined, undefined], {}, {}, () => {});
        } catch (e) {
          error = e;
        }
        expect(error!).toBeInstanceOf(BadRequestException);
        expect(error!.getResponse()).toEqual({
          statusCode: HttpStatus.BAD_REQUEST,
          error: 'Bad Request',
          message: 'BODY',
        });
      });

      it('does not aggregate non-BadRequest errors: the original exception propagates immediately', async () => {
        const plainErrorPipe: PipeTransform = {
          transform: () => {
            throw new Error('boom');
          },
        };
        const pipesFn = contextCreator.createPipesFn(
          [],
          [
            buildParam(0, RouteParamtypes.PARAM, 'abc', [plainErrorPipe]),
            buildParam(1, RouteParamtypes.QUERY, 'x', [throwingPipe('B')]),
          ],
          true,
        )!;

        await expect(
          pipesFn([undefined, undefined], {}, {}, () => {}),
        ).rejects.toThrow('boom');
      });

      it('does not aggregate non-BadRequest HttpExceptions either', async () => {
        const notFoundPipe: PipeTransform = {
          transform: () => {
            throw new HttpException('missing', HttpStatus.NOT_FOUND);
          },
        };
        const pipesFn = contextCreator.createPipesFn(
          [],
          [
            buildParam(0, RouteParamtypes.PARAM, 'abc', [notFoundPipe]),
            buildParam(1, RouteParamtypes.QUERY, 'x', [throwingPipe('B')]),
          ],
          true,
        )!;

        await expect(
          pipesFn([undefined, undefined], {}, {}, () => {}),
        ).rejects.toMatchObject({
          status: HttpStatus.NOT_FOUND,
        });
      });

      it('preserves array messages from BadRequestExceptions', async () => {
        const validationPipe: PipeTransform = {
          transform: () => {
            throw new BadRequestException(['one', 'two']);
          },
        };
        const pipesFn = contextCreator.createPipesFn(
          [],
          [
            buildParam(0, RouteParamtypes.PARAM, 'abc', [validationPipe]),
            buildParam(1, RouteParamtypes.QUERY, 'x', [throwingPipe('B')]),
          ],
          true,
        )!;

        let error: BadRequestException;
        try {
          await pipesFn([undefined, undefined], {}, {}, () => {});
        } catch (e) {
          error = e;
        }
        expect((error!.getResponse() as any).message).toEqual([
          'one',
          'two',
          'B',
        ]);
      });

      // The proxy and the pipes function are created once per route and reused
      // by every request; only `args` is allocated per call. The aggregation
      // state must therefore live on the call stack of pipesFn, nowhere else.
      describe('per-call isolation of a reused pipes function', () => {
        const countingValidPipe = (
          tag: string,
          calls: string[],
        ): PipeTransform => ({
          transform: (value: unknown) => {
            calls.push(tag);
            const parsed = Number(value);
            if (Number.isNaN(parsed)) {
              throw new BadRequestException(tag);
            }
            return parsed;
          },
        });

        const buildParamWithValue = (
          index: number,
          type: number,
          readValue: () => unknown,
          paramPipes: PipeTransform[] = [],
        ) => ({
          index,
          type,
          data: undefined,
          pipes: paramPipes,
          extractValue: readValue,
        });

        it('a valid second call re-runs every pipe and is not tainted by a previous double-error', async () => {
          const calls: string[] = [];
          let idValue: unknown = 'abc';
          let limitValue: unknown = 'x';
          const pipesFn = contextCreator.createPipesFn(
            [],
            [
              buildParamWithValue(0, RouteParamtypes.PARAM, () => idValue, [
                countingValidPipe('A', calls),
              ]),
              buildParamWithValue(1, RouteParamtypes.QUERY, () => limitValue, [
                countingValidPipe('B', calls),
              ]),
            ],
            true,
          )!;

          await expect(
            pipesFn([undefined, undefined], {}, {}, () => {}),
          ).rejects.toBeInstanceOf(BadRequestException);
          expect(calls).toEqual(['A', 'B']);

          // Same pipes function, "second request" with valid inputs.
          idValue = '7';
          limitValue = '10';
          const args: unknown[] = [undefined, undefined];
          await pipesFn(args, {}, {}, () => {});
          expect(args).toEqual([7, 10]);
          expect(calls).toEqual(['A', 'B', 'A', 'B']);
        });

        it('a double-error after a successful call reports only the new messages', async () => {
          const calls: string[] = [];
          let idValue: unknown = '7';
          let limitValue: unknown = '10';
          const pipesFn = contextCreator.createPipesFn(
            [],
            [
              buildParamWithValue(0, RouteParamtypes.PARAM, () => idValue, [
                countingValidPipe('A', calls),
              ]),
              buildParamWithValue(1, RouteParamtypes.QUERY, () => limitValue, [
                countingValidPipe('B', calls),
              ]),
            ],
            true,
          )!;

          const okArgs: unknown[] = [undefined, undefined];
          await pipesFn(okArgs, {}, {}, () => {});
          expect(okArgs).toEqual([7, 10]);

          idValue = 'abc';
          limitValue = 'x';
          let error: BadRequestException;
          try {
            await pipesFn([undefined, undefined], {}, {}, () => {});
          } catch (e) {
            error = e;
          }
          expect((error!.getResponse() as any).message).toEqual(['A', 'B']);
          expect(calls).toEqual(['A', 'B', 'A', 'B']);
        });

        it('concurrent calls on the same pipes function do not overwrite each other (one valid, one double-error)', async () => {
          const calls: string[] = [];
          const slowPipe = (tag: string): PipeTransform => ({
            transform: async (value: unknown) => {
              calls.push(tag);
              await new Promise(resolve => setTimeout(resolve, 10));
              const parsed = Number(value);
              if (Number.isNaN(parsed)) {
                throw new BadRequestException(tag);
              }
              return parsed;
            },
          });
          // Extractors read request-scoped values, mirroring the real factory:
          // one pipes function serves both concurrent "requests".
          const pipesFn = contextCreator.createPipesFn(
            [],
            [
              buildParamWithValue(
                0,
                RouteParamtypes.PARAM,
                (req: any) => req.id,
                [slowPipe('A')],
              ),
              buildParamWithValue(
                1,
                RouteParamtypes.QUERY,
                (req: any) => req.limit,
                [slowPipe('B')],
              ),
            ],
            true,
          )!;

          const okArgs: unknown[] = [undefined, undefined];
          const [, failure] = await Promise.allSettled([
            pipesFn(okArgs, { id: '7', limit: '10' }, {}, () => {}),
            pipesFn(
              [undefined, undefined],
              { id: 'abc', limit: 'x' },
              {},
              () => {},
            ),
          ]);

          expect(okArgs).toEqual([7, 10]);
          expect(failure.status).toBe('rejected');
          const error = (failure as PromiseRejectedResult).reason;
          expect(error).toBeInstanceOf(BadRequestException);
          expect((error.getResponse() as any).message).toEqual(['A', 'B']);
          expect(calls.filter(tag => tag === 'A')).toHaveLength(2);
          expect(calls.filter(tag => tag === 'B')).toHaveLength(2);
        });

        it('collected messages of an aborted call do not leak into the next call', async () => {
          const calls: string[] = [];
          let idValue: unknown = 'abc';
          let modeValue: unknown = 'abort';
          let limitValue: unknown = 'x';
          const abortPipe: PipeTransform = {
            transform: (value: unknown) => {
              calls.push('M');
              if (value === 'abort') {
                throw new Error('boom');
              }
              return value;
            },
          };
          const pipesFn = contextCreator.createPipesFn(
            [],
            [
              buildParamWithValue(0, RouteParamtypes.PARAM, () => idValue, [
                countingValidPipe('A', calls),
              ]),
              buildParamWithValue(1, RouteParamtypes.PARAM, () => modeValue, [
                abortPipe,
              ]),
              buildParamWithValue(2, RouteParamtypes.QUERY, () => limitValue, [
                countingValidPipe('B', calls),
              ]),
            ],
            true,
          )!;

          await expect(
            pipesFn([undefined, undefined, undefined], {}, {}, () => {}),
          ).rejects.toThrow('boom');
          expect(calls).toEqual(['A', 'M']);

          idValue = '7';
          modeValue = 'ok';
          limitValue = '10';
          const args: unknown[] = [undefined, undefined, undefined];
          await pipesFn(args, {}, {}, () => {});
          expect(args).toEqual([7, 'ok', 10]);
          // The 'A' collected by the aborted call was discarded; the second
          // call ran all three pipes from scratch and resolved cleanly.
          expect(calls).toEqual(['A', 'M', 'A', 'M', 'B']);
        });
      });

      describe('@Headers() input domain', () => {
        const headerTokenPipe: PipeTransform = {
          transform: (value: unknown) => {
            if (value === 'invalid') {
              throw new BadRequestException('H');
            }
            return `token:${value}`;
          },
        };

        it('runs the header pipe and resolves every transformed value together', async () => {
          const pipesFn = contextCreator.createPipesFn(
            [],
            [
              buildParam(0, RouteParamtypes.PARAM, '7'),
              buildParam(1, RouteParamtypes.QUERY, '10'),
              buildParam(2, RouteParamtypes.HEADERS, 'abc', [headerTokenPipe]),
            ],
            true,
          )!;
          const args: unknown[] = [undefined, undefined, undefined];
          await pipesFn(args, {}, {}, () => {});

          expect(args).toEqual(['7', '10', 'token:abc']);
        });

        it('discards the collected @Param/@Query messages when the header pipe fails', async () => {
          const pipesFn = contextCreator.createPipesFn(
            [],
            [
              buildParam(0, RouteParamtypes.PARAM, 'abc', [throwingPipe('A')]),
              buildParam(1, RouteParamtypes.QUERY, 'x', [throwingPipe('B')]),
              buildParam(2, RouteParamtypes.HEADERS, 'invalid', [
                headerTokenPipe,
              ]),
            ],
            true,
          )!;

          let error: BadRequestException;
          try {
            await pipesFn([undefined, undefined, undefined], {}, {}, () => {});
          } catch (e) {
            error = e;
          }
          // The exception is the header one, unchanged: the collected 'A'/'B'
          // messages never reach the response.
          expect(error!).toBeInstanceOf(BadRequestException);
          expect(error!.getResponse()).toEqual({
            statusCode: HttpStatus.BAD_REQUEST,
            error: 'Bad Request',
            message: 'H',
          });
        });

        it('ends the resolution immediately when the header pipe fails first', async () => {
          const calls: string[] = [];
          const trackingPipe = (tag: string): PipeTransform => ({
            transform: (value: unknown) => {
              calls.push(tag);
              return value;
            },
          });
          const pipesFn = contextCreator.createPipesFn(
            [],
            [
              buildParam(0, RouteParamtypes.HEADERS, 'invalid', [
                headerTokenPipe,
              ]),
              buildParam(1, RouteParamtypes.PARAM, 'abc', [trackingPipe('A')]),
              buildParam(2, RouteParamtypes.QUERY, 'x', [trackingPipe('B')]),
            ],
            true,
          )!;

          await expect(
            pipesFn([undefined, undefined, undefined], {}, {}, () => {}),
          ).rejects.toBeInstanceOf(BadRequestException);
          // The header parameter aborted the resolution: the @Param()/@Query()
          // pipes never ran for this call.
          expect(calls).toEqual([]);
        });

        it('aggregates only the @Param/@Query messages when the header pipe succeeds', async () => {
          const pipesFn = contextCreator.createPipesFn(
            [],
            [
              buildParam(0, RouteParamtypes.PARAM, 'abc', [throwingPipe('A')]),
              buildParam(1, RouteParamtypes.QUERY, 'x', [throwingPipe('B')]),
              buildParam(2, RouteParamtypes.HEADERS, 'abc', [headerTokenPipe]),
            ],
            true,
          )!;

          let error: BadRequestException;
          try {
            await pipesFn([undefined, undefined, undefined], {}, {}, () => {});
          } catch (e) {
            error = e;
          }
          expect(error!).toBeInstanceOf(BadRequestException);
          expect((error!.getResponse() as any).message).toEqual(['A', 'B']);
        });
      });
    });
  });
  describe('reflectAggregateParamErrors', () => {
    it('returns false when metadata is not present', () => {
      const callback = () => {};
      expect(contextCreator.reflectAggregateParamErrors(callback)).toBe(false);
    });

    it('returns true when the method is annotated', () => {
      class TestController {
        @AggregateParamErrors()
        public callback() {}
      }
      expect(
        contextCreator.reflectAggregateParamErrors(
          TestController.prototype.callback,
        ),
      ).toBe(true);
    });
  });

  describe('createGuardsFn', () => {
    it('should throw ForbiddenException when "tryActivate" returns false', async () => {
      const guardsFn = contextCreator.createGuardsFn([null!], null!, null!)!;
      vi.spyOn(guardsConsumer, 'tryActivate').mockImplementation(
        async () => false,
      );

      let error: ForbiddenException;
      try {
        await guardsFn([]);
      } catch (e) {
        error = e;
      }

      expect(error!).toBeInstanceOf(ForbiddenException);
      expect(error!.message).toEqual('Forbidden resource');
      expect(error!.getResponse()).toEqual({
        statusCode: HttpStatus.FORBIDDEN,
        message: FORBIDDEN_MESSAGE,
        error: 'Forbidden',
      });
    });
  });
  describe('createHandleResponseFn', () => {
    describe('when "renderTemplate" is defined', () => {
      beforeEach(() => {
        vi.spyOn(adapter, 'render').mockImplementation(
          (response, view: string, options: any) => {
            return response.render(view, options);
          },
        );
      });
      it('should call "res.render()" with expected args', async () => {
        const template = 'template';
        const value = 'test';
        const response = { render: vi.fn() };

        vi.spyOn(contextCreator, 'reflectRenderTemplate').mockReturnValue(
          template,
        );

        const handler = contextCreator.createHandleResponseFn(
          null!,
          true,
          undefined,
          200,
        ) as HandlerResponseBasicFn;
        await handler(value, response);

        expect(response.render).toHaveBeenCalledWith(template, value);
      });
    });
    describe('when "renderTemplate" is undefined', () => {
      it('should not call "res.render()"', async () => {
        const result = Promise.resolve('test');
        const response = { render: vi.fn() };

        vi.spyOn(contextCreator, 'reflectResponseHeaders').mockReturnValue([]);
        vi.spyOn(contextCreator, 'reflectRenderTemplate').mockReturnValue(
          undefined!,
        );
        vi.spyOn(contextCreator, 'reflectSse').mockReturnValue(undefined!);

        const handler = contextCreator.createHandleResponseFn(
          null!,
          true,
          undefined,
          200,
        ) as HandlerResponseBasicFn;
        await handler(result, response);

        expect(response.render).not.toHaveBeenCalled();
      });
    });
    describe('when "redirectResponse" is present', () => {
      beforeEach(() => {
        vi.spyOn(adapter, 'redirect').mockImplementation(
          (response, statusCode: number, url: string) => {
            return response.redirect(statusCode, url);
          },
        );
      });
      it('should call "res.redirect()" with expected args', async () => {
        const redirectResponse = {
          url: 'http://test.com',
          statusCode: 302,
        };
        const response = { redirect: vi.fn() };

        const handler = contextCreator.createHandleResponseFn(
          () => {},
          true,
          redirectResponse,
          200,
        ) as HandlerResponseBasicFn;
        await handler(redirectResponse, response);

        expect(response.redirect).toHaveBeenCalledWith(
          redirectResponse.statusCode,
          redirectResponse.url,
        );
      });
    });

    describe('when "redirectResponse" is undefined', () => {
      it('should not call "res.redirect()"', async () => {
        const result = Promise.resolve('test');
        const response = { redirect: vi.fn() };

        vi.spyOn(contextCreator, 'reflectResponseHeaders').mockReturnValue([]);
        vi.spyOn(contextCreator, 'reflectRenderTemplate').mockReturnValue(
          undefined!,
        );
        vi.spyOn(contextCreator, 'reflectSse').mockReturnValue(undefined!);

        const handler = contextCreator.createHandleResponseFn(
          null!,
          true,
          undefined,
          200,
        ) as HandlerResponseBasicFn;
        await handler(result, response);

        expect(response.redirect).not.toHaveBeenCalled();
      });
    });

    describe('when replying with result', () => {
      it('should call "adapter.reply()" with expected args', async () => {
        const result = Promise.resolve('test');
        const response = {};

        vi.spyOn(contextCreator, 'reflectRenderTemplate').mockReturnValue(
          undefined!,
        );
        vi.spyOn(contextCreator, 'reflectSse').mockReturnValue(undefined!);

        const handler = contextCreator.createHandleResponseFn(
          null!,
          false,
          undefined,
          1234,
        ) as HandlerResponseBasicFn;
        const adapterReplySpy = vi.spyOn(adapter, 'reply');
        await handler(result, response);
        expect(adapterReplySpy).toHaveBeenCalledWith(response, 'test', 1234);
      });
    });

    describe('when "isSse" is enabled', () => {
      it('should delegate result to SseStream', async () => {
        const result = of('test');
        const response = new PassThrough();
        response.write = vi.fn();

        const request = attachSocket(new PassThrough());
        request.socket.once = vi.fn(
          request.socket.once.bind(request.socket),
        ) as any;

        vi.spyOn(contextCreator, 'reflectRenderTemplate').mockReturnValue(
          undefined!,
        );
        vi.spyOn(contextCreator, 'reflectSse').mockReturnValue('/');

        const handler = contextCreator.createHandleResponseFn(
          null!,
          true,
          undefined,
          200,
        ) as HandlerResponseBasicFn;
        await handler(result, response, request);

        expect(response.write).toHaveBeenCalled();
        expect(request.socket.once).toHaveBeenCalledWith(
          'close',
          expect.any(Function),
        );
      });

      it('should not allow a non-observable result', async () => {
        const result = Promise.resolve('test');
        const response = new PassThrough();
        const request = new PassThrough();

        vi.spyOn(contextCreator, 'reflectRenderTemplate').mockReturnValue(
          undefined!,
        );
        vi.spyOn(contextCreator, 'reflectSse').mockReturnValue('/');

        const handler = contextCreator.createHandleResponseFn(
          null!,
          true,
          undefined,
          200,
        ) as HandlerResponseBasicFn;

        try {
          await handler(result, response, request);
        } catch (e) {
          expect(e.message).toBe(
            'You must return an Observable stream to use Server-Sent Events (SSE).',
          );
        }
      });

      it('should apply any headers that exists on the response', async () => {
        const result = of('test');
        const response = new PassThrough() as HeaderStream;
        response.write = vi.fn();
        response.writeHead = vi.fn();
        response.flushHeaders = vi.fn();
        response.getHeaders = vi
          .fn()
          .mockReturnValue({ 'access-control-headers': 'some-cors-value' });

        const request = attachSocket(new PassThrough());

        vi.spyOn(contextCreator, 'reflectRenderTemplate').mockReturnValue(
          undefined!,
        );
        vi.spyOn(contextCreator, 'reflectSse').mockReturnValue('/');

        const handler = contextCreator.createHandleResponseFn(
          null!,
          true,
          undefined,
          200,
        ) as HandlerResponseBasicFn;
        await handler(result, response, request);

        expect(response.writeHead).toHaveBeenCalledWith(
          200,
          expect.objectContaining({
            'access-control-headers': 'some-cors-value',
          }),
        );
      });

      it('should pass through status and headers from the wrapper response at handle time', async () => {
        const rawResponse = new PassThrough() as HeaderStream;
        rawResponse.write = vi.fn() as any;
        rawResponse.writeHead = vi.fn() as any;
        rawResponse.flushHeaders = vi.fn() as any;

        const response = {
          raw: rawResponse,
          statusCode: 203,
          getHeaders: vi
            .fn()
            .mockReturnValue({ 'access-control-headers': 'at-handle-time' }),
        };
        const result = of('test');

        const request = attachSocket(new PassThrough());

        vi.spyOn(contextCreator, 'reflectRenderTemplate').mockReturnValue(
          undefined!,
        );
        vi.spyOn(contextCreator, 'reflectSse').mockReturnValue('/');

        const handler = contextCreator.createHandleResponseFn(
          null!,
          true,
          undefined,
          200,
        ) as HandlerResponseBasicFn;
        await handler(result, response as any, request);

        expect(rawResponse.writeHead).toHaveBeenCalledWith(
          203,
          expect.objectContaining({
            'access-control-headers': 'at-handle-time',
          }),
        );
      });
    });
  });
});
