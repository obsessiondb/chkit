`chkit query` runs SQL passed as one argument that starts with a line comment, such as
`"-- note\nSELECT 1"`, instead of rejecting it as an unknown option, as TS does (#584).
