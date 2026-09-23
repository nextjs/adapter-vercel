/** @type {import('next').NextConfig} */
const config = {
  cacheComponents: true,
  adapterPath: require.resolve('@next-community/adapter-vercel'),
};

module.exports = config;
