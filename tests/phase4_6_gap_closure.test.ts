import assert from 'assert';
import path from 'path';
import fs from 'fs';
import { promisify } from 'util';
import { execFile } from 'child_process';
import { thumbnailInspector, ThumbnailOcrAdapter } from '../src/server/pipeline/thumbnailInspector';
import { videoProcessor } from '../src/server/pipeline/videoProcessor';
import { audioProcessor, SpeechTranscriptionAdapter } from '../src/server/pipeline/audioProcessor';
import { policyIntelligenceEngine } from '../src/server/intelligence/policyIntelligence';
import { MediaMetadata } from '../src/types';

const execFileAsync = promisify(execFile);

export async function runPhase456VerificationTests() {
  console.log('\n======================================================');
  console.log('--- PHASE 4–6 INTELLIGENCE GAP CLOSURE VERIFICATION ---');
  console.log('Real OCR TSV Engine, Full-Video OCR, Whisper STT Contract & Timeline Integration');
  console.log('======================================================\n');

  const testDir = path.resolve(process.cwd(), 'uploads', 'test_phase456_' + Date.now());
  if (!fs.existsSync(testDir)) {
    fs.mkdirSync(testDir, { recursive: true });
  }

  const generatedFiles: string[] = [];
  const cleanup = () => {
    for (const f of generatedFiles) {
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch {}
    }
    try {
      if (fs.existsSync(testDir)) fs.rmdirSync(testDir);
    } catch {}
  };

  try {
    // -------------------------------------------------------------------------
    // 1. THUMBNAIL OCR: GENUINE CONFIDENCE & BOUNDING BOX EXTRACTION
    // -------------------------------------------------------------------------
    console.log('[1. Thumbnail OCR Genuine Confidence & TSV Bounding Boxes]');

    const testImgPath = path.resolve(testDir, 'thumb_with_text.png');
    await execFileAsync('ffmpeg', [
      '-y',
      '-f', 'lavfi',
      '-i', "color=c=black:s=640x360:d=1,drawtext=text='VIDEORISK TEST':fontsize=40:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2",
      '-vframes', '1',
      testImgPath
    ]);
    generatedFiles.push(testImgPath);

    // Test with TESSERACT_PATH set to installed tesseract
    process.env.TESSERACT_PATH = '/usr/bin/tesseract';
    const ocrAdapter = new ThumbnailOcrAdapter();
    const ocrRes = await ocrAdapter.extractText(testImgPath, 640, 360);

    assert.strictEqual(ocrRes.status, 'DETECTED', '1.1 OCR detects text on synthetic image');
    assert.ok(ocrRes.extractedText?.includes('VIDEORISK') || ocrRes.extractedText?.includes('TEST'), '1.2 OCR extracts valid text token');
    assert.ok(ocrRes.confidence > 0 && ocrRes.confidence <= 1.0, `1.3 Confidence must be genuine engine output (got ${ocrRes.confidence})`);
    assert.notStrictEqual(ocrRes.confidence, 0.88, '1.4 Confidence must NOT be hardcoded 0.88');
    assert.notStrictEqual(ocrRes.confidence, 0.90, '1.5 Confidence must NOT be hardcoded 0.90');
    assert.ok(Array.isArray(ocrRes.boundingBoxes) && ocrRes.boundingBoxes.length > 0, '1.6 Genuine bounding boxes extracted');
    const firstBox = ocrRes.boundingBoxes![0];
    assert.ok(firstBox.width > 0 && firstBox.height > 0, '1.7 Bounding box has measurable width and height');
    assert.ok(firstBox.confidence > 0, '1.8 Bounding box has individual word confidence');

    // Negative control: Blank image with no text
    const blankImgPath = path.resolve(testDir, 'thumb_blank.png');
    await execFileAsync('ffmpeg', [
      '-y',
      '-f', 'lavfi',
      '-i', 'color=c=navy:s=640x360:d=1',
      '-vframes', '1',
      blankImgPath
    ]);
    generatedFiles.push(blankImgPath);

    const blankOcrRes = await ocrAdapter.extractText(blankImgPath, 640, 360);
    assert.strictEqual(blankOcrRes.status, 'NO_SIGNAL_DETECTED', '1.9 Blank image returns NO_SIGNAL_DETECTED');
    assert.strictEqual(blankOcrRes.extractedText, '', '1.10 Blank image extracted text is empty string');
    assert.strictEqual(blankOcrRes.confidence, 0, '1.11 Blank image confidence is 0 (not fabricated 0.90)');

    delete process.env.TESSERACT_PATH;
    console.log('  ✅ PASS: Thumbnail OCR genuine TSV confidence, bounding boxes & negative control verified');

    // -------------------------------------------------------------------------
    // 2. FULL-VIDEO OCR PIPELINE (PHASE 4.3)
    // -------------------------------------------------------------------------
    console.log('\n[2. Full-Video OCR Implementation & Bounded Execution]');

    // Video 1: 3 seconds with text overlay appearing at 1.0s
    const textVideoPath = path.resolve(testDir, 'video_with_ocr.mp4');
    await execFileAsync('ffmpeg', [
      '-y',
      '-f', 'lavfi',
      '-i', "testsrc=size=320x240:rate=10:duration=3,drawtext=text='SCENE TEXT':fontsize=32:fontcolor=yellow:x=(w-text_w)/2:y=(h-text_h)/2:enable='between(t,0.5,2.5)'",
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      textVideoPath
    ]);
    generatedFiles.push(textVideoPath);

    const mockVideoMeta: MediaMetadata = {
      filename: 'video_with_ocr.mp4',
      originalSize: 100000,
      durationSeconds: 3.0,
      width: 320,
      height: 240,
      resolutionLabel: '240p',
      fps: 10,
      hasAudio: false,
      videoCodec: 'h264',
      isProxyUsed: false
    };

    // Unconfigured state returns NOT_ASSESSED
    delete process.env.TESSERACT_PATH;
    const unconfVideoOcr = await videoProcessor.performVideoOcr(textVideoPath, mockVideoMeta);
    assert.strictEqual(unconfVideoOcr.status, 'NOT_ASSESSED', '2.1 Unconfigured Video OCR returns NOT_ASSESSED');

    // Configured execution returns DETECTED with frames and bounding boxes
    process.env.TESSERACT_PATH = '/usr/bin/tesseract';
    const videoOcrRes = await videoProcessor.performVideoOcr(textVideoPath, mockVideoMeta, {
      maxFrames: 5,
      sampleIntervalSeconds: 1
    });

    assert.strictEqual(videoOcrRes.status, 'DETECTED', '2.2 Video OCR detects on-screen visual text');
    assert.ok(videoOcrRes.framesInspected > 0, '2.3 Video OCR inspected candidate frames');
    assert.ok(videoOcrRes.coverageRatio > 0, '2.4 Coverage ratio is mathematically computed');
    assert.ok(videoOcrRes.detectedFrames.length > 0, '2.5 Detected frames contains timestamped items');
    const firstFrameOcr = videoOcrRes.detectedFrames[0];
    assert.ok(Number.isFinite(firstFrameOcr.timestamp), '2.6 Detected frame has valid numeric timestamp');
    assert.ok(firstFrameOcr.boundingBoxes.length > 0, '2.7 Frame OCR contains bounding boxes');
    assert.ok(typeof firstFrameOcr.confidence === 'number' && firstFrameOcr.confidence > 0, '2.8 Frame OCR confidence is genuine engine output');

    // Video 2: Video without text
    const noTextVideoPath = path.resolve(testDir, 'video_no_text.mp4');
    await execFileAsync('ffmpeg', [
      '-y',
      '-f', 'lavfi',
      '-i', 'color=c=darkgreen:s=320x240:d=2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      noTextVideoPath
    ]);
    generatedFiles.push(noTextVideoPath);

    const mockNoTextMeta: MediaMetadata = { ...mockVideoMeta, durationSeconds: 2.0 };
    const noTextOcrRes = await videoProcessor.performVideoOcr(noTextVideoPath, mockNoTextMeta);
    assert.strictEqual(noTextOcrRes.status, 'NO_SIGNAL_DETECTED', '2.9 Video without text returns NO_SIGNAL_DETECTED');
    assert.strictEqual(noTextOcrRes.detectedFrames.length, 0, '2.10 Zero frames detected for text-free video');

    delete process.env.TESSERACT_PATH;
    console.log('  ✅ PASS: Full-video OCR extraction, timestamp association, and negative controls verified');

    // -------------------------------------------------------------------------
    // 3. WHISPER LOCAL STT ADAPTER CLI CONTRACT & BOUNDED EXECUTION
    // -------------------------------------------------------------------------
    console.log('\n[3. Whisper Local STT Adapter Contract & Bounded Execution]');

    const sttAdapter = new SpeechTranscriptionAdapter();

    // 3.1 Verify missing runtime reports NOT_ASSESSED
    delete process.env.WHISPER_PATH;
    delete process.env.LOCAL_STT_PATH;
    const missingRuntime = await sttAdapter.transcribe(textVideoPath, 3.0);
    assert.strictEqual(missingRuntime.status, 'NOT_ASSESSED', '3.1 Missing runtime returns NOT_ASSESSED');
    assert.ok(missingRuntime.limitations.includes('WHISPER_PATH'), '3.2 Missing runtime documents configuration parameter');

    // 3.2 Verify invalid path reports ANALYSIS_UNAVAILABLE
    process.env.WHISPER_PATH = '/usr/bin/nonexistent_whisper_binary';
    const invalidPath = await sttAdapter.transcribe(textVideoPath, 3.0);
    assert.strictEqual(invalidPath.status, 'ANALYSIS_UNAVAILABLE', '3.3 Invalid path returns ANALYSIS_UNAVAILABLE');
    assert.ok(Boolean(invalidPath.failureReason), '3.4 Failure reason documented on invalid path');
    delete process.env.WHISPER_PATH;

    // 3.3 Verify mock CLI wrapper supporting genuine JSON contract with timestamps
    const mockWhisperScript = path.resolve(testDir, 'whisper_cli_runner.sh');
    fs.writeFileSync(mockWhisperScript, `#!/bin/sh
if [ "$1" = "--help" ] || [ "$1" = "--version" ]; then
  echo "usage: whisper [-h] [--model MODEL] [--output_format {txt,vtt,srt,tsv,json,all}]"
  exit 0
fi
cat << 'EOF'
{
  "text": "Hello world from Whisper STT",
  "segments": [
    {"start": 0.5, "end": 2.2, "text": "Hello world from Whisper STT", "confidence": 0.94}
  ]
}
EOF
`, { mode: 0o755 });
    generatedFiles.push(mockWhisperScript);

    process.env.WHISPER_PATH = mockWhisperScript;
    const sttSuccess = await sttAdapter.transcribe(textVideoPath, 3.0);
    assert.strictEqual(sttSuccess.status, 'DETECTED', '3.5 Valid CLI JSON output returns DETECTED');
    assert.strictEqual(sttSuccess.transcriptText, 'Hello world from Whisper STT', '3.6 Text transcribed accurately');
    assert.strictEqual(sttSuccess.segments?.length, 1, '3.7 Segments array preserved');
    assert.strictEqual(sttSuccess.segments?.[0].start, 0.5, '3.8 Segment start timestamp preserved');
    assert.strictEqual(sttSuccess.segments?.[0].end, 2.2, '3.9 Segment end timestamp preserved');

    delete process.env.WHISPER_PATH;
    console.log('  ✅ PASS: Whisper STT CLI contract, timestamps, and missing-tool isolation verified');

    // -------------------------------------------------------------------------
    // 4. EVIDENCE TIMELINE INTEGRATION & POLICY INTELLIGENCE
    // -------------------------------------------------------------------------
    console.log('\n[4. Evidence Timeline & Detector Contract Integration]');

    const mockVideoResult: any = {
      scenesCount: 2,
      framesSampled: 10,
      hasSlideshowPattern: false,
      repeatedFootageSegments: [],
      templateRepetitions: [],
      averagePacingSeconds: 1.5,
      tempFramesDir: testDir,
      videoOcr: videoOcrRes // Attach real OCR result
    };

    const mockAudioResult: any = {
      hasVoiceover: false,
      voiceoverRatio: 0,
      silenceRatio: 0,
      hasMusicDetected: null,
      segments: [],
      transcriptSummary: 'Audio inspected.',
      detectors: {}
    };

    const timeline = policyIntelligenceEngine.generateEvidenceTimeline({
      scanId: 'scan_phase456_test',
      metadata: mockVideoMeta,
      scanMode: 'standard',
      audioResult: mockAudioResult,
      videoResult: mockVideoResult,
      videoTitle: 'Test Video with On-Screen Text',
      videoDescription: 'Description',
      videoTags: ['test'],
      thumbnailProvided: false
    });

    const ocrEvidenceItems = timeline.filter(ev => ev.type === 'video_text_overlay');
    assert.ok(ocrEvidenceItems.length > 0, '4.1 Video text overlay evidence successfully created on timeline');
    const firstOcrEv = ocrEvidenceItems[0];
    assert.strictEqual(firstOcrEv.domain, 'video_audio', '4.2 Domain is video_audio');
    assert.strictEqual(firstOcrEv.provenance, 'tesseract_ocr:full_video_frame', '4.3 Provenance is tesseract_ocr');
    assert.strictEqual(firstOcrEv.source, 'video_frame_ocr', '4.4 Source is video_frame_ocr');
    assert.ok(firstOcrEv.details.includes('Confidence'), '4.5 Details include genuine engine confidence');

    console.log('  ✅ PASS: Timeline evidence integration & provenance verification complete');
    console.log('\n======================================================');
    console.log('🎉 ALL PHASE 4–6 GAP CLOSURE VERIFICATIONS PASSED!');
    console.log('======================================================\n');
  } finally {
    cleanup();
  }
}

if (process.argv[1]?.includes('phase4_6_gap_closure.test.ts')) {
  runPhase456VerificationTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌ PHASE 4–6 TEST FAILED:', err);
      process.exit(1);
    });
}

