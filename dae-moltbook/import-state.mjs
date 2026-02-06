#!/usr/bin/env node
// Import a DAE state export (from the browser UI) into the server agent's state directory.
// Usage: node import-state.mjs <path-to-export.json>

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { DAESystem } from './dae-core.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const stateDir = process.env.DAE_STATE_DIR || join(__dirname, '.dae-state');

const inputPath = process.argv[2];
if (!inputPath) {
    console.error('Usage: node import-state.mjs <path-to-dae-export.json>');
    process.exit(1);
}

if (!existsSync(inputPath)) {
    console.error(`File not found: ${inputPath}`);
    process.exit(1);
}

try {
    const raw = readFileSync(inputPath, 'utf-8');
    const data = JSON.parse(raw);

    // Validate it's a DAE state export
    if (!data.system?.episodes && !data.system?.consciousEpisode) {
        console.error('Not a valid DAE state export (missing system.episodes or system.consciousEpisode)');
        process.exit(1);
    }

    // Test deserialization
    const system = DAESystem.fromJSON(data.system);

    console.log(`Import validated:`);
    console.log(`  Version: ${data.version || 'unknown'}`);
    console.log(`  Exported: ${data.timestamp || 'unknown'}`);
    console.log(`  N: ${system.N}`);
    console.log(`  Episodes: ${system.episodes.length}`);
    console.log(`  Conscious neighborhoods: ${system.consciousEpisode.neighborhoods.length}`);
    console.log(`  Agent name: ${system.agentName || 'DAE'}`);

    // Write to state directory
    if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });

    const stateFile = join(stateDir, 'dae-state.json');
    const state = {
        version: data.version || '0.7.2',
        timestamp: new Date().toISOString(),
        system: data.system,
        conversationHistory: data.conversationHistory || [],
        conversationBuffer: data.conversationBuffer || [],
    };
    writeFileSync(stateFile, JSON.stringify(state));

    const metaFile = join(stateDir, 'meta.json');
    writeFileSync(metaFile, JSON.stringify({
        lastPollTime: null,
        totalExchanges: 0,
        pollCount: 0,
        importedFrom: inputPath,
        importedAt: new Date().toISOString(),
    }));

    console.log(`\nState written to ${stateDir}/`);
    console.log('Ready to run: npm start');

} catch (e) {
    console.error('Import failed:', e.message);
    process.exit(1);
}
