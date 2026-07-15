import { useMemo, useRef, useState } from "react";
import { addTag } from "../lib/tags";
import { usePopover } from "../hooks/usePopover";

interface Props {
  tags: string[];
  activeTags: string[];
  released: boolean;
  onChange: (tags: string[]) => void;
}

// Editor tags widget: neutral badges + an EXISTING TAGS popup (active tags not
// already on the item) + a `new tag` input. Normalization is frontend-owned
// (D9): the input lowercases, strips a leading '#', trims, and dedupes.
export default function EditorTags({ tags, activeTags, released, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [entry, setEntry] = useState("");
  const wrapper = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const entryInput = useRef<HTMLInputElement>(null);
  // Focus the `new tag` input on open so a tag can be typed right away.
  usePopover(open, () => setOpen(false), {
    wrapper,
    panel,
    trigger,
    initialFocus: entryInput,
  });

  const available = useMemo(
    () => activeTags.filter((t) => !tags.includes(t)),
    [activeTags, tags],
  );

  function addFromVocab(tag: string) {
    onChange([...tags, tag]);
  }
  function remove(tag: string) {
    onChange(tags.filter((t) => t !== tag));
  }
  function addEntry() {
    const next = addTag(tags, entry);
    if (next !== tags) onChange(next);
    setEntry("");
  }

  const badgeClass = released ? "tag-badge tag-badge-released" : "tag-badge";

  return (
    <div className="editor-tags" ref={wrapper}>
      {tags.map((t) => (
        <span key={t} className={badgeClass}>
          #{t}
          <button
            className="tag-x"
            aria-label={`Remove tag ${t}`}
            onClick={() => remove(t)}
          >
            ×
          </button>
        </span>
      ))}
      <button
        className="tag-add"
        ref={trigger}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        + tag
      </button>

      {open && (
        <div className="popover popover-editortags" ref={panel}>
          <span className="popover-label">EXISTING TAGS</span>
          {available.length === 0 ? (
            <p className="popover-empty">No other tags yet.</p>
          ) : (
            <div className="popover-pills">
              {available.map((t) => (
                <button
                  key={t}
                  className="popover-pill"
                  onClick={() => addFromVocab(t)}
                >
                  #{t}
                </button>
              ))}
            </div>
          )}
          <div className="popover-new-tag">
            <input
              ref={entryInput}
              className="popover-new-tag-input"
              placeholder="new tag"
              value={entry}
              onChange={(e) => setEntry(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addEntry();
                }
              }}
            />
            <button className="btn" onClick={addEntry}>
              Add
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
