import { Rows3, Rows2, LayoutGrid } from "lucide-react";
import type { ViewMode } from "./libraryShared";

interface ViewModeToggleProps {
  mode: ViewMode;
  onChange: (mode: ViewMode) => void;
}

const MODES: Array<{ mode: ViewMode; label: string; Icon: typeof Rows3 }> = [
  { mode: "table", label: "Table", Icon: Rows3 },
  { mode: "compact", label: "Compact", Icon: Rows2 },
  { mode: "grid", label: "Grid", Icon: LayoutGrid },
];

/** Segmented control switching between the three library layouts. */
export function ViewModeToggle({ mode, onChange }: ViewModeToggleProps) {
  return (
    <div className="flex items-center gap-0.5 rounded bg-[#222] p-0.5">
      {MODES.map(({ mode: m, label, Icon }) => (
        <button
          key={m}
          onClick={() => onChange(m)}
          title={`${label} view`}
          className={`flex items-center justify-center rounded px-2 py-1.5 transition-colors ${
            mode === m
              ? "bg-[#3a3a3a] text-white"
              : "text-neutral-500 hover:text-neutral-300"
          }`}
        >
          <Icon size={14} />
        </button>
      ))}
    </div>
  );
}
