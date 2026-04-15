import { execFile } from "node:child_process";
import { unlink } from "node:fs/promises";

export interface TrackMetadata {
  title: string;
  artist: string;
  album: string;
  duration: number;
  hasCoverArt: boolean;
}

interface TranscodeResult {
  duration: number;
  metadata: TrackMetadata;
}

export async function transcodeAudio(inputPath: string, outputPath: string): Promise<TranscodeResult> {
  // First, probe the file for metadata
  const metadata = await probeMetadata(inputPath);

  // Also extract cover art if present
  const coverOutputPath = outputPath.replace(/\.webm$/, "_cover.jpg");
  await extractCoverArt(inputPath, coverOutputPath).catch(() => {});

  return new Promise((resolve, reject) => {
    const args = [
      "-i", inputPath,
      "-c:a", "libopus",
      "-b:a", "128k",
      "-vn",
      "-y",
      outputPath,
    ];

    execFile("ffmpeg", args, { timeout: 120_000 }, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(`ffmpeg failed: ${error.message}`));
        return;
      }

      // Parse duration from ffmpeg stderr if probe didn't get it
      if (metadata.duration === 0) {
        const durationMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
        if (durationMatch) {
          const [, h, m, s] = durationMatch;
          metadata.duration = parseInt(h!) * 3600 + parseInt(m!) * 60 + parseInt(s!);
        }
      }

      // Clean up input file
      unlink(inputPath).catch(() => {});

      resolve({ duration: metadata.duration, metadata });
    });
  });
}

function probeMetadata(inputPath: string): Promise<TrackMetadata> {
  return new Promise((resolve) => {
    const args = [
      "-v", "quiet",
      "-print_format", "json",
      "-show_format",
      "-show_streams",
      inputPath,
    ];

    execFile("ffprobe", args, { timeout: 10_000 }, (error, stdout) => {
      const meta: TrackMetadata = { title: "", artist: "", album: "", duration: 0, hasCoverArt: false };

      if (error || !stdout) {
        resolve(meta);
        return;
      }

      try {
        const data = JSON.parse(stdout);
        const tags = data.format?.tags ?? {};
        // ffprobe tag keys can be lowercase or Title Case
        meta.title = tags.title ?? tags.TITLE ?? "";
        meta.artist = tags.artist ?? tags.ARTIST ?? tags.album_artist ?? "";
        meta.album = tags.album ?? tags.ALBUM ?? "";
        meta.duration = Math.floor(parseFloat(data.format?.duration ?? "0"));

        // Check if there's a video stream (cover art is embedded as video stream in MP3)
        if (Array.isArray(data.streams)) {
          meta.hasCoverArt = data.streams.some(
            (s: { codec_type?: string; codec_name?: string }) =>
              s.codec_type === "video" || s.codec_name === "mjpeg" || s.codec_name === "png"
          );
        }
      } catch {}

      resolve(meta);
    });
  });
}

function extractCoverArt(inputPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      "-i", inputPath,
      "-an",
      "-vcodec", "mjpeg",
      "-frames:v", "1",
      "-y",
      outputPath,
    ];

    execFile("ffmpeg", args, { timeout: 10_000 }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export function checkFfmpeg(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("ffmpeg", ["-version"], { timeout: 5000 }, (error) => {
      resolve(!error);
    });
  });
}
