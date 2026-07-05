/** ISO yyyy-mm-dd → dd.mm.yyyy display string. */
export const fmtDate = (iso: string): string => {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
};

/**
 * Does a round's display name already embed its hours? Admins name rounds
 * like "בוקר 9:00 - 14:00", and every screen that appends startTime–endTime
 * to such a name prints the hours twice (Yoav 2026-07-05). Screens should
 * show the hours themselves only when the name doesn't.
 */
export const labelHasTime = (label: string): boolean => /\d{1,2}:\d{2}/.test(label);

/** One-line round title: the label, with hours appended only when missing. */
export const roundTitle = (label: string, startTime: string, endTime: string): string =>
  labelHasTime(label) ? label : `${label} ${startTime}–${endTime}`;
