import { makeRe } from 'picomatch';
import type { NextConfig } from 'next';

export function getImagesConfig(config: NextConfig) {
  const images = config.images || {};

  const remotePatterns = (images.remotePatterns || []).map((p) => ({
    protocol: p.protocol?.replace(/:$/, '') as 'http' | 'https' | undefined,
    hostname: makeRe(p.hostname).source,
    port: p.port,
    pathname: makeRe(p.pathname ?? '**', { dot: true }).source,
    search: p.search,
  }));

  const localPatterns = images.localPatterns?.map((p) => ({
    pathname: makeRe(p.pathname ?? '**', { dot: true }).source,
    search: p.search,
  }));

  return {
    localPatterns,
    remotePatterns,
    sizes: [...(images.imageSizes || []), ...(images.deviceSizes || [])],
    domains: images.domains || [],
    qualities: images.qualities,
    minimumCacheTTL: images.minimumCacheTTL,
    formats: images.formats,
    dangerouslyAllowSVG: images.dangerouslyAllowSVG,
    contentSecurityPolicy: images.contentSecurityPolicy,
    contentDispositionType: images.contentDispositionType,
  };
}

const matchOperatorsRegex = /[|\\{}()[\]^$+*?.-]/g;

export function escapeStringRegexp(str: string): string {
  return str.replace(matchOperatorsRegex, '\\$&');
}
