const path = require('node:path');
module.exports = {
  adapterPath:
    process.env.NEXT_ADAPTER_PATH || path.join(__dirname, 'parity-adapter.cjs'),
  cacheComponents: process.env.NATIVE_PARITY_PPR === '1',
  turbopack: { root: path.resolve(__dirname, '../../../../..') },
  async rewrites() {
    return [{ source: '/rewritten', destination: '/dynamic' }];
  },
  async redirects() {
    return [{ source: '/old', destination: '/', permanent: false }];
  },
  async headers() {
    return [
      { source: '/:path*', headers: [{ key: 'x-parity', value: 'yes' }] },
    ];
  },
};
