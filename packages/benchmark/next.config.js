/** @type {import('next').NextConfig} */
const config = {
  cacheComponents: true,
  adapterPath: require.resolve('@next-community/adapter-vercel'),
  outputFileTracingIncludes: {
    '/**': ['./traced/**/*'],
  },
  experimental: {
    staticGenerationMaxConcurrency: Math.max(
      navigator.hardwareConcurrency - 1,
      1
    ),
    turbopackFileSystemCacheForBuild: false,
  },
};

module.exports = config;
