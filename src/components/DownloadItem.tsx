import {
  X,
  CheckCircle,
  AlertCircle,
  Loader,
  Play,
  FolderOpen,
} from "lucide-react";
import { useDownloadStore } from "../stores/downloadStore";
import { openFile, revealFile } from "../lib/commands";
import type { DownloadItem as DLItem } from "../lib/types";

interface Props {
  item: DLItem;
}

/** Color map for status indicators */
const statusColors: Record<string, string> = {
  pending: "text-neutral-500",
  downloading: "text-blue-400",
  converting: "text-yellow-400",
  complete: "text-green-400",
  error: "text-red-400",
};

/** Icon for each status */
function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case "complete":
      return <CheckCircle size={16} className="text-green-400" />;
    case "error":
      return <AlertCircle size={16} className="text-red-400" />;
    case "downloading":
    case "converting":
      return <Loader size={16} className="animate-spin text-blue-400" />;
    default:
      return <Loader size={16} className="text-neutral-500" />;
  }
}

export function DownloadItem({ item }: Props) {
  const removeDownload = useDownloadStore((s) => s.removeDownload);

  const isComplete = item.status === "complete" && item.filePath;

  return (
    <div className="group rounded-lg border border-[#222] bg-[#111] p-4 transition-all duration-200 hover:border-[#333]">
      <div className="flex items-start justify-between gap-3">
        {/* Left side: status icon + info */}
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <div className="mt-0.5">
            <StatusIcon status={item.status} />
          </div>
          <div className="min-w-0 flex-1">
            {/* Title or URL */}
            <p className="truncate text-sm font-medium text-white">
              {item.title || item.url}
            </p>
            {/* Status message */}
            <p
              className={`mt-1 text-xs ${statusColors[item.status] || "text-neutral-500"}`}
            >
              {item.message}
            </p>
          </div>
        </div>

        {/* Right side: badges + actions */}
        <div className="flex shrink-0 items-center gap-2">
          {/* Format badge */}
          <span className="rounded bg-[#222] px-2 py-0.5 text-xs font-medium text-neutral-400">
            {item.format.toUpperCase()}
          </span>
          {/* Backend badge */}
          {item.backend && item.backend !== "none" && (
            <span className="rounded bg-[#222] px-2 py-0.5 text-xs font-medium text-neutral-500">
              {item.backend}
            </span>
          )}

          {/* Open / Play buttons — only show when download is complete */}
          {isComplete && (
            <>
              <button
                onClick={() => openFile(item.filePath!)}
                className="flex items-center gap-1 rounded-md bg-white px-2.5 py-1 text-xs font-medium text-black transition-all duration-200 hover:bg-neutral-200"
                title={item.format === "mp3" ? "Play in default player" : "Open file"}
              >
                <Play size={12} />
                {item.format === "mp3" ? "Play" : "Open"}
              </button>
              <button
                onClick={() => revealFile(item.filePath!)}
                className="rounded-md p-1 text-neutral-400 transition-all duration-200 hover:bg-[#222] hover:text-white"
                title="Show in folder"
              >
                <FolderOpen size={14} />
              </button>
            </>
          )}

          {/* Remove button */}
          <button
            onClick={() => removeDownload(item.id)}
            className="rounded p-1 text-neutral-600 opacity-0 transition-all duration-200 hover:bg-[#222] hover:text-white group-hover:opacity-100"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Progress bar — only show when actively downloading */}
      {(item.status === "downloading" || item.status === "converting") && (
        <div className="mt-3 h-1 overflow-hidden rounded-full bg-[#222]">
          <div
            className="h-full rounded-full bg-white transition-all duration-300"
            style={{ width: `${Math.min(item.progress, 100)}%` }}
          />
        </div>
      )}
    </div>
  );
}
