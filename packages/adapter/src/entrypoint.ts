import type { NextAdapter } from 'next';

function selectedAdapter(): NextAdapter {
  return process.env.NEXT_USE_GO_BUILDER === '1'
    ? require('./go/index.js')
    : require('./typescript.js');
}

const adapter: NextAdapter = {
  name: 'Vercel',
  modifyConfig(config, ctx) {
    return selectedAdapter().modifyConfig!(config, ctx);
  },
  onBuildComplete(ctx) {
    return selectedAdapter().onBuildComplete!(ctx);
  },
};

// @ts-ignore the package exposes the CommonJS adapter interface.
export = adapter;
