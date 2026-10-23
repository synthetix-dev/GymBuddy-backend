import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';

export async function validateOpenApiSpec(): Promise<{
  version: string;
  pathCount: number;
  operationCount: number;
  schemaCount: number;
}> {
  const specPath = path.resolve(process.cwd(), 'openapi/openapi.yaml');
  const raw = await fs.readFile(specPath, 'utf8');
  const doc = YAML.parse(raw) as {
    openapi: string;
    info: { title: string; version: string };
    paths: Record<string, Record<string, { operationId?: string }>>;
    components: { schemas: Record<string, unknown> };
  };

  if (doc.openapi !== '3.1.0') {
    throw new Error(`Expected OpenAPI 3.1.0, got ${doc.openapi}`);
  }

  const paths = Object.keys(doc.paths ?? {});
  const operationIds = new Set<string>();
  let operationCount = 0;

  for (const [p, methods] of Object.entries(doc.paths)) {
    for (const [m, op] of Object.entries(methods)) {
      if (['get', 'post', 'put', 'patch', 'delete'].includes(m)) {
        operationCount++;
        if (!op.operationId) {
          throw new Error(`Missing operationId on ${m.toUpperCase()} ${p}`);
        }
        if (operationIds.has(op.operationId)) {
          throw new Error(`Duplicate operationId: ${op.operationId}`);
        }
        operationIds.add(op.operationId);
      }
    }
  }

  const schemaCount = Object.keys(doc.components?.schemas ?? {}).length;

  // Keep docs/backend-blueprint/openapi.yaml in sync
  const blueprintSpecPath = path.resolve(process.cwd(), 'docs/backend-blueprint/openapi.yaml');
  await fs.writeFile(blueprintSpecPath, raw, 'utf8');

  return {
    version: doc.openapi,
    pathCount: paths.length,
    operationCount,
    schemaCount,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  validateOpenApiSpec()
    .then((res) => {
      console.log('OpenAPI 3.1 validation passed:', JSON.stringify(res));
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
