import minimatch from 'minimatch';
import { expect, it } from 'vitest';
import { matchFunctionPatterns } from '../test/native-operations';

it('matches minimatch across globstars, negation, braces, dot segments and UTF-16 characters', () => {
  const patterns = [
    '*',
    '**',
    '?',
    '??',
    '!**',
    '!*',
    '**/*.ts',
    '**/route.ts',
    'app/**',
    '!app/**',
    '!!app/**',
    'app/**/route.ts',
    'app/*/route.ts',
    'app/?/route.ts',
    'app/??/route.ts',
    'app/**/.hidden/**',
    'app/{api,.hidden}/**',
    'app/{😀,api}/**',
    'app/!(other)/**',
    'app/@(api|😀)/**',
    'app/+(api|😀)/**',
    'app/😀*/route.ts',
    'app/😀?/route.ts',
    'app/[😀]/route.ts',
    'app/[!😀]/route.ts',
    'app/.hidden/**',
    '**/.hidden/route.ts',
    'app/**/**/route.ts',
    'app/+(api|other)/**',
    'app/a[bc]/**',
    'app/api/route.ts',
  ];
  const names = [
    'api',
    'other',
    'a',
    'ab',
    '.hidden',
    '.',
    '..',
    '😀',
    '😀a',
    'é',
    '行',
    'a\nb',
    '',
  ];
  const sources = ['', 'app', 'app/', 'app//', 'app/api/route.ts/'];
  for (const first of names) {
    sources.push(first, `app/${first}`, `app/${first}/route.ts`);
    for (const second of names) sources.push(`app/${first}/${second}/route.ts`);
  }
  const actual = matchFunctionPatterns(patterns, sources);
  const expected = patterns.flatMap((pattern) =>
    sources.map((source) => source === pattern || minimatch(source, pattern))
  );
  expect(actual).toEqual(expected);
});
