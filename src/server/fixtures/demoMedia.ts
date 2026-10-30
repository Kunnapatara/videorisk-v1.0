import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const DEMO_FIXTURES_DIR = path.resolve(process.cwd(), 'src/server/fixtures/demo');

export interface DemoFixturePaths {
  videoPath: string;
  videoFilename: string;
  thumbnailPath: string;
  thumbnailFilename: string;
}

/**
 * Ensures deterministic, valid sample video & thumbnail assets are present locally.
 * Generates genuine media containers via ffmpeg/lavfi if not already present.
 */
export async function ensureDemoFixtures(): Promise<void> {
  if (!fs.existsSync(DEMO_FIXTURES_DIR)) {
    fs.mkdirSync(DEMO_FIXTURES_DIR, { recursive: true });
  }

  const problematicPath = path.join(DEMO_FIXTURES_DIR, 'sample_demo_problematic.mp4');
  const revisedPath = path.join(DEMO_FIXTURES_DIR, 'sample_demo_revised.mp4');
  const thumbPath = path.join(DEMO_FIXTURES_DIR, 'sample_demo_thumbnail.jpg');

  if (!fs.existsSync(problematicPath)) {
    await execFileAsync('ffmpeg', [
      '-y',
      '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=10',
      '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-shortest',
      problematicPath
    ]);
  }

  if (!fs.existsSync(revisedPath)) {
    await execFileAsync('ffmpeg', [
      '-y',
      '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=10',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-shortest',
      revisedPath
    ]);
  }

  if (!fs.existsSync(thumbPath)) {
    await execFileAsync('ffmpeg', [
      '-y',
      '-f', 'lavfi', '-i', 'color=c=blue:s=1280x720:d=1',
      '-vframes', '1',
      thumbPath
    ]);
  }
}

export function getDemoFixture(type: 'problematic' | 'revised'): DemoFixturePaths {
  const isRevised = type === 'revised';
  const videoFilename = isRevised 
    ? 'Clean_Cut_Creator_Commentary_Final.mp4' 
    : 'Top10_Gaming_Montage_With_Clips.mp4';
  const fixtureFilename = isRevised 
    ? 'sample_demo_revised.mp4' 
    : 'sample_demo_problematic.mp4';

  return {
    videoPath: path.join(DEMO_FIXTURES_DIR, fixtureFilename),
    videoFilename,
    thumbnailPath: path.join(DEMO_FIXTURES_DIR, 'sample_demo_thumbnail.jpg'),
    thumbnailFilename: 'demo_thumbnail_16x9.jpg'
  };
}
