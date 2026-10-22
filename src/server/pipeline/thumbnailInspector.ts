import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { ThumbnailMetadata } from '../../types';

const execFileAsync = promisify(execFile);

export class ThumbnailInspectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ThumbnailInspectionError';
  }
}

export class ThumbnailInspector {
  /**
   * Analyzes an uploaded thumbnail image for dimensions, aspect ratio, visual properties,
   * and potential pre-publish compliance flags.
   */
  public async inspect(imagePath: string, originalFilename: string): Promise<ThumbnailMetadata> {
    if (!fs.existsSync(imagePath)) {
      throw new ThumbnailInspectionError('Thumbnail image file does not exist on disk.');
    }

    const stats = fs.statSync(imagePath);
    if (stats.size === 0) {
      throw new ThumbnailInspectionError('Uploaded thumbnail image file is empty (0 bytes).');
    }

    if (stats.size > 10 * 1024 * 1024) {
      throw new ThumbnailInspectionError('Thumbnail file size exceeds 10 MB limit.');
    }

    try {
      // Use ffprobe to reliably inspect image dimensions and stream format
      const args = [
        '-v', 'error',
        '-show_entries', 'stream=width,height,codec_name:format=format_name,size',
        '-of', 'json',
        imagePath
      ];

      const { stdout } = await execFileAsync('ffprobe', args, { timeout: 15000 });
      const probeData = JSON.parse(stdout);

      const stream = probeData.streams?.[0];
      if (!stream || !stream.width || !stream.height) {
        throw new ThumbnailInspectionError('Unable to decode image dimensions from file.');
      }

      const width = stream.width;
      const height = stream.height;
      const format = stream.codec_name || path.extname(originalFilename).replace('.', '');

      // Aspect ratio calculation
      const ratio = width / Math.max(1, height);
      const is16by9 = Math.abs(ratio - (16 / 9)) < 0.08;
      const aspectRatioLabel = is16by9 ? '16:9' : `${(ratio).toFixed(2)}:1`;

      // Extract basic luminance sample via ffmpeg signalstats filter or deterministic probe
      const meanLuminance = await this.extractLuminance(imagePath);

      // Evidence integrity: Visual text overlays, OCR, and graphic clickbait cues (arrows/circles)
      // cannot be honestly inferred from luminance thresholds or filename strings alone.
      // Explicitly represent visual content analysis as NOT_ASSESSED.
      const hasHighContrastText: boolean | null = null;
      const hasSensationalElements: boolean | null = null;
      const visualAnalysisStatus = 'NOT_ASSESSED' as const;

      const notes: string[] = [];
      if (!is16by9) {
        notes.push(`Aspect ratio is ${aspectRatioLabel}. YouTube standard 16:9 (1280x720) recommended to avoid letterboxing.`);
      }
      if (stats.size > 2 * 1024 * 1024) {
        notes.push('Image is larger than 2 MB. YouTube Studio requires thumbnails to be under 2 MB.');
      }
      if (width < 640) {
        notes.push('Resolution is below 640px wide. May appear blurry on high-DPI desktop feeds.');
      }
      notes.push('Visual text, graphic overlays, and sensational cues are not assessed without visual AI models.');

      return {
        filename: originalFilename,
        originalSize: stats.size,
        width,
        height,
        aspectRatio: aspectRatioLabel,
        isStandardAspect: is16by9,
        format,
        meanLuminance,
        hasHighContrastText,
        hasSensationalElements,
        visualAnalysisStatus,
        notes: notes.join(' ')
      };
    } catch (err: any) {
      if (err instanceof ThumbnailInspectionError) throw err;
      throw new ThumbnailInspectionError(`Failed to inspect thumbnail image: ${err.message || 'Corrupted or unsupported format.'}`);
    }
  }

  /**
   * Deterministically measures mean luminance from image frames using FFmpeg signalstats.
   * Returns null if measurement fails, returns empty output, or produces non-numeric output.
   */
  public async extractLuminance(imagePath: string): Promise<number | null> {
    try {
      const statsArgs = [
        '-i', imagePath,
        '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG',
        '-f', 'null',
        '-'
      ];
      const res = await execFileAsync('ffmpeg', statsArgs, { timeout: 15000 }).catch(e => ({ stderr: e.stderr || '' }));
      return this.parseLuminanceOutput(String(res.stderr || ''));
    } catch {
      return null;
    }
  }

  /**
   * Parses YAVG numeric value from signalstats output string.
   * Explicitly returns null for missing, NaN, non-finite, or malformed data.
   */
  public parseLuminanceOutput(output: string): number | null {
    if (!output || typeof output !== 'string') return null;
    const lumMatch = output.match(/YAVG=([\d.]+)/);
    if (!lumMatch) return null;
    const parsed = parseFloat(lumMatch[1]);
    if (!Number.isFinite(parsed) || isNaN(parsed)) return null;
    return Math.round(parsed);
  }
}

export const thumbnailInspector = new ThumbnailInspector();
