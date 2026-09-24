import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Next.js emits a function and an RSC variant for each page/route handler.
const pages = Number(process.env.BENCHMARK_PAGES ?? 1149);
const routes = Number(process.env.BENCHMARK_ROUTES ?? 37);
// Extra files traced into every function; the reference workload traces ~400.
const tracedFiles = Number(process.env.BENCHMARK_TRACED_FILES ?? 280);
for (const [name, count] of Object.entries({
  BENCHMARK_PAGES: pages,
  BENCHMARK_ROUTES: routes,
  BENCHMARK_TRACED_FILES: tracedFiles,
})) {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
}

const generatedDir = fileURLToPath(
  new URL('../app/[variant]/items/generated/', import.meta.url)
);
const tracedDir = fileURLToPath(new URL('../traced/', import.meta.url));
await fs.rm(generatedDir, { recursive: true, force: true });
await fs.rm(tracedDir, { recursive: true, force: true });

// Page depth below `items/` follows the reference app: ~10% one level, ~46%
// two, ~36% three and ~8% four levels deep.
function pageSegments(index) {
  const name = `page-${String(index).padStart(5, '0')}`;
  const bucketName = `bucket-${String(index % 30).padStart(2, '0')}`;
  const section = `section-${String(Math.floor(index / 30) % 12).padStart(2, '0')}`;
  const group = `group-${String(Math.floor(index / 360) % 4).padStart(2, '0')}`;
  const bucket = index % 100;
  if (bucket < 10) return [name];
  if (bucket < 56) return [bucketName, name];
  if (bucket < 92) return [bucketName, section, name];
  return [bucketName, section, group, name];
}

for (let index = 0; index < pages; index++) {
  const segments = pageSegments(index);
  const pageDir = path.join(generatedDir, ...segments);
  const contentImport = `${'../'.repeat(segments.length + 1)}content`;
  await fs.mkdir(pageDir, { recursive: true });
  await fs.writeFile(
    path.join(pageDir, 'page.jsx'),
    `import ItemPage from '${contentImport}';\nexport default function Page({ params }) { return <ItemPage params={params} title="${segments.at(-1)}" />; }\n`
  );
}

for (let index = 0; index < routes; index++) {
  const routeDir = path.join(
    generatedDir,
    `api-${String(index).padStart(5, '0')}`
  );
  await fs.mkdir(routeDir, { recursive: true });
  await fs.writeFile(
    path.join(routeDir, 'route.js'),
    `export function GET(request) { return Response.json({ route: ${index}, url: request.url }); }\n`
  );
}

for (let index = 0; index < tracedFiles; index++) {
  const dir = path.join(
    tracedDir,
    `pkg-${String(index % 20).padStart(2, '0')}`
  );
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `module-${String(index).padStart(4, '0')}.js`),
    `module.exports = ${JSON.stringify('x'.repeat(2000 + (index % 7) * 500))};\n`
  );
}

console.log(
  `Generated ${pages} pages, ${routes} route handlers and ${tracedFiles} traced files`
);
