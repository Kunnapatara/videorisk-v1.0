import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import { MediaMetadata, ScanMode, DomainAssessmentStatus } from '../../types';

const execFileAsync = promisify(execFile);

export class VideoProcessingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VideoProcessingError';
  }
}

export interface VideoAnalysisResult {
  scenesCount: number;
  framesSampled: number;
  hasSlideshowPattern: boolean;
  repeatedFootageSegments: Array<{ start: number; end: number; matchWithTimestamp: number; confidence: number }>;
  templateRepetitions: Array<{ start: number; end: number; pattern: string }>;
  averagePacingSeconds: number;
  tempFramesDir: string;
  slideshowAnalysisStatus?: DomainAssessmentStatus;
  repeatedFootageStatus?: DomainAssessmentStatus;
}

export class VideoProcessor {
  /**
   * Samples keyframes and detects scene changes using ffmpeg via execFile
   */
  public async analyzeVideo(
    videoPath: string, 
    metadata: MediaMetadata, 
    scanMode: ScanMode
  ): Promise<VideoAnalysisResult> {
    if (!fs.existsSync(videoPath)) {
      throw new VideoProcessingError(`Video file not found at ${videoPath}`);
    }

    const stats = await fs.promises.stat(videoPath);
    if (stats.size === 0) {
      throw new VideoProcessingError('Video file is empty (0 bytes).');
    }

    // Audio-only input: No video stream to sample
    if (!metadata.videoCodec || metadata.width === 0) {
      return {
        scenesCount: 0,
        framesSampled: 0,
        hasSlideshowPattern: false,
        repeatedFootageSegments: [],
        templateRepetitions: [],
        averagePacingSeconds: 0,
        tempFramesDir: '',
        slideshowAnalysisStatus: 'NOT_PROVIDED',
        repeatedFootageStatus: 'NOT_PROVIDED'
      };
    }

    const dur = Math.max(0.1, metadata.durationSeconds || 0.1);
    const uniqueJobSubdir = `job_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const tempDir = path.resolve(process.cwd(), 'uploads', 'frames', uniqueJobSubdir);
    
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const baseInterval = scanMode === 'deep' ? 3 : 8;
    const sampleInterval = dur < baseInterval 
      ? Math.max(0.5, parseFloat((dur / Math.min(3, Math.max(1, Math.floor(dur)))).toFixed(2)))
      : baseInterval;
    const expectedSamples = Math.min(60, Math.max(1, Math.ceil(dur / sampleInterval)));

    try {
      // 1. Extract sampled visual frames
      const extractArgs = [
        '-y',
        '-i', videoPath,
        '-vf', `fps=1/${sampleInterval},scale=160:90`,
        '-vframes', String(expectedSamples),
        path.join(tempDir, 'frame_%03d.jpg')
      ];

      await execFileAsync('ffmpeg', extractArgs, { timeout: 45000 });

      // Read extracted frames from disk
      const frameFiles = fs.readdirSync(tempDir).filter(f => f.endsWith('.jpg')).sort();
      const framesCount = frameFiles.length;

      if (framesCount === 0) {
        throw new VideoProcessingError('Failed to extract visual frames from video stream.');
      }

      // 2. Measure actual scene changes from visual signal differences using ffmpeg select filter
      const sceneArgs = [
        '-y',
        '-i', videoPath,
        '-vf', "scale='min(320,iw)':-2,select='gt(scene,0.3)',metadata=print:file=-",
        '-f', 'null',
        '-'
      ];

      const { stdout } = await execFileAsync('ffmpeg', sceneArgs, { timeout: 45000 });

      // Parse detected scene cut timestamps
      const cutTimestamps: number[] = [];
      const regex = /pts_time:([0-9.]+)/g;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(stdout)) !== null) {
        const ts = parseFloat(match[1]);
        if (!isNaN(ts)) {
          // Avoid duplicate triggers within 0.3s of each other
          if (cutTimestamps.length === 0 || ts - cutTimestamps[cutTimestamps.length - 1] >= 0.3) {
            cutTimestamps.push(parseFloat(ts.toFixed(2)));
          }
        }
      }

      // Calculate scenes count and average pacing strictly from detected cuts
      let scenesCount: number;
      let avgPacing: number;

      if (cutTimestamps.length === 0) {
        // Continuous single scene without detected cut transitions
        scenesCount = 1;
        avgPacing = dur;
      } else {
        scenesCount = cutTimestamps.length + 1;
        const sceneDurations: number[] = [];
        let prev = 0;
        for (const cut of cutTimestamps) {
          sceneDurations.push(Math.max(0.1, cut - prev));
          prev = cut;
        }
        sceneDurations.push(Math.max(0.1, dur - prev));
        const totalPacing = sceneDurations.reduce((sum, d) => sum + d, 0);
        avgPacing = totalPacing / sceneDurations.length;
      }

      // Pacing and cut transitions are measured signals, but do not independently prove a slideshow.
      // The current pipeline does not perform slide OCR or template analysis, so slideshow classification is not asserted.
      const hasSlideshowPattern = false;
      const repeatedFootageSegments: VideoAnalysisResult['repeatedFootageSegments'] = [];
      const templateRepetitions: VideoAnalysisResult['templateRepetitions'] = [];

      return {
        scenesCount,
        framesSampled: framesCount,
        hasSlideshowPattern,
        repeatedFootageSegments,
        templateRepetitions,
        averagePacingSeconds: parseFloat(avgPacing.toFixed(1)),
        tempFramesDir: tempDir,
        slideshowAnalysisStatus: 'NOT_ASSESSED',
        repeatedFootageStatus: 'NOT_ASSESSED'
      };
    } catch (err: any) {
      // Ensure temp directory is cleaned up immediately on error to avoid disk leak
      await this.cleanupFrames(tempDir);
      if (err instanceof VideoProcessingError) {
        throw err;
      }
      throw new VideoProcessingError(
        `Video scene analysis failed: ${err?.message || 'FFmpeg process error'}`
      );
    }
  }

  /**
   * Cleans up extracted frames directory after job completes or fails
   */
  public async cleanupFrames(framesDir: string): Promise<void> {
    try {
      if (fs.existsSync(framesDir)) {
        await fs.promises.rm(framesDir, { recursive: true, force: true });
      }
    } catch (err) {
      console.warn('[VideoProcessor] Failed to clean temp frames:', err);
    }
  }
}

export const videoProcessor = new VideoProcessor();
