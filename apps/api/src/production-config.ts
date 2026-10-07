export function productionOrigin(
  environment: NodeJS.ProcessEnv,
  secureCookie: boolean,
): string | undefined {
  if (environment.NODE_ENV !== 'production') return undefined;
  const value = environment.PUBLIC_ORIGIN;
  if (!value) throw new Error('PUBLIC_ORIGIN is required in production');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('PUBLIC_ORIGIN must be an absolute HTTP(S) origin');
  }
  if (!url.hostname || url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      value !== url.origin) {
    throw new Error('PUBLIC_ORIGIN must be an exact origin without credentials, path, query, or fragment');
  }
  if (url.protocol === 'https:') {
    if (!secureCookie) throw new Error('COOKIE_SECURE must be true for private HTTPS');
  } else if (url.protocol === 'http:' &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1') &&
      environment.ALLOW_INSECURE_HTTP === 'true' &&
      (environment.WEB_BIND_ADDRESS === '127.0.0.1' || environment.WEB_BIND_ADDRESS === '::1')) {
    if (secureCookie) throw new Error('COOKIE_SECURE must be false for isolated localhost HTTP');
  } else {
    throw new Error('Production requires HTTPS, except explicitly enabled loopback-bound localhost HTTP');
  }
  return url.origin;
}
