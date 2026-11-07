const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const { dirname } = require('node:path');
const { compileFunction } = require('node:vm');

// Frozen test oracle, resolved separately from the shipped adapter entrypoint.
const filename = require.resolve('@next-community/adapter-vercel-reference');
const relativeRequire = createRequire(filename);
const load = compileFunction(readFileSync(filename, 'utf8'), [
  'require',
  'module',
  'exports',
  '__dirname',
  '__filename',
]);
exports.loadReferenceAdapter = () => {
  const reference = { exports: {} };
  load(
    (name) => (name.startsWith('.') ? relativeRequire(name) : require(name)),
    reference,
    reference.exports,
    dirname(filename),
    filename
  );
  return reference.exports;
};
