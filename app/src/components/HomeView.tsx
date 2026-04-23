import { Download, Library, Compass, Rss, Radio, Music, Disc3, ArrowRight } from "lucide-react";
import { useNavStore, type Tab } from "../stores/navStore";
import { useLibraryStore } from "../stores/libraryStore";
import { useDownloadStore } from "../stores/downloadStore";

interface SectionProps {
  icon: typeof Download;
  title: string;
  description: string;
  cta: string;
  tab: Tab;
}

function Section({ icon: Icon, title, description, cta, tab }: SectionProps) {
  const setActiveTab = useNavStore((s) => s.setActiveTab);
  return (
    <button
      onClick={() => setActiveTab(tab)}
      className="group flex flex-col gap-3 rounded-xl border border-[#222] bg-[#0a0a0a] p-5 text-left transition-all duration-200 hover:border-[#333] hover:bg-[#111]"
    >
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#1a1a1a] text-white transition-colors group-hover:bg-[#222]">
          <Icon size={18} />
        </div>
        <h3 className="text-sm font-semibold text-white">{title}</h3>
      </div>
      <p className="text-xs leading-relaxed text-neutral-400">{description}</p>
      <span className="mt-auto flex items-center gap-1.5 text-xs font-medium text-neutral-300 group-hover:text-white">
        {cta}
        <ArrowRight size={12} className="transition-transform duration-200 group-hover:translate-x-0.5" />
      </span>
    </button>
  );
}

export function HomeView() {
  const trackCount = useLibraryStore((s) => s.tracks.length);
  const downloadCount = useDownloadStore((s) => s.downloads.length);

  return (
    <div className="flex flex-1 flex-col gap-8 overflow-y-auto p-8">
      {/* Hero */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-xs uppercase tracking-widest text-neutral-500">
          <Disc3 size={12} />
          Wavejack
        </div>
        <h1 className="text-3xl font-semibold tracking-tight text-white">
          Your music, ingested and organized.
        </h1>
        <p className="max-w-2xl text-sm leading-relaxed text-neutral-400">
          Wavejack pulls audio and video from YouTube, SoundCloud, Tidal, and Spotify
          playlists into a single local library — then lets you tag, preview, and play
          everything from one place. Nothing streams; every track lives on your disk.
        </p>
        <div className="mt-2 flex gap-4 text-xs text-neutral-500">
          <span>
            <span className="font-semibold text-white">{trackCount.toLocaleString()}</span>{" "}
            tracks in library
          </span>
          <span>
            <span className="font-semibold text-white">{downloadCount}</span>{" "}
            in download queue
          </span>
        </div>
      </div>

      {/* Three primary paths */}
      <div>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-neutral-500">
          Get music in
        </h2>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <Section
            icon={Download}
            title="Download"
            description="Paste a YouTube, SoundCloud, or other URL — or search by title. Audio comes through as lossless/AAC with cover art and tags embedded; no re-encoding."
            cta="Open Downloads"
            tab="downloads"
          />
          <Section
            icon={Music}
            title="Import from Spotify / Tidal"
            description="Paste a Spotify playlist URL and Wavejack resolves each track through Tidal (HI_RES_LOSSLESS FLAC where available), falling back to YouTube when a track isn't on Tidal."
            cta="Open Downloads"
            tab="downloads"
          />
          <Section
            icon={Library}
            title="Scan a local folder"
            description="Point Wavejack at an existing music folder. It reads tags, cover art, and builds waveforms — your files are never touched or moved."
            cta="Open Library"
            tab="library"
          />
        </div>
      </div>

      {/* Explore section */}
      <div>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-neutral-500">
          Once you have a library
        </h2>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <Section
            icon={Compass}
            title="Discover"
            description="Pick up to 5 seed tracks from your library and Wavejack fans out to Last.fm similars, previewing candidates inline so you can keep or skip."
            cta="Open Discover"
            tab="discover"
          />
          <Section
            icon={Rss}
            title="Feed"
            description="Subscribe to YouTube channels, SoundCloud accounts, and (soon) Spotify Release Radar / Discover Weekly. New uploads show up here automatically."
            cta="Open Feed"
            tab="feed"
          />
          <Section
            icon={Radio}
            title="Rooms"
            description="plug.dj-style live listening rooms. Take turns DJing from your local library; tracks transcode on the server and stream to listeners."
            cta="Open Rooms"
            tab="rooms"
          />
        </div>
      </div>

      {/* Technical details */}
      <div>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-neutral-500">
          Source specs
        </h2>
        <div className="overflow-hidden rounded-xl border border-[#222] bg-[#0a0a0a]">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-[#222] text-neutral-500">
              <tr>
                <th className="px-4 py-3 font-medium">Source</th>
                <th className="px-4 py-3 font-medium">Backend</th>
                <th className="px-4 py-3 font-medium">Best-case quality</th>
                <th className="px-4 py-3 font-medium">Format</th>
                <th className="px-4 py-3 font-medium">Transcode?</th>
                <th className="px-4 py-3 font-medium">Notes</th>
              </tr>
            </thead>
            <tbody className="text-neutral-300">
              <tr className="border-b border-[#161616]">
                <td className="px-4 py-3 font-medium text-white">YouTube</td>
                <td className="px-4 py-3 text-neutral-400">yt-dlp</td>
                <td className="px-4 py-3">AAC ~128 kbps</td>
                <td className="px-4 py-3 font-mono text-neutral-400">.m4a</td>
                <td className="px-4 py-3 text-green-400/80">No</td>
                <td className="px-4 py-3 text-neutral-500">Native AAC stream, cover art + metadata embedded</td>
              </tr>
              <tr className="border-b border-[#161616]">
                <td className="px-4 py-3 font-medium text-white">YouTube (video)</td>
                <td className="px-4 py-3 text-neutral-400">yt-dlp</td>
                <td className="px-4 py-3">1080p H.264 + AAC</td>
                <td className="px-4 py-3 font-mono text-neutral-400">.mp4</td>
                <td className="px-4 py-3 text-green-400/80">Remux only</td>
                <td className="px-4 py-3 text-neutral-500">Container swap to mp4, no re-encode</td>
              </tr>
              <tr className="border-b border-[#161616]">
                <td className="px-4 py-3 font-medium text-white">SoundCloud</td>
                <td className="px-4 py-3 text-neutral-400">yt-dlp</td>
                <td className="px-4 py-3">Opus 256 kbps stream (typical)</td>
                <td className="px-4 py-3 font-mono text-neutral-400">.opus / native</td>
                <td className="px-4 py-3 text-green-400/80">No</td>
                <td className="px-4 py-3 text-neutral-500">
                  Most tracks have no uploader download enabled — you get the
                  standard stream. When it <em>is</em> enabled (~10% of tracks,
                  usually 320 MP3 or WAV, rarely FLAC) we grab that original
                  instead. Requires free SC account cookies either way.
                </td>
              </tr>
              <tr className="border-b border-[#161616]">
                <td className="px-4 py-3 font-medium text-white">Tidal</td>
                <td className="px-4 py-3 text-neutral-400">tidal-dl-ng</td>
                <td className="px-4 py-3">24-bit / 96 kHz FLAC (HI_RES_LOSSLESS)</td>
                <td className="px-4 py-3 font-mono text-neutral-400">.flac / .m4a</td>
                <td className="px-4 py-3 text-green-400/80">No</td>
                <td className="px-4 py-3 text-neutral-500">
                  Falls back per-track: 16-bit FLAC → AAC if no lossless. Handles MPEG-DASH + DRM.
                </td>
              </tr>
              <tr className="border-b border-[#161616]">
                <td className="px-4 py-3 font-medium text-white">Spotify</td>
                <td className="px-4 py-3 text-neutral-400">Web API → resolve</td>
                <td className="px-4 py-3 text-neutral-500">(metadata only)</td>
                <td className="px-4 py-3 text-neutral-500">—</td>
                <td className="px-4 py-3 text-neutral-500">—</td>
                <td className="px-4 py-3 text-neutral-500">
                  Track list → Tidal ISRC lookup → yt-dlp YouTube fallback
                </td>
              </tr>
              <tr className="border-b border-[#161616]">
                <td className="px-4 py-3 font-medium text-white">Cobalt</td>
                <td className="px-4 py-3 text-neutral-400">self-hosted</td>
                <td className="px-4 py-3">Varies</td>
                <td className="px-4 py-3 text-neutral-500">varies</td>
                <td className="px-4 py-3 text-neutral-500">Varies</td>
                <td className="px-4 py-3 text-neutral-500">Fallback if yt-dlp fails (optional)</td>
              </tr>
              <tr>
                <td className="px-4 py-3 font-medium text-white">Local folder scan</td>
                <td className="px-4 py-3 text-neutral-400">ffmpeg probe</td>
                <td className="px-4 py-3">Whatever you have</td>
                <td className="px-4 py-3 font-mono text-neutral-400">any</td>
                <td className="px-4 py-3 text-green-400/80">Never</td>
                <td className="px-4 py-3 text-neutral-500">Read-only: tags + waveform indexed, files untouched</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11px] text-neutral-600">
          All downloads embed cover art + metadata directly into the file. Sidecar
          artwork written by yt-dlp is captured for the library DB and then deleted.
        </p>
      </div>

      {/* Tiny footer note */}
      <p className="mt-auto pt-6 text-xs text-neutral-600">
        No streams, no analytics, no cloud. Everything lives on this machine.
      </p>
    </div>
  );
}
