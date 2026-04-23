import { useState, useEffect } from "react";
import { X, FolderOpen, CheckCircle, AlertCircle, Loader, Copy, LogIn, LogOut } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { useSettingsStore } from "../stores/settingsStore";
import {
  ensureYtdlpReady, getRemoteInfo, formatErr,
  spotifyLogin, spotifyAuthStatus, spotifyLogout,
  tidalLoginStart, tidalLoginFinish, tidalAuthStatus, tidalLogout,
} from "../lib/commands";
import type { SpotifyUser, TidalUser, TidalDeviceAuth } from "../lib/types";

interface Props {
  onClose: () => void;
}

export function Settings({ onClose }: Props) {
  const { settings, loaded, updateSetting } = useSettingsStore();
  const [cobaltUrl, setCobaltUrl] = useState("");
  const [lastfmKey, setLastfmKey] = useState("");
  const [ytdlpStatus, setYtdlpStatus] = useState<
    "unknown" | "checking" | "ready" | "downloading" | "error"
  >("unknown");
  const [ytdlpPath, setYtdlpPath] = useState("");
  const [remoteToken, setRemoteToken] = useState("");
  const [remotePort, setRemotePort] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [spotifyClientId, setSpotifyClientId] = useState("");
  const [spotifyClientSecret, setSpotifyClientSecret] = useState("");
  const [scCookiesBrowser, setScCookiesBrowser] = useState("");
  const [spotifyUser, setSpotifyUser] = useState<SpotifyUser | null>(null);
  const [spotifyBusy, setSpotifyBusy] = useState(false);
  const [spotifyError, setSpotifyError] = useState<string | null>(null);
  const [tidalUser, setTidalUser] = useState<TidalUser | null>(null);
  const [tidalBusy, setTidalBusy] = useState(false);
  const [tidalError, setTidalError] = useState<string | null>(null);
  const [tidalPending, setTidalPending] = useState<TidalDeviceAuth | null>(null);

  // Sync local cobalt URL state when settings load
  useEffect(() => {
    if (loaded) {
      setCobaltUrl(settings.cobaltUrl);
      setLastfmKey(settings.lastfmApiKey);
      setSpotifyClientId(settings.spotifyClientId);
      setSpotifyClientSecret(settings.spotifyClientSecret);
      setScCookiesBrowser(settings.soundcloudCookiesBrowser);
    }
  }, [loaded, settings.cobaltUrl, settings.lastfmApiKey, settings.spotifyClientId, settings.spotifyClientSecret, settings.soundcloudCookiesBrowser]);

  useEffect(() => {
    spotifyAuthStatus().then(setSpotifyUser).catch(() => {});
    tidalAuthStatus().then(setTidalUser).catch(() => {});
  }, []);

  const doTidalLogin = async () => {
    setTidalBusy(true);
    setTidalError(null);
    setTidalPending(null);
    try {
      const pending = await tidalLoginStart();
      setTidalPending(pending);
      const user = await tidalLoginFinish();
      setTidalUser(user);
      setTidalPending(null);
    } catch (e) {
      setTidalError(formatErr(e));
      setTidalPending(null);
    } finally {
      setTidalBusy(false);
    }
  };

  const doTidalLogout = async () => {
    await tidalLogout();
    setTidalUser(null);
  };

  const doSpotifyLogin = async () => {
    setSpotifyBusy(true);
    setSpotifyError(null);
    try {
      const user = await spotifyLogin();
      setSpotifyUser(user);
    } catch (e) {
      setSpotifyError(formatErr(e));
    } finally {
      setSpotifyBusy(false);
    }
  };

  const doSpotifyLogout = async () => {
    await spotifyLogout();
    setSpotifyUser(null);
  };

  useEffect(() => {
    getRemoteInfo()
      .then((info) => {
        setRemoteToken(info.token);
        setRemotePort(info.port);
      })
      .catch((e) => console.error("Failed to load remote info:", e));
  }, []);

  const copyToken = async () => {
    await navigator.clipboard.writeText(remoteToken);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // Pick output directory using system folder picker
  const pickOutputDir = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (selected) {
      await updateSetting("outputDir", selected as string);
    }
  };

  const pickMusicDir = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (selected) {
      await updateSetting("musicDir", selected as string);
    }
  };

  // Save cobalt URL on blur
  const saveCobaltUrl = async () => {
    await updateSetting("cobaltUrl", cobaltUrl);
  };

  // Check/install yt-dlp
  const checkYtdlp = async () => {
    setYtdlpStatus("checking");
    try {
      const path = await ensureYtdlpReady();
      setYtdlpPath(path);
      setYtdlpStatus("ready");
    } catch (e) {
      console.error("yt-dlp check failed:", e);
      setYtdlpStatus("error");
    }
  };

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-xl border border-[#222] bg-[#111] shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[#222] px-6 py-4">
          <h2 className="text-base font-semibold text-white">Settings</h2>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-neutral-400 transition-colors hover:text-white"
          >
            <X size={20} />
          </button>
        </div>

        {/* Body */}
        <div className="space-y-6 p-6">
          {/* Downloads directory */}
          <div>
            <label className="mb-2 block text-sm font-medium text-neutral-400">
              Downloads Folder
            </label>
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1 truncate rounded-lg border border-[#333] bg-black px-4 py-2.5 text-sm text-white">
                {settings.outputDir || "Not set (using system Downloads)"}
              </div>
              <button
                onClick={pickOutputDir}
                className="flex items-center gap-2 rounded-lg border border-[#333] px-4 py-2.5 text-sm text-neutral-400 transition-all duration-200 hover:border-[#555] hover:text-white"
              >
                <FolderOpen size={16} />
                Browse
              </button>
            </div>
          </div>

          {/* Music Library directory */}
          <div>
            <label className="mb-2 block text-sm font-medium text-neutral-400">
              Music Library Folder
            </label>
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1 truncate rounded-lg border border-[#333] bg-black px-4 py-2.5 text-sm text-white">
                {settings.musicDir || "Not set (using system Music)"}
              </div>
              <button
                onClick={pickMusicDir}
                className="flex items-center gap-2 rounded-lg border border-[#333] px-4 py-2.5 text-sm text-neutral-400 transition-all duration-200 hover:border-[#555] hover:text-white"
              >
                <FolderOpen size={16} />
                Browse
              </button>
            </div>
          </div>

          {/* Cobalt instance URL */}
          <div>
            <label className="mb-2 block text-sm font-medium text-neutral-400">
              Cobalt Instance URL (optional fallback)
            </label>
            <input
              type="text"
              value={cobaltUrl}
              onChange={(e) => setCobaltUrl(e.target.value)}
              onBlur={saveCobaltUrl}
              placeholder="https://your-cobalt-instance.example.com"
              className="w-full rounded-lg border border-[#333] bg-black px-4 py-2.5 text-sm text-white placeholder-neutral-600 outline-none transition-all duration-200 focus:border-[#555]"
            />
            <p className="mt-1.5 text-xs text-neutral-600">
              Self-hosted cobalt instance. Used as fallback when yt-dlp fails.
            </p>
          </div>

          {/* Last.fm API key */}
          <div>
            <label className="mb-2 block text-sm font-medium text-neutral-400">
              Last.fm API Key (for Discover)
            </label>
            <input
              type="text"
              value={lastfmKey}
              onChange={(e) => setLastfmKey(e.target.value)}
              onBlur={() => updateSetting("lastfmApiKey", lastfmKey)}
              placeholder="Your Last.fm API key"
              className="w-full rounded-lg border border-[#333] bg-black px-4 py-2.5 text-sm text-white placeholder-neutral-600 outline-none transition-all duration-200 focus:border-[#555]"
            />
            <p className="mt-1.5 text-xs text-neutral-600">
              Free API key from last.fm/api/account/create. Powers the Discover tab.
            </p>
          </div>

          {/* SoundCloud original-download cookies */}
          <div>
            <label className="mb-2 block text-sm font-medium text-neutral-400">
              SoundCloud cookies browser (for original file downloads)
            </label>
            <select
              value={scCookiesBrowser}
              onChange={(e) => {
                setScCookiesBrowser(e.target.value);
                updateSetting("soundcloudCookiesBrowser", e.target.value);
              }}
              className="w-full rounded-lg border border-[#333] bg-black px-4 py-2.5 text-sm text-white outline-none transition-all duration-200 focus:border-[#555]"
            >
              <option value="">None (use 128/160 kbps stream)</option>
              <option value="chrome">Chrome</option>
              <option value="firefox">Firefox</option>
              <option value="edge">Edge</option>
              <option value="brave">Brave</option>
              <option value="safari">Safari</option>
              <option value="opera">Opera</option>
              <option value="vivaldi">Vivaldi</option>
            </select>
            <p className="mt-1.5 text-xs text-neutral-600">
              Pulls SoundCloud cookies from your browser so yt-dlp can grab the
              uploader's original file (often WAV/FLAC/320 MP3) when they enabled
              the download button. Any free SC account is enough — no Go+ required.
            </p>
          </div>

          {/* Remote control (Stream Deck) */}
          <div>
            <label className="mb-2 block text-sm font-medium text-neutral-400">
              Remote Control Token
            </label>
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1 truncate rounded-lg border border-[#333] bg-black px-4 py-2.5 font-mono text-xs text-white">
                {remoteToken || "Loading..."}
              </div>
              <button
                onClick={copyToken}
                disabled={!remoteToken}
                className="flex items-center gap-2 rounded-lg border border-[#333] px-4 py-2.5 text-sm text-neutral-400 transition-all duration-200 hover:border-[#555] hover:text-white disabled:opacity-40"
              >
                <Copy size={16} />
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <p className="mt-1.5 text-xs text-neutral-600">
              Send <span className="font-mono">POST http://127.0.0.1:{remotePort ?? "7406"}/...</span>{" "}
              with header <span className="font-mono">X-Wavejack-Token</span>.
              Endpoints: <span className="font-mono">/discover/approve</span>,{" "}
              <span className="font-mono">/discover/skip</span>,{" "}
              <span className="font-mono">/player/volume/up</span>,{" "}
              <span className="font-mono">/player/volume/down</span>,{" "}
              <span className="font-mono">/player/play-pause</span>.
            </p>
          </div>

          {/* Spotify */}
          <div>
            <label className="mb-2 block text-sm font-medium text-neutral-400">
              Spotify (for importing playlists)
            </label>
            <div className="space-y-2">
              <input
                type="text"
                value={spotifyClientId}
                onChange={(e) => setSpotifyClientId(e.target.value)}
                onBlur={() => updateSetting("spotifyClientId", spotifyClientId)}
                placeholder="Client ID"
                className="w-full rounded-lg border border-[#333] bg-black px-4 py-2.5 text-sm text-white placeholder-neutral-600 outline-none transition-all duration-200 focus:border-[#555]"
              />
              <input
                type="password"
                value={spotifyClientSecret}
                onChange={(e) => setSpotifyClientSecret(e.target.value)}
                onBlur={() => updateSetting("spotifyClientSecret", spotifyClientSecret)}
                placeholder="Client Secret"
                className="w-full rounded-lg border border-[#333] bg-black px-4 py-2.5 text-sm text-white placeholder-neutral-600 outline-none transition-all duration-200 focus:border-[#555]"
              />
              <div className="flex items-center gap-3">
                <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-[#333] bg-black px-4 py-2.5 text-sm">
                  {spotifyUser ? (
                    <>
                      <CheckCircle size={14} className="shrink-0 text-green-400" />
                      <span className="truncate text-green-400">
                        Connected as {spotifyUser.display_name || spotifyUser.id}
                      </span>
                    </>
                  ) : spotifyBusy ? (
                    <>
                      <Loader size={14} className="shrink-0 animate-spin text-blue-400" />
                      <span className="text-blue-400">Waiting for browser...</span>
                    </>
                  ) : (
                    <span className="text-neutral-500">Not connected</span>
                  )}
                </div>
                {spotifyUser ? (
                  <button
                    onClick={doSpotifyLogout}
                    className="flex items-center gap-2 rounded-lg border border-[#333] px-4 py-2.5 text-sm text-neutral-400 transition-all duration-200 hover:border-[#555] hover:text-white"
                  >
                    <LogOut size={16} />
                    Disconnect
                  </button>
                ) : (
                  <button
                    onClick={doSpotifyLogin}
                    disabled={spotifyBusy || !spotifyClientId || !spotifyClientSecret}
                    className="flex items-center gap-2 rounded-lg bg-white px-4 py-2.5 text-sm font-medium text-black transition-all duration-200 hover:bg-neutral-200 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <LogIn size={16} />
                    Connect
                  </button>
                )}
              </div>
              {spotifyError && (
                <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                  <AlertCircle size={12} className="shrink-0" />
                  {spotifyError}
                </div>
              )}
              <p className="text-xs text-neutral-600">
                Create an app at developer.spotify.com/dashboard and add{" "}
                <span className="font-mono">http://127.0.0.1:8888/callback</span>{" "}
                as the redirect URI.
              </p>
            </div>
          </div>

          {/* Tidal */}
          <div>
            <label className="mb-2 block text-sm font-medium text-neutral-400">
              Tidal (for matching + downloading Spotify tracks)
            </label>
            <div className="flex items-center gap-3">
              <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-[#333] bg-black px-4 py-2.5 text-sm">
                {tidalUser ? (
                  <>
                    <CheckCircle size={14} className="shrink-0 text-green-400" />
                    <span className="truncate text-green-400">
                      Connected (user {tidalUser.id} · {tidalUser.country_code})
                    </span>
                  </>
                ) : tidalBusy ? (
                  <>
                    <Loader size={14} className="shrink-0 animate-spin text-blue-400" />
                    <span className="text-blue-400">
                      {tidalPending ? "Waiting for browser approval..." : "Starting..."}
                    </span>
                  </>
                ) : (
                  <span className="text-neutral-500">Not connected</span>
                )}
              </div>
              {tidalUser ? (
                <button
                  onClick={doTidalLogout}
                  className="flex items-center gap-2 rounded-lg border border-[#333] px-4 py-2.5 text-sm text-neutral-400 transition-all duration-200 hover:border-[#555] hover:text-white"
                >
                  <LogOut size={16} />
                  Disconnect
                </button>
              ) : (
                <button
                  onClick={doTidalLogin}
                  disabled={tidalBusy}
                  className="flex items-center gap-2 rounded-lg bg-white px-4 py-2.5 text-sm font-medium text-black transition-all duration-200 hover:bg-neutral-200 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <LogIn size={16} />
                  Connect
                </button>
              )}
            </div>
            {tidalPending && !tidalUser && (
              <div className="mt-2 space-y-1 rounded-lg border border-blue-500/30 bg-blue-500/5 px-3 py-2 text-xs text-blue-200">
                <div>
                  If the browser didn't open, visit{" "}
                  <a
                    href={tidalPending.verification_url}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono underline"
                  >
                    {tidalPending.verification_url}
                  </a>
                </div>
                <div>
                  and enter code <span className="font-mono font-semibold">{tidalPending.user_code}</span>.
                </div>
              </div>
            )}
            {tidalError && (
              <div className="mt-2 flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                <AlertCircle size={12} className="shrink-0" />
                {tidalError}
              </div>
            )}
            <p className="mt-1.5 text-xs text-neutral-600">
              Approves Wavejack for catalog search on your Tidal account. The{" "}
              <span className="font-mono">tidal-dl-ng</span> CLI has its own separate login.
            </p>
          </div>

          {/* yt-dlp status */}
          <div>
            <label className="mb-2 block text-sm font-medium text-neutral-400">
              yt-dlp Status
            </label>
            <div className="flex items-center gap-3">
              <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-[#333] bg-black px-4 py-2.5 text-sm">
                {ytdlpStatus === "ready" && (
                  <>
                    <CheckCircle size={14} className="shrink-0 text-green-400" />
                    <span className="truncate text-green-400">{ytdlpPath}</span>
                  </>
                )}
                {ytdlpStatus === "checking" || ytdlpStatus === "downloading" ? (
                  <>
                    <Loader size={14} className="shrink-0 animate-spin text-blue-400" />
                    <span className="text-blue-400">
                      {ytdlpStatus === "downloading"
                        ? "Downloading yt-dlp..."
                        : "Checking..."}
                    </span>
                  </>
                ) : null}
                {ytdlpStatus === "error" && (
                  <>
                    <AlertCircle size={14} className="shrink-0 text-red-400" />
                    <span className="text-red-400">Failed to find/download yt-dlp</span>
                  </>
                )}
                {ytdlpStatus === "unknown" && (
                  <span className="text-neutral-500">Not checked yet</span>
                )}
              </div>
              <button
                onClick={checkYtdlp}
                disabled={ytdlpStatus === "checking" || ytdlpStatus === "downloading"}
                className="rounded-lg bg-white px-4 py-2.5 text-sm font-medium text-black transition-all duration-200 hover:bg-neutral-200 disabled:opacity-40"
              >
                {ytdlpStatus === "ready" ? "Re-check" : "Check / Install"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
