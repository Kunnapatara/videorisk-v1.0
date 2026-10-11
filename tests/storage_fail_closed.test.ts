import fs from 'fs';
import path from 'path';
import os from 'os';
import { InMemoryStorageRepository } from '../src/server/storage';

export async function runStorageFailClosedTests() {
  console.log('\n======================================================');
  console.log('--- TEST SUITE: STORAGE PERSISTENCE FAIL-CLOSED ---');
  console.log('======================================================\n');

  let passed = 0;
  let total = 0;

  function assert(condition: boolean, desc: string) {
    total++;
    if (condition) {
      console.log(`  ✅ PASS: ${desc}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${desc}`);
      throw new Error(`Test assertion failed: ${desc}`);
    }
  }

  // Helper to get temp file path
  const createTempFilePath = () => path.join(os.tmpdir(), `videorisk_test_store_${Date.now()}_${Math.random().toString(36).substring(7)}.json`);

  // Test 1: Malformed JSON causes repository construction to throw
  {
    const tempFile = createTempFilePath();
    const malformedContent = '{"users": {"incomplete":';
    fs.writeFileSync(tempFile, malformedContent, 'utf-8');

    try {
      let threw = false;
      let errorMsg = '';
      try {
        new InMemoryStorageRepository(tempFile);
      } catch (err: any) {
        threw = true;
        errorMsg = err.message;
      }
      assert(threw, 'Malformed JSON file causes repository construction to throw');
      assert(errorMsg.includes('malformed JSON'), 'Error message specifically identifies malformed JSON');

      // Contents remain byte-for-byte unchanged
      const currentContent = fs.readFileSync(tempFile, 'utf-8');
      assert(currentContent === malformedContent, 'Damaged file contents remain byte-for-byte unchanged (no overwrite)');
    } finally {
      if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    }
  }

  // Test 2: JSON array root causes repository construction to throw
  {
    const tempFile = createTempFilePath();
    const arrayContent = '[{"unexpected": "array_root"}]';
    fs.writeFileSync(tempFile, arrayContent, 'utf-8');

    try {
      let threw = false;
      let errorMsg = '';
      try {
        new InMemoryStorageRepository(tempFile);
      } catch (err: any) {
        threw = true;
        errorMsg = err.message;
      }
      assert(threw, 'JSON array root causes repository construction to throw');
      assert(errorMsg.includes('invalid root structure'), 'Error message specifically identifies invalid root structure');

      // Contents remain byte-for-byte unchanged
      const currentContent = fs.readFileSync(tempFile, 'utf-8');
      assert(currentContent === arrayContent, 'Array-root file contents remain byte-for-byte unchanged (no overwrite)');
    } finally {
      if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    }
  }

  // Test 3: Missing storage file allows normal first-time initialization
  {
    const tempFile = createTempFilePath();
    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);

    try {
      let repo: InMemoryStorageRepository | null = null;
      let threw = false;
      try {
        repo = new InMemoryStorageRepository(tempFile);
      } catch {
        threw = true;
      }
      assert(!threw, 'Missing storage file permits normal first-time initialization without throwing');
      assert(repo !== null, 'Repository instance is successfully created on missing file');
    } finally {
      if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    }
  }

  // Test 4: Valid existing storage file loads successfully and preserves stored data
  {
    const tempFile = createTempFilePath();
    const validData = {
      users: {
        usr_test_1: {
          id: 'usr_test_1',
          email: 'saved@example.com',
          plan: 'pro',
          creditsRemaining: 45,
          creditsUsedTotal: 5,
          totalScansCount: 2,
          createdAt: new Date().toISOString()
        }
      },
      sessions: {},
      uploads: {},
      channelProfiles: {},
      scans: {},
      reports: {},
      evidence: {},
      comparisons: {},
      usage: [],
      webhookEvents: {},
      subscriptions: {}
    };
    fs.writeFileSync(tempFile, JSON.stringify(validData, null, 2), 'utf-8');

    try {
      const repo = new InMemoryStorageRepository(tempFile);
      const loadedUser = await repo.users.getUser('usr_test_1');
      assert(loadedUser !== null && loadedUser !== undefined, 'Valid existing storage file loads successfully');
      assert(loadedUser?.email === 'saved@example.com', 'Preserved user email matches saved data');
      assert(loadedUser?.creditsRemaining === 45, 'Preserved user credits match saved data');
    } finally {
      if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    }
  }

  console.log(`\n======================================================`);
  console.log(`STORAGE FAIL-CLOSED SUITE COMPLETE: ${passed}/${total} assertions passed!`);
  console.log(`======================================================\n`);
}
