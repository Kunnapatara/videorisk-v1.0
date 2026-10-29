import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import { 
  MediaMetadata, 
  ScanMode, 
  DomainAssessmentStatus, 
  DetectorExecutionStatus,
  DetectorReport 
} from '../../types';

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
  /**
   * Repeated footage segments identified within the video stream.
   * Interval Convention:
   * - `start` and `end`: The timestamp interval of the later (repeated) occurrence.
   * - `matchWithTimestamp` and `matchWithEndTimestamp`: The timestamp interval of the earlier (original anchor) occurrence.
   * Both intervals are ordered and bounded within [0, durationSeconds].
   */
  repeatedFootageSegments: Array<{ 
    start: number; 
    end: number; 
    matchWithTimestamp: number; 
    matchWithEndTimestamp?: number;
    similarity: number; 
    confidence: number;
  }>;
  templateRepetitions: Array<{ 
    start: number; 
    end: number; 
    pattern: string;
    similarity?: number;
  }>;
  averagePacingSeconds: number;
  tempFramesDir: string;
  sampledIntervals?: Array<{ start: number; end: number }>;
  slideshowAnalysisStatus?: DetectorExecutionStatus | DomainAssessmentStatus;
  repeatedFootageStatus?: DetectorExecutionStatus | DomainAssessmentStatus;
  templateAnalysisStatus?: DetectorExecutionStatus | DomainAssessmentStatus;
  detectors?: Record<string, DetectorReport>;
}

export class VideoProcessor {
  /**
   * Samples visual frames and performs:
   * 1. Scene cut transition detection via FFmpeg gt(scene,0.3)
   * 2. Perceptual frame fingerprinting (8x8 grayscale block comparison)
   * 3. Non-adjacent within-video repeated footage detection
   * 4. Intra-scene static frame invariance (slideshow heuristic)
   * 5. Structural template repetition analysis
   */
  public async analyzeVideo(
    videoPath: string, 
    metadata: MediaMetadata, 
    scanMode: ScanMode
  ): Promise<VideoAnalysisResult> {
    const startTime = Date.now();

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
        repeatedFootageStatus: 'NOT_PROVIDED',
        templateAnalysisStatus: 'NOT_PROVIDED',
        detectors: {
          video_scene_cut: {
            detectorName: 'ffmpeg_scene_select',
            version: '1.0.0',
            status: 'NOT_PROVIDED',
            executionDurationMs: 0,
            limitations: 'No video stream present in container.'
          },
          video_repeated_footage: {
            detectorName: 'perceptual_hash_comparator',
            version: '1.0.0',
            status: 'NOT_PROVIDED',
            executionDurationMs: 0,
            limitations: 'No video stream present in container.'
          }
        }
      };
    }

    const dur = Math.max(0.1, metadata.durationSeconds || 0.1);
    const uniqueJobSubdir = `job_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const tempDir = path.resolve(process.cwd(), 'uploads', 'frames', uniqueJobSubdir);
    
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    // Sampling parameters: sample 1 fps for short videos (<= 30s) to reliably capture cut transitions and repetitions
    const targetSamples = scanMode === 'deep' ? 120 : 60;
    const sampleInterval = dur <= 30
      ? 1
      : Math.max(1, parseFloat((dur / Math.min(targetSamples, Math.ceil(dur / 2))).toFixed(2)));
    const expectedSamples = Math.min(targetSamples, Math.max(1, Math.ceil(dur / sampleInterval)));

    try {
      // 1. Extract sampled visual preview JPEG frames for disk evidence
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

      // 2. Extract 8x8 raw RGB bytes for perceptual similarity and repetition analysis
      // 8x8 rawvideo in rgb24 produces 192 bytes per sampled frame
      const bytesPerFrame = 192;
      const rawSampleArgs = [
        '-y',
        '-i', videoPath,
        '-vf', `fps=1/${sampleInterval},scale=8:8,format=rgb24`,
        '-vframes', String(expectedSamples),
        '-f', 'rawvideo',
        '-'
      ];

      let rawFramesBuffer: Buffer = Buffer.alloc(0);
      try {
        const rawRes = await execFileAsync('ffmpeg', rawSampleArgs, { 
          encoding: 'buffer', 
          maxBuffer: 10 * 1024 * 1024,
          timeout: 45000 
        });
        rawFramesBuffer = rawRes.stdout as unknown as Buffer;
      } catch (err: any) {
        throw new VideoProcessingError(`Failed to extract perceptual frame stream: ${err?.message || err}`);
      }

      const totalRawFrames = Math.floor(rawFramesBuffer.length / bytesPerFrame);

      // 3. Measure scene cut transitions via FFmpeg select gt(scene,0.3)
      const sceneDetectStart = Date.now();
      const sceneArgs = [
        '-y',
        '-i', videoPath,
        '-vf', "scale='min(320,iw)':-2,select='gt(scene,0.3)',metadata=print:file=-",
        '-f', 'null',
        '-'
      ];

      const { stdout: sceneStdout } = await execFileAsync('ffmpeg', sceneArgs, { timeout: 45000 });
      const sceneDetectMs = Date.now() - sceneDetectStart;

      // Parse detected scene cut timestamps
      const cutTimestamps: number[] = [];
      const regex = /pts_time:([0-9.]+)/g;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(sceneStdout)) !== null) {
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

      // 4. Repeated Footage Detection via Perceptual Frame Comparison
      // Compare non-adjacent frames to find within-video repeated visual material
      const repetitionStart = Date.now();
      const repeatedFootageSegments: VideoAnalysisResult['repeatedFootageSegments'] = [];
      const templateRepetitions: VideoAnalysisResult['templateRepetitions'] = [];
      const sampledIntervals: Array<{ start: number; end: number }> = [];

      for (let i = 0; i < totalRawFrames; i++) {
        const sTime = Math.min(dur, parseFloat((i * sampleInterval).toFixed(2)));
        const eTime = Math.min(dur, parseFloat(((i + 1) * sampleInterval).toFixed(2)));
        sampledIntervals.push({ start: sTime, end: eTime });
      }

      // Precompute per-frame luminance grid (8x8 = 64 pixels), statistics, and gradient dHash bits
      interface FrameSignature {
        index: number;
        offset: number;
        luminance: Float32Array; // 64 values
        meanY: number;
        varY: number;
        stdDevY: number;
        meanR: number;
        meanG: number;
        meanB: number;
        hGradients: boolean[]; // 56 horizontal bits
        vGradients: boolean[]; // 56 vertical bits
      }

      const frameSignatures: FrameSignature[] = [];
      for (let i = 0; i < totalRawFrames; i++) {
        const off = i * bytesPerFrame;
        const lum = new Float32Array(64);
        let sumY = 0;
        let sumR = 0;
        let sumG = 0;
        let sumB = 0;

        for (let p = 0; p < 64; p++) {
          const r = rawFramesBuffer[off + p * 3];
          const g = rawFramesBuffer[off + p * 3 + 1];
          const b = rawFramesBuffer[off + p * 3 + 2];
          sumR += r;
          sumG += g;
          sumB += b;
          const y = 0.299 * r + 0.587 * g + 0.114 * b;
          lum[p] = y;
          sumY += y;
        }

        const meanY = sumY / 64;
        let sumSqY = 0;
        for (let p = 0; p < 64; p++) {
          const dy = lum[p] - meanY;
          sumSqY += dy * dy;
        }
        const varY = sumSqY / 64;
        const stdDevY = Math.sqrt(varY);

        // 56 horizontal gradient comparisons: Y(x+1, y) > Y(x, y)
        const hGradients: boolean[] = [];
        for (let y = 0; y < 8; y++) {
          for (let x = 0; x < 7; x++) {
            hGradients.push(lum[y * 8 + x + 1] > lum[y * 8 + x]);
          }
        }

        // 56 vertical gradient comparisons: Y(x, y+1) > Y(x, y)
        const vGradients: boolean[] = [];
        for (let x = 0; x < 8; x++) {
          for (let y = 0; y < 7; y++) {
            vGradients.push(lum[(y + 1) * 8 + x] > lum[y * 8 + x]);
          }
        }

        frameSignatures.push({
          index: i,
          offset: off,
          luminance: lum,
          meanY,
          varY,
          stdDevY,
          meanR: sumR / 64,
          meanG: sumG / 64,
          meanB: sumB / 64,
          hGradients,
          vGradients
        });
      }

      // Compute comprehensive similarity between two frames:
      // Combines:
      // 1. Normalized zero-mean luminance cross-correlation (NCC) - invariant to overall brightness shifts
      // 2. Luminance gradient difference hash match ratio (dHash) - captures structural edge layout
      // 3. Color difference (Delta RGB) - rejects wildly disparate color palettes
      // 4. Raw pixel RMS similarity (for flat/solid scenes where gradient variance is near zero)
      const evaluateFramePair = (f1: FrameSignature, f2: FrameSignature): { isDuplicate: boolean; similarity: number } => {
        // Raw RMS similarity across 192 RGB bytes
        let sumSq = 0;
        for (let k = 0; k < bytesPerFrame; k++) {
          const diff = rawFramesBuffer[f1.offset + k] - rawFramesBuffer[f2.offset + k];
          sumSq += diff * diff;
        }
        const rms = Math.sqrt(sumSq / bytesPerFrame);
        const rawRmsSim = Math.max(0, 1 - (rms / 255));

        // Mean color difference normalized to [0, 1]
        const colorDiff = (
          Math.abs(f1.meanR - f2.meanR) +
          Math.abs(f1.meanG - f2.meanG) +
          Math.abs(f1.meanB - f2.meanB)
        ) / (3 * 255);
        const colorSim = Math.max(0, 1 - colorDiff);

        // Low texture / flat frames (standard deviation of luminance < 2.5)
        const isFlat1 = f1.stdDevY < 2.5;
        const isFlat2 = f2.stdDevY < 2.5;

        if (isFlat1 || isFlat2) {
          if (isFlat1 && isFlat2) {
            // Both frames are flat/solid. They only match if raw RMS color is nearly identical
            const isMatch = rawRmsSim >= 0.96;
            return { isDuplicate: isMatch, similarity: rawRmsSim };
          }
          // One flat, one textured: cannot be duplicate
          return { isDuplicate: false, similarity: Math.min(rawRmsSim, 0.70) };
        }

        // Textured frames: compute normalized cross-correlation (NCC)
        let nccSum = 0;
        for (let p = 0; p < 64; p++) {
          nccSum += (f1.luminance[p] - f1.meanY) * (f2.luminance[p] - f2.meanY);
        }
        const ncc = nccSum / (64 * Math.max(0.1, f1.stdDevY * f2.stdDevY));

        // Compute gradient match ratio (112 bits)
        let gradMatches = 0;
        for (let b = 0; b < 56; b++) {
          if (f1.hGradients[b] === f2.hGradients[b]) gradMatches++;
          if (f1.vGradients[b] === f2.vGradients[b]) gradMatches++;
        }
        const gradMatchRatio = gradMatches / 112;

        // Composite structural similarity:
        // Weight: 50% NCC correlation, 30% gradient dHash, 20% color similarity
        const compositeSim = 0.50 * Math.max(0, ncc) + 0.30 * gradMatchRatio + 0.20 * colorSim;

        // Duplicate criteria for textured frames:
        // 1. High correlation (ncc >= 0.86)
        // 2. High gradient agreement (gradMatchRatio >= 0.85)
        // 3. Compatible color palette (colorDiff <= 0.22, accommodating lighting adjustments)
        const isDuplicate = ncc >= 0.86 && gradMatchRatio >= 0.85 && colorDiff <= 0.22;

        return {
          isDuplicate,
          similarity: parseFloat(Math.max(0, Math.min(1.0, isDuplicate ? Math.max(compositeSim, rawRmsSim) : compositeSim)).toFixed(3))
        };
      };

      // Intra-scene frame stability evaluation for slideshow heuristic
      let intraSceneFramePairs = 0;
      let intraSceneStaticPairs = 0;

      // Find non-adjacent visual matches
      // Two frames i and j are non-adjacent if separated by at least 2 intervening sample intervals or 2 seconds
      const minIndexGap = Math.max(2, Math.ceil(2.0 / sampleInterval));
      const rawMatches: Array<{ i: number; j: number; sim: number }> = [];

      for (let i = 0; i < totalRawFrames; i++) {
        const timeI = i * sampleInterval;

        // Check intra-scene continuity with adjacent frame i+1
        if (i + 1 < totalRawFrames) {
          const adjResult = evaluateFramePair(frameSignatures[i], frameSignatures[i + 1]);
          // If there is an abrupt visual transition (similarity < 0.85), it is a scene/slide boundary, not intra-scene
          if (adjResult.similarity >= 0.85) {
            intraSceneFramePairs++;
            // A static slide has near-zero movement: similarity >= 0.97
            if (adjResult.similarity >= 0.97) {
              intraSceneStaticPairs++;
            }
          }
        }

        // Compare against non-adjacent frames j > i
        for (let j = i + minIndexGap; j < totalRawFrames; j++) {
          const pairResult = evaluateFramePair(frameSignatures[i], frameSignatures[j]);

          // Near-duplicate threshold supported by structural evidence
          if (pairResult.isDuplicate) {
            // To be repeated footage (rather than an uninterrupted static long take),
            // there must be an intervening scene cut OR intervening distinct visual content
            const timeJ = j * sampleInterval;
            const hasInterveningCut = cutTimestamps.some(cut => cut > timeI + 0.1 && cut < timeJ - 0.1);
            let hasInterveningDifference = hasInterveningCut;
            if (!hasInterveningDifference) {
              for (let k = i + 1; k < j; k++) {
                const midResult = evaluateFramePair(frameSignatures[i], frameSignatures[k]);
                if (!midResult.isDuplicate || midResult.similarity < 0.88) {
                  hasInterveningDifference = true;
                  break;
                }
              }
            }

            if (hasInterveningDifference) {
              rawMatches.push({ i, j, sim: pairResult.similarity });
            }
          }
        }
      }

      // Merge contiguous repeated frame pairs into segments
      // e.g. (i, j), (i+1, j+1) -> segment [t_i, t_{i+1}] matching [t_j, t_{j+1}]
      const visitedPairs = new Set<string>();

      for (const m of rawMatches) {
        const pairKey = `${m.i}:${m.j}`;
        if (visitedPairs.has(pairKey)) continue;

        let startI = m.i;
        let endI = m.i;
        let startJ = m.j;
        let endJ = m.j;
        let totalSim = m.sim;
        let count = 1;
        visitedPairs.add(pairKey);

        // Extend forward
        let nextI = m.i + 1;
        let nextJ = m.j + 1;
        while (nextI < totalRawFrames && nextJ < totalRawFrames) {
          const nextKey = `${nextI}:${nextJ}`;
          const nextMatch = rawMatches.find(rm => rm.i === nextI && rm.j === nextJ);
          if (nextMatch) {
            endI = nextI;
            endJ = nextJ;
            totalSim += nextMatch.sim;
            count++;
            visitedPairs.add(nextKey);
            nextI++;
            nextJ++;
          } else {
            break;
          }
        }

        const tStart = Math.min(dur, parseFloat((startI * sampleInterval).toFixed(2)));
        const tEnd = Math.min(dur, parseFloat(((endI + 1) * sampleInterval).toFixed(2)));
        const matchTStart = Math.min(dur, parseFloat((startJ * sampleInterval).toFixed(2)));
        const matchTEnd = Math.min(dur, parseFloat(((endJ + 1) * sampleInterval).toFixed(2)));
        const avgSim = parseFloat((totalSim / count).toFixed(3));

        repeatedFootageSegments.push({
          start: matchTStart,
          end: Math.min(dur, Math.max(matchTStart + 0.1, matchTEnd)),
          matchWithTimestamp: tStart,
          matchWithEndTimestamp: tEnd,
          similarity: avgSim,
          confidence: parseFloat(Math.min(0.99, avgSim * 0.98).toFixed(2))
        });
      }

      // Consolidate overlapping repeated segments (keep maximal non-redundant spans)
      const consolidatedRepeats: VideoAnalysisResult['repeatedFootageSegments'] = [];
      const sortedByDuration = [...repeatedFootageSegments].sort((a, b) => (b.end - b.start) - (a.end - a.start));
      for (const seg of sortedByDuration) {
        const isRedundant = consolidatedRepeats.some(c => 
          seg.start >= c.start - 0.2 && seg.end <= c.end + 0.2
        );
        if (!isRedundant) {
          consolidatedRepeats.push(seg);
        }
      }
      consolidatedRepeats.sort((a, b) => a.start - b.start);

      // 5. Template Repetition Analysis
      // Detects recurring structural sequences (such as intro bumpers, outro cards, or chapter stings)
      // that appear at specific structural boundaries (e.g. near video start, video end, or across distinct scenes).
      // Distinct from general repeated footage (which may be b-roll or editing loops).
      if (consolidatedRepeats.length > 0 && scenesCount >= 2) {
        for (const seg of consolidatedRepeats) {
          const segDuration = seg.end - seg.start;
          if (segDuration >= 0.5 && segDuration <= 8.0) {
            // Check structural sequence position:
            // Intro: first occurrence is within first 25% of timeline or <= 5s
            // Outro / bumper: recurrence is near end (>= 75% or >= dur - 6s) or across separate scene cut boundaries
            const isNearStart = seg.matchWithTimestamp <= Math.max(5, dur * 0.25);
            const isNearEnd = seg.start >= Math.min(dur - 6, dur * 0.75);
            const alignsWithSceneCut = cutTimestamps.some(cut => Math.abs(cut - seg.start) < 1.0) ||
              cutTimestamps.some(cut => Math.abs(cut - seg.matchWithTimestamp) < 1.0);

            if ((isNearStart && isNearEnd) || alignsWithSceneCut) {
              templateRepetitions.push({
                start: seg.start,
                end: seg.end,
                pattern: (isNearStart && isNearEnd) ? 'recurring_intro_outro_template' : 'recurring_structural_bumper',
                similarity: seg.similarity
              });
            }
          }
        }
      }

      // 6. Slideshow Heuristic
      // Requirements for slideshow classification:
      // - Multiple distinct scene transitions (scenesCount >= 3)
      // - High proportion of intra-scene frames that are static (> 75%)
      // - Measured intra-scene frames count >= 3
      // - Average scene pacing between 1.5s and 12s
      // (Explicitly rejects single continuous static shot or dynamic cut videos)
      let hasSlideshowPattern = false;
      let slideshowStatus: DetectorExecutionStatus = 'NO_SIGNAL_DETECTED';

      if (dur < 3 || totalRawFrames < 3) {
        slideshowStatus = 'INSUFFICIENT_EVIDENCE';
      } else if (scenesCount >= 3 && intraSceneFramePairs >= 3) {
        const staticRatio = intraSceneStaticPairs / intraSceneFramePairs;
        if (staticRatio >= 0.75 && avgPacing >= 1.5 && avgPacing <= 12.0) {
          hasSlideshowPattern = true;
          slideshowStatus = 'DETECTED';
        } else {
          slideshowStatus = 'NO_SIGNAL_DETECTED';
        }
      } else {
        slideshowStatus = 'NO_SIGNAL_DETECTED';
      }

      const repeatedFootageStatus: DetectorExecutionStatus = totalRawFrames < 2 
        ? 'INSUFFICIENT_EVIDENCE' 
        : (consolidatedRepeats.length > 0 ? 'DETECTED' : 'NO_SIGNAL_DETECTED');

      const templateAnalysisStatus: DetectorExecutionStatus = totalRawFrames < 2
        ? 'INSUFFICIENT_EVIDENCE'
        : (templateRepetitions.length > 0 ? 'DETECTED' : 'NO_SIGNAL_DETECTED');

      const repetitionDurationMs = Date.now() - repetitionStart;
      const totalVideoAnalysisMs = Date.now() - startTime;

      const detectors: Record<string, DetectorReport> = {
        video_scene_cut: {
          detectorName: 'ffmpeg_scene_select',
          version: '1.0.0',
          status: 'DETECTED',
          executionDurationMs: sceneDetectMs,
          confidence: 0.90,
          limitations: 'Detects visual cut transitions based on luminance differences; does not classify semantic scene content.'
        },
        video_repeated_footage: {
          detectorName: 'perceptual_hash_comparator',
          version: '1.0.0',
          status: repeatedFootageStatus,
          executionDurationMs: repetitionDurationMs,
          confidence: consolidatedRepeats.length > 0 ? consolidatedRepeats[0].confidence : 0.92,
          limitations: 'Analyzes within-video non-adjacent frame repetition using 8x8 perceptual similarity; does not query external copyright or third-party databases.'
        },
        video_slideshow_heuristic: {
          detectorName: 'intra_scene_invariance_heuristic',
          version: '1.0.0',
          status: slideshowStatus,
          executionDurationMs: repetitionDurationMs,
          confidence: hasSlideshowPattern ? 0.85 : 0.90,
          limitations: 'Evaluates intra-scene stillness across multiple cuts. Panning slides, animated overlays, or talking heads may present ambiguous signals.'
        },
        video_template_heuristic: {
          detectorName: 'structural_template_comparator',
          version: '1.0.0',
          status: templateAnalysisStatus,
          executionDurationMs: repetitionDurationMs,
          confidence: templateRepetitions.length > 0 ? 0.84 : 0.88,
          limitations: 'Detects repeated short visual segments within the video container; does not evaluate cross-channel production templates.'
        }
      };

      return {
        scenesCount,
        framesSampled: framesCount,
        hasSlideshowPattern,
        repeatedFootageSegments: consolidatedRepeats,
        templateRepetitions,
        averagePacingSeconds: parseFloat(avgPacing.toFixed(1)),
        tempFramesDir: tempDir,
        sampledIntervals,
        slideshowAnalysisStatus: slideshowStatus,
        repeatedFootageStatus,
        templateAnalysisStatus,
        detectors
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
