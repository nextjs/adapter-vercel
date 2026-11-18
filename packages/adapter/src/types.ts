import type { HasField, Route } from '@vercel/routing-utils';
import type { AdapterOutput } from 'next';

export type PrerenderOutput = Omit<AdapterOutput['PRERENDER'], 'config'> & {
  config: Omit<AdapterOutput['PRERENDER']['config'], 'bypassFor'> & {
    bypassFor?: Array<
      | NonNullable<AdapterOutput['PRERENDER']['config']['bypassFor']>[number]
      | { type: 'method'; value: string }
    >;
  };
};

type ImageFormat = 'image/avif' | 'image/webp';

type RemotePattern = {
  protocol?: 'http' | 'https';
  hostname: string;
  port?: string;
  pathname?: string;
  search?: string;
};

type LocalPattern = {
  pathname?: string;
  search?: string;
};

export type ImagesConfig = {
  sizes: number[];
  domains: string[];
  remotePatterns?: RemotePattern[];
  localPatterns?: LocalPattern[];
  qualities?: number[];
  minimumCacheTTL?: number; // seconds
  formats?: ImageFormat[];
  dangerouslyAllowSVG?: boolean;
  contentSecurityPolicy?: string;
  contentDispositionType?: string;
};

type WildCard = {
  domain: string;
  value: string;
};

export type WildcardConfig = Array<WildCard>;

export type OverridesConfig = Record<
  string,
  { path?: string; contentType?: string }
>;

export type VercelConfig = {
  version: 3;
  afterCacheBypass?: Array<{
    name?: string;
    hasAll: Array<{
      type: 'request.header' | 'cache.response.header';
      key: string;
      value?: HasField[number]['value'];
    }>;
  }>;
  routes?: Route[];
  images?: ImagesConfig;
  wildcard?: WildcardConfig;
  overrides: OverridesConfig;
  cache?: string[];
};
