const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const packageDir =
  process.env.NEXT_ADAPTER_VERIFICATION_PACKAGE_DIR ||
  path.resolve(__dirname, '../../..');
const { loadReferenceAdapter } = require(
  path.join(packageDir, 'test/reference-adapter.cjs')
);
const go = require(path.join(packageDir, 'dist/index.js'));

async function tree(root) {
  const result = {};
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      const name = path.relative(root, file);
      if (entry.isSymbolicLink())
        result[name] = { symlink: await fs.readlink(file) };
      else if (entry.isDirectory()) await walk(file);
      else {
        const content = await fs.readFile(file);
        result[name] = name.endsWith('.json')
          ? JSON.parse(content.toString('utf8'))
          : content;
      }
    }
  }
  await walk(root);
  return result;
}

module.exports = {
  name: 'JavaScript/Go differential adapter',
  modifyConfig: go.modifyConfig,
  async onBuildComplete(ctx) {
    const snapshot = JSON.parse(JSON.stringify(ctx));
    await loadReferenceAdapter().onBuildComplete(ctx);
    const output = path.join(ctx.distDir, 'output');
    const expected = await tree(output);
    await fs.rm(output, { recursive: true });
    await go.onBuildComplete(snapshot);
    const actual = await tree(output);
    assert.deepEqual(actual, expected);
    await fs.writeFile(
      path.join(ctx.distDir, 'native-parity.json'),
      JSON.stringify({
        passed: true,
        files: Object.keys(actual).length,
        nextVersion: ctx.nextVersion,
        functions: Object.keys(actual).filter((name) =>
          name.endsWith('/.vc-config.json')
        ).length,
      })
    );
    console.log(
      `Native adapter parity passed: ${Object.keys(actual).length} entries`
    );
  },
};
