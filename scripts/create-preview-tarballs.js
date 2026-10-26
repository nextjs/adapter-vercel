// @ts-check
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const adapterPackageDir = path.join(__dirname, '..', 'packages', 'adapter');
const adapterManifestPath = path.join(adapterPackageDir, 'package.json');

/**
 * Packs @next-community/adapter-vercel as a preview tarball for the given
 * commit into `<tarballDirectory>/@next-community/adapter-vercel/`, which is
 * the layout scripts/upload-preview-tarballs.js walks.
 *
 * The manifest version is rewritten to `<base>-preview-<shortSha>-<yyyymmdd>`
 * (changesets owns the real version). The rewrite is a CI-only mutation and
 * must never be committed. Unlike next.js's equivalent script, no dependency
 * rewriting is needed: the published manifest has no internal workspace deps.
 */
function main() {
  const [commitSha, tarballDirectory] = process.argv.slice(2);
  if (!commitSha || !tarballDirectory) {
    throw new Error(
      'Usage: node scripts/create-preview-tarballs.js <commitSha> <tarballDirectory>'
    );
  }

  const shortSha = execFileSync('git', ['rev-parse', '--short', commitSha], {
    encoding: 'utf8',
  }).trim();
  const commitDate = execFileSync(
    'git',
    ['show', '-s', '--format=%cd', '--date=format:%Y%m%d', commitSha],
    { encoding: 'utf8' }
  ).trim();

  const manifest = JSON.parse(fs.readFileSync(adapterManifestPath, 'utf8'));
  const baseVersion = manifest.version.split('-')[0];
  manifest.version = `${baseVersion}-preview-${shortSha}-${commitDate}`;
  fs.writeFileSync(
    adapterManifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  console.info(`Packing ${manifest.name}@${manifest.version}`);

  const destination = path.join(
    tarballDirectory,
    '@next-community',
    'adapter-vercel'
  );
  fs.mkdirSync(destination, { recursive: true });
  execFileSync(
    'npm',
    ['pack', adapterPackageDir, '--pack-destination', destination],
    { stdio: 'inherit' }
  );
}

main();
