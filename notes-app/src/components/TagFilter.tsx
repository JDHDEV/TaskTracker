import { useMemo, useRef, useState } from "react";
import { usePopover } from "../hooks/usePopover";

interface Props {
  selected: string[];
  activeTags: string[];
  onChange: (tags: string[]) => void;
}

// Rail FILTER BY TAG widget: soft-yellow selected badges + a `+ tag` popup of
// the remaining active tags. No creation here (the vocabulary is derived).
export default function TagFilter({ selected, activeTags, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  usePopover(open, () => setOpen(false), { wrapper, panel, trigger });

  const available = useMemo(
    () => activeTags.filter((t) => !selected.includes(t)),
    [activeTags, selected],
  );

  function add(tag: string) {
    onChange([...selected, tag]);
  }
  function remove(tag: string) {
    onChange(selected.filter((t) => t !== tag));
  }

  return (
    <div className="tagfilter" ref={wrapper}>
      <span className="tagfilter-label">FILTER BY TAG</span>
      <div className="tagfilter-badges">
        {selected.map((t) => (
          <span key={t} className="tag-badge-filter">
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
          <div className="popover popover-tagfilter" ref={panel}>
            <span className="popover-label">TAGS</span>
            {available.length === 0 ? (
              <p className="popover-empty">All tags selected.</p>
            ) : (
              <div className="popover-pills">
                {available.map((t) => (
                  <button
                    key={t}
                    className="popover-pill"
                    onClick={() => add(t)}
                  >
                    #{t}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
