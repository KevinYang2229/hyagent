/** Build documentation from the registered Express routes and their actual validation schemas. */
import type { Express, RequestHandler } from 'express';
import { z } from 'zod';
import { extendZodWithOpenApi, OpenAPIRegistry, OpenApiGeneratorV3, type RouteConfig } from '@asteasolutions/zod-to-openapi';
import { validationSchemas } from '@/middlewares/validate';
import { openapiSpec } from './openapi';
import { applyOperationDetails, pathParamDescription } from './operation-details';
import { operationSummaries } from './operation-summaries';

extendZodWithOpenApi(z);

type Layer = {
  route?: { path: string | string[]; methods: Record<string, boolean>; stack: Layer[] };
  handle: RequestHandler & { stack?: Layer[] };
  regexp: RegExp & { fast_slash?: boolean };
  keys: Array<{ name: string }>;
};

/** Express 4 uses path-to-regexp for mounts. Only literal mounts and named parameters are supported. */
function mountPath(layer: Layer): string {
  if (layer.regexp.fast_slash) return '';
  let index = 0;
  const path = layer.regexp.source
    .replace(/^\^/, '')
    .replace(/\\\/\?\(\?=\\\/\|\$\)$/, '')
    .replaceAll('(?:\\/([^/]+?))', () => `/:${layer.keys[index++].name}`)
    .replace(/\\\//g, '/');
  if (index !== layer.keys.length || /[()^$?]/.test(path)) {
    throw new Error(`Unsupported OpenAPI router mount: ${layer.regexp.source}`);
  }
  return path;
}

export function registeredRoutes(app: Express) {
  const routes: Array<{ path: string; method: RouteConfig['method']; stack: Layer[] }> = [];
  function visit(stack: Layer[], prefix: string) {
    for (const layer of stack) {
      if (layer.route) {
        for (const suffix of [layer.route.path].flat()) {
          const path = `${prefix}${suffix === '/' && prefix ? '' : suffix}`.replace(/:([\w]+)/g, '{$1}');
          for (const [method, enabled] of Object.entries(layer.route.methods)) {
            if (enabled && method !== '_all') routes.push({ path, method: method as RouteConfig['method'], stack: layer.route.stack });
          }
        }
      } else if (layer.handle.stack) {
        visit(layer.handle.stack, prefix + mountPath(layer));
      }
    }
  }
  visit(app._router.stack as Layer[], '');
  return routes.filter(({ path }) => path !== '/api/openapi.json');
}

function securityFor(path: string): RouteConfig['security'] {
  if (path === '/api/admin/auth/login' || path === '/api/auth/refresh' || path === '/api/auth/sso/exchange' || path.startsWith('/.well-known/') || /\/(healthz|readyz)$/.test(path)) return [];
  if (path.startsWith('/api/admin')) return [{ adminKey: [] }, { adminBearerAuth: [] }];
  if (path.startsWith('/api/directory-sync')) return [{ directorySyncAuth: [] }];
  if (path.startsWith('/api/tenant')) return [{ apiKeyAuth: [] }];
  if (path.startsWith('/api/widget')) return [{ widgetKey: [] }];
  if (['/api/auth/login', '/api/auth/guest'].includes(path)) return [{ apiKeyAuth: [] }];
  if (['/api/auth/me', '/api/auth/logout'].includes(path)) return [{ bearerAuth: [] }];
  return [{ apiKeyAuth: [], bearerAuth: [] }];
}

/**
 * 不送 body 時 Express 4 的 req.body 是 {}，所以「{} 能通過驗證」就代表 body 可省略。
 * 只看 isOptional() 會把欄位全選填的 body（如 POST /api/conversations）誤標為必填；
 * 反過來「至少要帶一個欄位」的 PATCH 送 {} 會失敗，仍正確標為必填。
 */
function bodyRequired(schema: z.ZodTypeAny): boolean {
  return !schema.safeParse({}).success;
}

export function buildOpenApiSpec(app: Express) {
  const registry = new OpenAPIRegistry();
  for (const { path, method, stack } of registeredRoutes(app)) {
    const schemas = Object.assign({}, ...stack.map(({ handle }) => validationSchemas.get(handle))) as {
      body?: z.ZodTypeAny; params?: z.AnyZodObject; query?: z.AnyZodObject;
    };
    const params = Object.fromEntries([...path.matchAll(/\{(\w+)\}/g)].map(([, name]) => {
      const description = pathParamDescription(path, name);
      return [name, description ? z.string().describe(description) : z.string()];
    }));
    const curated = (openapiSpec.paths as Record<string, Partial<Record<RouteConfig['method'], object>>>)[path]?.[method] ?? {};
    const operation: RouteConfig = {
      // /healthz、/api/healthz、/readyz、/api/readyz 是同一組健康檢查（雙路徑見 app.ts），統一歸 health
      tags: [path.startsWith('/api/admin') ? 'admin'
        : /\/(healthz|readyz)$/.test(path) ? 'health'
        : path.split('/')[2] || 'health'],
      ...(operationSummaries[`${method.toUpperCase()} ${path}`] ?? { summary: `${method.toUpperCase()} ${path}` }),
      ...curated,
      method, path,
      security: securityFor(path),
      request: {
        params: Object.keys(params).length ? z.object({ ...params, ...schemas.params?.shape }) : undefined,
        query: schemas.query,
        body: schemas.body ? { required: bodyRequired(schemas.body), content: { 'application/json': { schema: schemas.body } } } : undefined,
      },
      responses: { ...('responses' in curated ? curated.responses as RouteConfig['responses'] : { '200': { description: '成功；回應內容依端點而定' } }), default: { description: '錯誤回應', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } } },
    };
    // Input schemas and path parameters come from the live validators, replacing stale curated fields.
    delete (operation as RouteConfig & { requestBody?: unknown }).requestBody;
    delete operation.parameters;
    applyOperationDetails(operation);
    registry.registerPath(operation);
  }
  const generated = new OpenApiGeneratorV3(registry.definitions).generateDocument({ openapi: openapiSpec.openapi, info: openapiSpec.info });
  return {
    ...openapiSpec,
    components: {
      ...openapiSpec.components,
      securitySchemes: {
        ...openapiSpec.components.securitySchemes,
        adminBearerAuth: { type: 'http' as const, scheme: 'bearer', bearerFormat: 'JWT', description: '後台登入回傳的 token；租戶管理者受分頁權限限制，帳號管理僅限超級管理者。' },
        directorySyncAuth: { type: 'http' as const, scheme: 'bearer', bearerFormat: 'JWT', description: '同步專用金鑰簽發的 assertion，aud=hyagent:directory-sync；body_sha256 綁定原始 body。' },
        widgetKey: { type: 'apiKey' as const, in: 'query' as const, name: 'key', description: '租戶公開金鑰 pk_' },
      },
      schemas: { ...openapiSpec.components.schemas, ...generated.components?.schemas },
    },
    paths: generated.paths,
  };
}
