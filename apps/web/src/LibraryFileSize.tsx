export const libraryByteLabel = (value: string | null) => value === null ? 'Unknown' : `${BigInt(value).toLocaleString()} bytes`;

export function LibraryFileSize({ value }: { value: string | null }) {
  if (value === null) return <span className="library-readable-size">Unknown</span>;
  const bytes = BigInt(value);
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
  let unit = 0;
  let divisor = 1n;
  while (bytes >= divisor * 1024n && unit < units.length - 1) { divisor *= 1024n; unit++; }
  const tenths = (bytes * 10n + divisor / 2n) / divisor;
  const label = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(Number(tenths) / 10);
  return <span className="library-readable-size" title={libraryByteLabel(value)}>{label} {units[unit]}</span>;
}
