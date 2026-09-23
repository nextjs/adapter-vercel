import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Next.js also emits an RSC variant for each route handler in this version.
const count = Number(process.env.BENCHMARK_FUNCTIONS ?? 1196);
if (!Number.isSafeInteger(count) || count < 0) {
  throw new Error('BENCHMARK_FUNCTIONS must be a non-negative integer');
}

const generatedDir = fileURLToPath(
  new URL('../app/api/generated/', import.meta.url)
);
await fs.rm(generatedDir, { recursive: true, force: true });

for (let index = 0; index < count; index++) {
  const routeDir = path.join(
    generatedDir,
    `route-${String(index).padStart(5, '0')}`
  );
  await fs.mkdir(routeDir, { recursive: true });
  await fs.writeFile(
    path.join(routeDir, 'route.js'),
    `export function GET(request) { return Response.json({ route: ${index}, url: request.url }); }\n`
  );
}

console.log(`Generated ${count} node route handlers`);
