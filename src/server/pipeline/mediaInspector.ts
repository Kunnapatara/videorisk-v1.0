import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import crypto from 'crypto';
import { MediaMetadata } from '../../types';

const execFileAsync = promisify(execFile);

export class MediaInspectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaInspectionError';
  }
}

export class MediaInspector {
  /**
   * Real media inspection using ffprobe via execFile (zero shell invocation)
   */
  public async inspect(filePath: string, originalFilename: string): Promise<MediaMetadata> {
    if (!fs.existsSync(filePath)) {
      throw new MediaInspectionError(`Media file not found at ${filePath}`);
    }

    const stats = await fs.promises.stat(filePath);
    const originalSize = stats.size;

    if (originalSize === 0) {
      throw new MediaInspectionError('Uploaded video file is empty (0 bytes).');
    }

    // Arguments passed directly to ffprobe binary without shell expansion
    const args = [
      '-v', 'error',
      '-show_entries', 'format=duration,size,bit_rate:stream=index,codec_type,codec_name,width,height,r_frame_rate,channels',
      '-print_format', 'json',
      filePath
    ];

    try {
      const { stdout } = await execFileAsync('ffprobe', args, { timeout: 15000 });
      const parsed = JSON.parse(stdout);

      const format = parsed.format || {};
      const streams = parsed.streams || [];

      const videoStream = streams.find((s: any) => s.codec_type === 'video');
      const audioStream = streams.find((s: any) => s.codec_type === 'audio');

      if (!videoStream && !audioStream) {
        throw new MediaInspectionError('No valid video or audio streams found in container.');
      }

      let duration = parseFloat(format.duration || '0');
      if (isNaN(duration) || duration <= 0) {
        if (videoStream?.duration) {
          duration = parseFloat(videoStream.duration);
        } else if (audioStream?.duration) {
          duration = parseFloat(audioStream.duration);
        }
      }

      if (duration <= 0 || isNaN(duration)) {
        throw new MediaInspectionError('Could not determine valid duration for media container.');
      }

      let width = 0;
      let height = 0;
      let fps = 0;
      let resolutionLabel = 'Audio Only (No Video Stream)';

      if (videoStream) {
        width = videoStream.width || 0;
        height = videoStream.height || 0;
        if (width === 0 || height === 0) {
          throw new MediaInspectionError('Video stream present in container but dimensions are missing or invalid.');
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
        durationSeconds: Math.max(1, Math.round(duration)),
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
      if (err.killed || err.signal === 'SIGTERM') {
        throw new MediaInspectionError('Media inspection timed out while probing streams.');
      }
      throw new MediaInspectionError(
        `Failed to decode media file: ${err?.message || 'Unsupported or corrupted video format.'}`
      );
    }
  }
}

export const mediaInspector = new MediaInspector();
