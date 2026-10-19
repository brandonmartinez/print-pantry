import { describe, expect, it } from 'vitest';
import { importSource, InvalidSourceUrlError } from './import-sources.js';

describe('offline source identity recognition', () => {
  it('matches MakerWorld models across locales, slugs and tracking while preserving requested profiles', () => {
    const source = importSource('https://makerworld.com/en/models/2747706-universal-drill-bit-holder?from=search#profileId-3048005');
    expect(source).toMatchObject({
      provider: 'makerworld', modelId: '2747706', profileId: '3048005',
      key: 'makerworld:model:2747706', canonicalUrl: 'https://makerworld.com/en/models/2747706',
    });
    expect(importSource('https://www.makerworld.com/de/models/2747706-other?profileId=4').key).toBe(source.key);
    expect(importSource('https://makerworld.com/en/models/27477060-other').key).not.toBe(source.key);
  });

  it('recognizes major-site IDs without promising retrieval', () => {
    expect(importSource('https://www.thingiverse.com/thing:123?foo=bar')).toMatchObject({ provider: 'thingiverse', modelId: '123' });
    expect(importSource('https://www.printables.com/en/model/123-title')).toMatchObject({ provider: 'printables', modelId: '123' });
    expect(importSource('https://thangs.com/designer/person/3d-model/holder-123')).toMatchObject({ provider: 'thangs', modelId: '123' });
  });

  it('preserves unknown-site query parameters and fragments without network access', () => {
    const source = importSource('https://example.invalid/download?id=42#part');
    expect(source.canonicalUrl).toBe(source.url);
    expect(importSource('https://example.invalid/download?id=43#part').key).not.toBe(source.key);
    expect(importSource('https://makerworld.com.evil.invalid/en/models/123-model').provider).toBe('other');
    expect(importSource('https://makerworld.com:8443/en/models/123-model').modelId).toBeNull();
  });

  it.each(['file:///tmp/model.stl', 'javascript:alert(1)', 'https://user:password@example.invalid/', 'not a URL', `https://example.invalid/${'x'.repeat(2048)}`])(
    'rejects invalid source %s', (input) => expect(() => importSource(input)).toThrow(InvalidSourceUrlError),
  );
});
