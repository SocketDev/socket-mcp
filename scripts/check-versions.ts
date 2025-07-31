#!/usr/bin/env node

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

interface PackageJson {
  version: string;
  [key: string]: any;
}

interface ManifestJson {
  version: string;
  [key: string]: any;
}

function readJsonFile<T>(filePath: string): T {
  try {
    const content = readFileSync(filePath, 'utf8');
    return JSON.parse(content) as T;
  } catch (error) {
    console.error(`Error reading ${filePath}:`, (error as Error).message);
    process.exit(1);
  }
}

function main(): void {
  console.log('Checking version consistency between package.json and manifest.json...');
  
  const packageJsonPath = join(projectRoot, 'package.json');
  const manifestJsonPath = join(projectRoot, 'manifest.json');
  
  const packageJson = readJsonFile<PackageJson>(packageJsonPath);
  const manifestJson = readJsonFile<ManifestJson>(manifestJsonPath);
  
  const packageVersion = packageJson.version;
  const manifestVersion = manifestJson.version;
  
  console.log(`package.json version: ${packageVersion}`);
  console.log(`manifest.json version: ${manifestVersion}`);
  
  if (packageVersion === manifestVersion) {
    console.log('✅ Versions match!');
    process.exit(0);
  } else {
    console.error('❌ Version mismatch detected!');
    console.error(`Expected both files to have the same version, but found:`);
    console.error(`  package.json: ${packageVersion}`);
    console.error(`  manifest.json: ${manifestVersion}`);
    console.error('Please update both files to have matching versions.');
    process.exit(1);
  }
}

main();
