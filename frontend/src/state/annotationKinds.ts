export const ANNOTATION_KIND_VALUES = [
  "net",
  "cell",
  "via",
  "roi",
  "pin",
  "ignore"
] as const;

export type AnnotationKind = (typeof ANNOTATION_KIND_VALUES)[number];
