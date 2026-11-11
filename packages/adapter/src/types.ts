import type { Route } from '@vercel/routing-utils';

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
  routes?: Route[];
  images?: ImagesConfig;
  wildcard?: WildcardConfig;
  overrides: OverridesConfig;
  cache?: string[];
};
