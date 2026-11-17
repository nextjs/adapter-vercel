const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const { dirname, join } = require('node:path');
const { compileFunction } = require('node:vm');

// Load the maintained TypeScript implementation directly, bypassing the opt-in
// selector. Evaluate it afresh so module-level state cannot leak between cases.
const filename = join(__dirname, '../dist/typescript.js');
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
