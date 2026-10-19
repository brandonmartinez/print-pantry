import { describe, expect, it } from 'vitest';
import { isSourceSidecar, sidecarUrls, sourceSidecarLimit } from './source-sidecars.js';
import { binaryWebloc } from './import-fixture.js';

describe('bounded recognized source sidecars', () => {
  it('recognizes sidecars without treating arbitrary documentation as authoritative sources', () => {
    for (const name of ['model.webloc', 'SOURCE.URL', 'nested/metadata.json', 'project.json', 'agentic-plan.json']) expect(isSourceSidecar(name)).toBe(true);
    for (const name of ['README.md', 'guide.html', 'other.json', '__MACOSX/._model.webloc', '._source.url']) expect(isSourceSidecar(name)).toBe(false);
  });

  it.each(['URL', 'URLString'])('reads XML webloc %s with the standard Apple DOCTYPE and entity escapes', (key) => {
    const value = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Other</key><integer>1</integer><key>${key}</key><string>https://example.test/model?a=1&amp;b=2</string></dict></plist>`);
    expect(sidecarUrls('source.webloc', value)).toEqual(['https://example.test/model?a=1&b=2']);
  });

  it.each(['URL', 'URLString'])('reads ASCII and Unicode binary webloc %s without macOS utilities', (key) => {
    for (const url of ['https://makerworld.com/en/models/2747706#profileId-3048005', 'https://example.test/工具?a=1&b=2']) {
      expect(sidecarUrls('model.webloc', binaryWebloc(url, key))).toEqual([url]);
    }
  });

  it('rejects binary cycles, invalid object counts and truncated offsets without recursive traversal', () => {
    const cycle = binaryWebloc('https://example.test/model');
    cycle[10] = 0;
    expect(() => sidecarUrls('model.webloc', cycle)).toThrow();
    const count = binaryWebloc('https://example.test/model');
    count.writeBigUInt64BE(4097n, count.length - 24);
    expect(() => sidecarUrls('model.webloc', count)).toThrow('object table');
    const offset = binaryWebloc('https://example.test/model');
    offset.writeBigUInt64BE(9007199254740992n, offset.length - 8);
    expect(() => sidecarUrls('model.webloc', offset)).toThrow('safe limits');
    expect(() => sidecarUrls('model.webloc', Buffer.from('bplist00'))).toThrow('header');
  });

  it('rejects malformed, deeply nested and entity-declaring XML', () => {
    for (const value of [
      '<plist><dict>',
      '<!DOCTYPE plist [<!ENTITY url SYSTEM "file:///private/file">]><plist><dict><key>URL</key><string>&url;</string></dict></plist>',
      `<plist>${'<array>'.repeat(20)}${'</array>'.repeat(20)}</plist>`,
    ]) expect(() => sidecarUrls('model.webloc', Buffer.from(value))).toThrow();
  });

  it('reads UTF-8 and UTF-16 Windows shortcuts only from the InternetShortcut section', () => {
    const value = '[Other]\r\nURL=https://wrong.test/\r\n[InternetShortcut]\r\nURL=https://example.test/model?a=1&b=2\r\n[Another]\r\nURL=https://wrong.test/other';
    for (const bytes of [Buffer.from(value), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(value, 'utf16le')])]) {
      expect(sidecarUrls('source.url', bytes)).toEqual(['https://example.test/model?a=1&b=2']);
    }
  });

  it('extracts only recognized JSON source fields and legacy organizer file sources', () => {
    expect(sidecarUrls('project.json', Buffer.from(JSON.stringify({
      sourceUrl: 'https://example.test/one', source: { url: 'https://example.test/two' },
      notes: 'https://unrelated.test/', image: 'https://unrelated.test/image',
    })))).toEqual(['https://example.test/one', 'https://example.test/two']);
    expect(sidecarUrls('agentic-plan.json', Buffer.from(JSON.stringify({
      files: [{ sourceUrl: 'https://example.test/one' }, { documentation: 'https://unrelated.test/' }],
    })))).toEqual(['https://example.test/one']);
    expect(() => sidecarUrls('metadata.json', Buffer.from('{"notes":"https://unrelated.test/"}'))).toThrow('No recognized');
    expect(() => sidecarUrls('metadata.json', Buffer.alloc(sourceSidecarLimit + 1))).toThrow('128 KiB');
  });
});
