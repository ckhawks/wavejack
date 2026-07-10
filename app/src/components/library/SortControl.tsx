import { useState, useRef, useEffect } from "react";
import { ArrowUp, ArrowDown, ArrowUpDown, Dices, Check } from "lucide-react";
import { SORT_FIELDS, type SortField, type SortState } from "./libraryShared";

interface SortControlProps {
  sort: SortState;
  /** Toggles direction if `field` is already active, else selects it ascending. */
  onSortClick: (field: SortField) => void;
  onReshuffle: () => void;
}

/** Shared "Sort by ▾" dropdown used across all library layouts, so the grid and
 * compact views can sort by stats they don't visibly display. */
export function SortControl({ sort, onSortClick, onReshuffle }: SortControlProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const activeLabel =
    sort.field === "random"
      ? "Random"
      : SORT_FIELDS.find((s) => s.field === sort.field)?.label ?? "Sort";

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded bg-[#222] px-3 py-2 text-xs text-neutral-300 hover:bg-[#333]"
        title="Sort"
      >
        <ArrowUpDown size={14} />
        <span className="text-neutral-400">Sort:</span>
        <span className="text-white">{activeLabel}</span>
        {sort.field !== "random" &&
          (sort.dir === "asc" ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 min-w-[180px] rounded border border-[#333] bg-[#0a0a0a] py-1 shadow-xl">
          {SORT_FIELDS.map(({ field, label }) => {
            const active = sort.field === field;
            return (
              <button
                key={field}
                onClick={() => onSortClick(field)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-neutral-300 transition-colors hover:bg-[#1a1a1a] hover:text-white"
              >
                <span className="flex-1">{label}</span>
                {active &&
                  (sort.dir === "asc" ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
              </button>
            );
          })}
          <div className="mx-2 my-1 border-t border-[#222]" />
          <button
            onClick={() => { onReshuffle(); setOpen(false); }}
            className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-[#1a1a1a] ${
              sort.field === "random" ? "text-violet-300" : "text-neutral-300 hover:text-white"
            }`}
          >
            <Dices size={12} />
            <span className="flex-1">{sort.field === "random" ? "Reshuffle" : "Random"}</span>
            {sort.field === "random" && <Check size={11} className="text-violet-300" />}
          </button>
        </div>
      )}
    </div>
  );
}
