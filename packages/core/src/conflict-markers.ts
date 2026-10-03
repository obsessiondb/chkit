// Git writes conflict markers at the start of a line: `<<<<<<< ours`, `=======`,
// `>>>>>>> theirs`, and `||||||| base` with diff3/zdiff3. `conflict-marker-size`
// can make them longer than 7 characters.
const CONFLICT_MARKER_LINE = /^(?:<{7,}|>{7,}|\|{7,})(?:[ \t].*)?$|^={7,}[ \t]*$/

/** Whether `text` has a line that git writes for an unresolved merge conflict. */
export function hasConflictMarkers(text: string): boolean {
  return text.split(/\r?\n/).some((line) => CONFLICT_MARKER_LINE.test(line))
}
