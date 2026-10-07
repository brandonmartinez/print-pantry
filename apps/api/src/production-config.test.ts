import { describe, expect, it } from 'vitest';
import { productionOrigin } from './production-config.js';

describe('production HTTP configuration', () => {
  it('requires an exact HTTPS origin and secure cookies', () => {
    expect(productionOrigin({ NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://pantry.example.test' }, true))
      .toBe('https://pantry.example.test');
    expect(() => productionOrigin({ NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://pantry.example.test' }, false))
      .toThrow('COOKIE_SECURE');
    expect(() => productionOrigin({ NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://pantry.example.test/path' }, true))
      .toThrow('exact origin');
    expect(() => productionOrigin({ NODE_ENV: 'production' }, true)).toThrow('PUBLIC_ORIGIN');
    expect(() => productionOrigin({ NODE_ENV: 'production', PUBLIC_ORIGIN: 'http://nas.example.test' }, false))
      .toThrow('HTTPS');
  });

  it('only allows deliberately enabled localhost HTTP', () => {
    const env = { NODE_ENV: 'production', PUBLIC_ORIGIN: 'http://127.0.0.1:8080',
      ALLOW_INSECURE_HTTP: 'true', WEB_BIND_ADDRESS: '127.0.0.1' };
    expect(productionOrigin(env, false)).toBe(env.PUBLIC_ORIGIN);
    expect(() => productionOrigin(env, true)).toThrow('COOKIE_SECURE');
    expect(() => productionOrigin({ ...env, ALLOW_INSECURE_HTTP: 'false' }, false)).toThrow('HTTPS');
    expect(() => productionOrigin({ ...env, WEB_BIND_ADDRESS: '0.0.0.0' }, false)).toThrow('loopback');
  });

  it('does not constrain development', () => {
    expect(productionOrigin({ NODE_ENV: 'development' }, false)).toBeUndefined();
  });
});
