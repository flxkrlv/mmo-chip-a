import type { AnnotationClass } from "shared";

const CLASS_OPTIONS: ReadonlyArray<{ label: string; value: AnnotationClass }> = [
  { label: "pt-via", value: "point_via" },
  { label: "irr-via", value: "irregular_via" },
  { label: "trace", value: "trace" }
];

/** Multi-select chip row for an ROI's `classes` (which classes that ROI fully
 *  labels — schema §1, load-bearing). Toggling never produces an empty set is
 *  NOT enforced here; an empty array is a valid "labels nothing" ROI. */
export function AnnotationClassSelect({
  value,
  onChange
}: {
  value: AnnotationClass[];
  onChange: (next: AnnotationClass[]) => void;
}) {
  const toggle = (c: AnnotationClass) =>
    onChange(
      value.includes(c) ? value.filter((x) => x !== c) : [...value, c]
    );
  return (
    <span className="row" style={{ gap: 4 }}>
      {CLASS_OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          className={"chip" + (value.includes(o.value) ? " on" : "")}
          style={{ cursor: "pointer" }}
          onClick={() => toggle(o.value)}
        >
          {o.label}
        </button>
      ))}
    </span>
  );
}
