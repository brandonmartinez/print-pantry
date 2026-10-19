const files = new Set([
  '.ds_store', 'thumbs.db', 'ehthumbs.db', 'ehthumbs_vista.db', 'desktop.ini',
  '.directory', '.apdisk', '.lsoverride', '.volumeicon.icns',
]);
const directories = new Set([
  '__macosx', '.appledouble', '.spotlight-v100', '.trashes', '.fseventsd',
  '.temporaryitems', '$recycle.bin', 'system volume information',
]);

export function isOsMetadata(path: string): boolean {
  const parts = path.toLowerCase().split('/');
  const name = parts.at(-1)!;
  return files.has(name) || name.startsWith('._') ||
    parts.some((part) => directories.has(part) || /^\.trash(?:-\d+)?$/.test(part));
}
