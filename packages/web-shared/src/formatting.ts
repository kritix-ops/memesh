/** ISO yyyy-mm-dd → dd.mm.yyyy display string. */
export const fmtDate = (iso: string): string => {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
};
