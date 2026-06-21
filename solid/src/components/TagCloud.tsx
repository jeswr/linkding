// AUTHORED-BY Claude Opus 4.8
interface Props {
  /** Tag entries: `tag` is the normalised (lowercased) key, `label` the display form. */
  tags: { tag: string; label: string; count: number }[];
  selected: string[];
  onToggle: (tag: string) => void;
}

/** Linkding's tag-cloud side panel — click a tag to AND it into the filter. */
export function TagCloud({ tags, selected, onToggle }: Props) {
  if (tags.length === 0) return null;
  return (
    <aside className="tag-cloud" aria-label="Tags">
      <h2>Tags</h2>
      <div className="tag-cloud-items">
        {tags.map(({ tag, label, count }) => {
          const active = selected.map((t) => t.toLowerCase()).includes(tag);
          return (
            <button
              type="button"
              key={tag}
              className={`tag-link${active ? " active" : ""}`}
              onClick={() => onToggle(tag)}
              aria-pressed={active}
            >
              #{label} <span className="tag-count">{count}</span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
