import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import crypto from 'crypto';
import { MediaMetadata } from '../../types';

const execFileAsync = promisify(execFile);

export type MediaInspectionFailureCategory =
  | 'MISSING_EXECUTABLE'
  | 'NON_EXECUTABLE'
  | 'TIMEOUT'
  | 'PROCESS_TERMINATED'
  | 'NON_ZERO_EXIT'
  | 'EMPTY_OUTPUT'
  | 'INVALID_OUTPUT'
  | 'INVALID_INPUT_PATH'
  | 'NO_MEDIA_STREAMS'
  | 'INVALID_MEDIA_METADATA';

export class MediaInspectionError extends Error {
  public readonly category?: MediaInspectionFailureCategory;

  constructor(message: string, category?: MediaInspectionFailureCategory) {
    super(message);
    this.name = 'MediaInspectionError';
    this.category = category;
  }
}

export class MediaInspector {
  /**
   * Real media inspection using ffprobe via execFile (zero shell invocation)
   */
  public async inspect(filePath: string, originalFilename: string): Promise<MediaMetadata> {
    if (!fs.existsSync(filePath)) {
      throw new MediaInspectionError(`Media file not found at ${filePath}`, 'INVALID_INPUT_PATH');
    }

    const stats = await fs.promises.stat(filePath);
    if (!stats.isFile()) {
      throw new MediaInspectionError(`Media path is not a regular file: ${filePath}`, 'INVALID_INPUT_PATH');
    }

    const originalSize = stats.size;
    if (originalSize === 0) {
      throw new MediaInspectionError('Uploaded video file is empty (0 bytes).', 'INVALID_MEDIA_METADATA');
    }

    const ffprobeBin = process.env.FFPROBE_PATH || 'ffprobe';

    // Arguments passed directly to ffprobe binary without shell expansion
    const args = [
      '-v', 'error',
      '-show_entries', 'format=duration,size,bit_rate:stream=index,codec_type,codec_name,width,height,r_frame_rate,channels',
      '-print_format', 'json',
      filePath
    ];

    try {
      const { stdout } = await execFileAsync(ffprobeBin, args, { timeout: 15000 });
      const trimmedStdout = (stdout || '').trim();
      if (!trimmedStdout) {
        throw new MediaInspectionError('FFprobe exited without producing stream metadata output.', 'EMPTY_OUTPUT');
      }

      let parsed: any;
      try {
        parsed = JSON.parse(trimmedStdout);
      } catch {
        throw new MediaInspectionError('FFprobe produced malformed or non-JSON metadata output.', 'INVALID_OUTPUT');
      }

      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new MediaInspectionError('FFprobe returned invalid metadata object structure.', 'INVALID_OUTPUT');
      }

      const format = parsed.format || {};
      const streams = Array.isArray(parsed.streams) ? parsed.streams : [];

      const videoStream = streams.find((s: any) => s.codec_type === 'video');
      const audioStream = streams.find((s: any) => s.codec_type === 'audio');

      if (!videoStream && !audioStream) {
        throw new MediaInspectionError('No valid video or audio streams found in container.', 'NO_MEDIA_STREAMS');
      }

      let duration = parseFloat(format.duration || '0');
      if (isNaN(duration) || duration <= 0 || !Number.isFinite(duration)) {
        if (videoStream?.duration) {
          duration = parseFloat(videoStream.duration);
        } else if (audioStream?.duration) {
          duration = parseFloat(audioStream.duration);
        }
      }

      if (isNaN(duration) || duration <= 0 || !Number.isFinite(duration)) {
        throw new MediaInspectionError('Could not determine valid duration for media container.', 'INVALID_MEDIA_METADATA');
      }

      // Preserve actual fractional duration reported by ffprobe (up to millisecond precision)
      const accurateDuration = parseFloat(duration.toFixed(3));
      const durationSeconds = (Number.isFinite(accurateDuration) && accurateDuration > 0)
        ? accurateDuration
        : duration;

      let width = 0;
      let height = 0;
      let fps = 0;
      let resolutionLabel = 'Audio Only (No Video Stream)';

      if (videoStream) {
        width = videoStream.width || 0;
        height = videoStream.height || 0;
        if (width === 0 || height === 0) {
          throw new MediaInspectionError('Video stream present in container but dimensions are missing or invalid.', 'INVALID_MEDIA_METADATA');
        }

        if (videoStream.r_frame_rate) {
          const parts = videoStream.r_frame_rate.split('/');
          if (parts.length === 2 && parseFloat(parts[1]) > 0) {
            fps = Math.round(parseFloat(parts[0]) / parseFloat(parts[1]));
          }
        }
        if (fps <= 0) fps = 30;

        if (width >= 3840 || height >= 2160) {
          resolutionLabel = '4K Ultra HD';
        } else if (width >= 2560 || height >= 1440) {
          resolutionLabel = '1440p Quad HD';
        } else if (width >= 1920 || height >= 1080) {
          resolutionLabel = '1080p Full HD';
        } else if (width >= 1280 || height >= 720) {
          resolutionLabel = '720p HD';
        } else {
          resolutionLabel = `${width}x${height}`;
        }
      }

      const hasAudio = !!audioStream;
      const isProxyNeeded = (width > 1920 || height > 1080);

      // Compute exact SHA-256 hash of media file for version identity
      const sha256 = await new Promise<string>((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('data', chunk => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
      });

      return {
        filename: originalFilename,
        originalSize,
        durationSeconds,
        width,
        height,
        resolutionLabel,
        fps,
        hasAudio,
        audioCodec: audioStream?.codec_name,
        videoCodec: videoStream?.codec_name,
        isProxyUsed: isProxyNeeded,
        sha256,
      };
    } catch (err: any) {
      if (err instanceof MediaInspectionError) {
        throw err;
      }
      const errCodeStr = typeof err?.code === 'string' ? err.code : '';
      if (errCodeStr === 'ENOENT') {
        throw new MediaInspectionError(`FFprobe executable not found (${ffprobeBin}).`, 'MISSING_EXECUTABLE');
      }
      if (errCodeStr === 'EACCES' || errCodeStr === 'EPERM' || errCodeStr === 'EISDIR') {
        throw new MediaInspectionError(`FFprobe path is not executable (${errCodeStr}).`, 'NON_EXECUTABLE');
      }
      if (err?.killed || err?.signal === 'SIGTERM' || errCodeStr === 'ETIMEDOUT') {
        throw new MediaInspectionError('Media inspection timed out while probing streams.', 'TIMEOUT');
      }
      if (err?.signal) {
        throw new MediaInspectionError(`FFprobe process terminated unexpectedly (${err.signal}).`, 'PROCESS_TERMINATED');
      }
      const exitCode = typeof err?.code === 'number' ? err.code : null;
      const stderrLine = String(err?.stderr || err?.message || 'Unsupported or corrupted video format.')
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-2)
        .join(' | ')
        .slice(0, 180);
      if (exitCode !== null) {
        throw new MediaInspectionError(
          `Failed to decode media file (FFprobe exit code ${exitCode}): ${stderrLine}`,
          'NON_ZERO_EXIT'
        );
      }
      throw new MediaInspectionError(
        `Failed to decode media file: ${stderrLine}`,
        'NON_ZERO_EXIT'
      );
    }
  }
}

export const mediaInspector = new MediaInspector();
