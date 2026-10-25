import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { 
  ThumbnailMetadata, 
  DetectorExecutionStatus, 
  DetectorReport 
} from '../../types';

const execFileAsync = promisify(execFile);

export class ThumbnailInspectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ThumbnailInspectionError';
  }
}

export interface ThumbnailOcrResult {
  status: DetectorExecutionStatus;
  extractedText: string | null;
  textDensityRatio: number | null;
  confidence: number;
  limitations: string;
  failureReason?: string;
  executionDurationMs: number;
}

/**
 * Adapter for local thumbnail OCR text extraction.
 * Checks TESSERACT_PATH or system tesseract binary.
 * Gracefully reports NOT_ASSESSED when OCR tool is not configured/installed,
 * rather than fabricating text or claiming visual semantics.
 */
export class ThumbnailOcrAdapter {
  public async extractText(imagePath: string, width: number, height: number): Promise<ThumbnailOcrResult> {
    const startTime = Date.now();
    const tesseractPath = process.env.TESSERACT_PATH;

    // Check explicit path or system tool
    let executable: string | null = null;
    if (tesseractPath && fs.existsSync(tesseractPath)) {
      executable = tesseractPath;
    } else if (tesseractPath) {
      return {
        status: 'ANALYSIS_UNAVAILABLE',
        extractedText: null,
        textDensityRatio: null,
        confidence: 0,
        failureReason: `Configured TESSERACT_PATH not found at ${tesseractPath}`,
        limitations: 'OCR engine path was configured but executable is missing.',
        executionDurationMs: Date.now() - startTime
      };
    }

    if (!executable) {
      return {
        status: 'NOT_ASSESSED',
        extractedText: null,
        textDensityRatio: null,
        confidence: 0,
        limitations: 'Visual OCR engine (TESSERACT_PATH) not configured or installed. Visual text overlays and typography are not assessed.',
        executionDurationMs: 0
      };
    }

    try {
      const { stdout } = await execFileAsync(executable, [imagePath, 'stdout', '--oem', '1'], { timeout: 20000 });
      const elapsed = Date.now() - startTime;
      const text = (stdout || '').trim();

      if (text.length === 0) {
        return {
          status: 'NO_SIGNAL_DETECTED',
          extractedText: '',
          textDensityRatio: 0,
          confidence: 0.90,
          limitations: 'OCR ran successfully; no legible text detected in image.',
          executionDurationMs: elapsed
        };
      }

      // Estimate text density ratio relative to thumbnail canvas (characters per 1000px resolution unit)
      const canvasUnits = (width * height) / 10000;
      const textDensity = parseFloat(Math.min(1.0, text.length / Math.max(10, canvasUnits)).toFixed(2));

      return {
        status: 'DETECTED',
        extractedText: text,
        textDensityRatio: textDensity,
        confidence: 0.88,
        limitations: 'Text extracted via local OCR engine; low contrast or stylized fonts may affect character accuracy.',
        executionDurationMs: elapsed
      };
    } catch (err: any) {
      return {
        status: 'ANALYSIS_UNAVAILABLE',
        extractedText: null,
        textDensityRatio: null,
        confidence: 0,
        failureReason: `OCR extraction failed: ${err?.message || err}`,
        limitations: 'Thumbnail OCR execution failed.',
        executionDurationMs: Date.now() - startTime
      };
    }
  }
}

export class ThumbnailInspector {
  private ocrAdapter = new ThumbnailOcrAdapter();

  /**
   * Analyzes an uploaded thumbnail image for dimensions, aspect ratio, visual properties,
   * luminance, and optional OCR text extraction.
   */
  public async inspect(imagePath: string, originalFilename: string): Promise<ThumbnailMetadata> {
    const startTime = Date.now();

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

      // Run optional local OCR analysis
      const ocrResult = await this.ocrAdapter.extractText(imagePath, width, height);

      const hasHighContrastText: boolean | null = ocrResult.status === 'DETECTED' 
        ? true 
        : (ocrResult.status === 'NO_SIGNAL_DETECTED' ? false : null);

      const hasSensationalElements: boolean | null = null;
      const visualAnalysisStatus = ocrResult.status === 'DETECTED'
        ? 'REVIEW_RECOMMENDED'
        : 'NOT_ASSESSED';

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

      if (ocrResult.status === 'DETECTED' && ocrResult.extractedText) {
        notes.push(`Text detected: "${ocrResult.extractedText.substring(0, 60)}${ocrResult.extractedText.length > 60 ? '...' : ''}". Ensure thumbnail text accurately reflects video content.`);
      } else if (ocrResult.status === 'NOT_ASSESSED') {
        notes.push('Visual text, graphic overlays, and sensational cues are not assessed without visual AI models.');
      }

      const totalMs = Date.now() - startTime;
      const detectors: Record<string, DetectorReport> = {
        thumbnail_geometry: {
          detectorName: 'ffprobe_stream_geometry',
          version: '1.0.0',
          status: 'DETECTED',
          executionDurationMs: totalMs,
          confidence: 0.99,
          limitations: 'Measures pixel width, height, and container format from decoded image stream header.'
        },
        thumbnail_luminance: {
          detectorName: 'ffmpeg_signalstats_yavg',
          version: '1.0.0',
          status: meanLuminance !== null ? 'DETECTED' : 'ANALYSIS_UNAVAILABLE',
          executionDurationMs: totalMs,
          confidence: meanLuminance !== null ? 0.95 : 0,
          limitations: 'Calculates mean luminance (0-255 YAVG) via FFmpeg signalstats filter.'
        },
        thumbnail_ocr: {
          detectorName: 'local_ocr_adapter',
          version: '1.0.0',
          status: ocrResult.status,
          executionDurationMs: ocrResult.executionDurationMs,
          confidence: ocrResult.confidence,
          limitations: ocrResult.limitations,
          failureReason: ocrResult.failureReason
        }
      };

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
        ocrAnalysisStatus: ocrResult.status,
        extractedText: ocrResult.extractedText,
        textDensityRatio: ocrResult.textDensityRatio,
        notes: notes.join(' '),
        detectors
      };
    } catch (err: any) {
      if (err instanceof ThumbnailInspectionError) throw err;
      throw new ThumbnailInspectionError(`Failed to inspect thumbnail image: ${err.message || 'Corrupted or unsupported format.'}`);
    }
  }

  /**
   * Deterministically measures mean luminance from image frames using FFmpeg signalstats.
   * Returns null if process fails (non-zero exit/crash/timeout), returns empty output, or produces non-numeric output.
   */
  public async extractLuminance(imagePath: string): Promise<number | null> {
    try {
      const statsArgs = [
        '-i', imagePath,
        '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG',
        '-f', 'null',
        '-'
      ];
      const { stderr } = await execFileAsync('ffmpeg', statsArgs, { timeout: 15000 });
      return this.evaluateLuminanceExecution(String(stderr || ''), false);
    } catch {
      return null;
    }
  }

  /**
   * Evaluates FFmpeg execution result for luminance measurement.
   * If hasError is true (e.g. non-zero exit code, process crash, timeout), returns null
   * even if partial output contains a signalstats value.
   */
  public evaluateLuminanceExecution(output: string, hasError: boolean): number | null {
    if (hasError) return null;
    return this.parseLuminanceOutput(output);
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
