#!/usr/bin/env node
// DAE Moltbook Agent — Persistent memory for autonomous AI agents
// Created by smaxforn
//
// Gives any Moltbook agent cross-conversation memory via the DAE manifold.
// State persists to disk. API keys never logged or exposed.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
    DAESystem, QueryEngine, Episode, Neighborhood,
    tokenize, ingestText, composeContext, extractSalient,
    DAE_SYSTEM_PROMPT
} from './dae-core.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================
// CLI ARGS
// ============================================================

const ARGS = {
    seed:         process.argv.includes('--seed'),
    seedSubmolts: (() => {
        const i = process.argv.indexOf('--seed-submolts');
        return i !== -1 && process.argv[i + 1]
            ? process.argv[i + 1].split(',').map(s => s.trim())
            : null;
    })(),
    seedPages:    (() => {
        const i = process.argv.indexOf('--seed-pages');
        return i !== -1 && process.argv[i + 1] ? parseInt(process.argv[i + 1]) : 5;
    })(),
};

// ============================================================
// CONFIGURATION — All secrets from environment only
// ============================================================

const CONFIG = {
    // Moltbook
    moltbookApiUrl:   process.env.MOLTBOOK_API_URL || 'https://www.moltbook.com/api/v1',
    moltbookApiKey:   process.env.MOLTBOOK_API_KEY,           // required
    agentName:        process.env.DAE_AGENT_NAME || 'dae-agent',

    // LLM backend (pick one)
    llmProvider:      process.env.LLM_PROVIDER || 'claude',   // claude | openai | grok | gemini
    llmApiKey:        process.env.LLM_API_KEY,                // required
    llmModel:         process.env.LLM_MODEL,                  // optional override

    // Behavior
    pollIntervalMs:   parseInt(process.env.POLL_INTERVAL_MS || '30000'),
    heartbeatEvery:   parseInt(process.env.HEARTBEAT_EVERY || '50'),   // every N polls
    episodeThreshold: parseInt(process.env.EPISODE_THRESHOLD || '5'),  // exchanges before episode
    conversationWindow: parseInt(process.env.CONVERSATION_WINDOW || '5'),
    stateDir:         process.env.DAE_STATE_DIR || join(__dirname, '.dae-state'),
    submolt:          process.env.MOLTBOOK_SUBMOLT || 'general',
    maxResponseLen:   parseInt(process.env.MAX_RESPONSE_LEN || '2000'),
};

// Default models per provider
const DEFAULT_MODELS = {
    claude: 'claude-sonnet-4-20250514',
    openai: 'gpt-4o',
    grok:   'grok-3',
    gemini: 'gemini-2.0-flash',
};

// ============================================================
// API KEY PROTECTION
// ============================================================

function redact(key) {
    if (!key || key.length < 8) return '***';
    return key.slice(0, 4) + '...' + key.slice(-4);
}

function validateConfig() {
    const missing = [];
    if (!CONFIG.moltbookApiKey) missing.push('MOLTBOOK_API_KEY');
    if (!ARGS.seed && !CONFIG.llmApiKey) missing.push('LLM_API_KEY');
    if (missing.length > 0) {
        console.error(`Missing required environment variables: ${missing.join(', ')}`);
        console.error('Copy .env.example to .env and fill in your keys.');
        process.exit(1);
    }
    if (!CONFIG.llmModel) {
        CONFIG.llmModel = DEFAULT_MODELS[CONFIG.llmProvider] || DEFAULT_MODELS.claude;
    }
    console.log(`Config validated:`);
    console.log(`  Mode: ${ARGS.seed ? 'SEED (read-only, no LLM)' : 'AGENT (read + respond)'}`);
    console.log(`  Agent: ${CONFIG.agentName}`);
    if (!ARGS.seed) console.log(`  LLM: ${CONFIG.llmProvider} (${CONFIG.llmModel})`);
    console.log(`  Moltbook key: ${redact(CONFIG.moltbookApiKey)}`);
    if (!ARGS.seed) console.log(`  LLM key: ${redact(CONFIG.llmApiKey)}`);
    console.log(`  Poll: ${CONFIG.pollIntervalMs}ms | Episodes at ${CONFIG.episodeThreshold} exchanges`);
}

// ============================================================
// STATE PERSISTENCE
// ============================================================

function stateFile() { return join(CONFIG.stateDir, 'dae-state.json'); }
function metaFile()  { return join(CONFIG.stateDir, 'meta.json'); }

function saveState(system, conversationHistory, conversationBuffer, meta) {
    if (!existsSync(CONFIG.stateDir)) mkdirSync(CONFIG.stateDir, { recursive: true });
    const state = {
        version: '0.7.2',
        timestamp: new Date().toISOString(),
        system: system.toJSON(),
        conversationHistory,
        conversationBuffer,
    };
    writeFileSync(stateFile(), JSON.stringify(state));
    writeFileSync(metaFile(), JSON.stringify(meta));
}

function loadState() {
    if (!existsSync(stateFile())) return null;
    try {
        const raw = readFileSync(stateFile(), 'utf-8');
        const data = JSON.parse(raw);
        const system = DAESystem.fromJSON(data.system);
        const meta = existsSync(metaFile()) ? JSON.parse(readFileSync(metaFile(), 'utf-8')) : {};
        return {
            system,
            conversationHistory: data.conversationHistory || [],
            conversationBuffer: data.conversationBuffer || [],
            meta,
        };
    } catch (e) {
        console.error('State load failed, starting fresh:', e.message);
        return null;
    }
}

// ============================================================
// LLM ADAPTERS — API key passed via header, never in URL or logs
// ============================================================

const LLM = {
    claude: {
        endpoint: 'https://api.anthropic.com/v1/messages',
        headers: () => ({
            'Content-Type': 'application/json',
            'x-api-key': CONFIG.llmApiKey,
            'anthropic-version': '2023-06-01',
        }),
        body: (messages, systemPrompt) => ({
            model: CONFIG.llmModel,
            max_tokens: CONFIG.maxResponseLen,
            system: systemPrompt,
            messages,
        }),
        parse: (data) => data.content?.[0]?.text || '',
    },
    openai: {
        endpoint: 'https://api.openai.com/v1/chat/completions',
        headers: () => ({
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${CONFIG.llmApiKey}`,
        }),
        body: (messages, systemPrompt) => ({
            model: CONFIG.llmModel,
            max_tokens: CONFIG.maxResponseLen,
            messages: [{ role: 'system', content: systemPrompt }, ...messages],
        }),
        parse: (data) => data.choices?.[0]?.message?.content || '',
    },
    grok: {
        endpoint: 'https://api.x.ai/v1/chat/completions',
        headers: () => ({
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${CONFIG.llmApiKey}`,
        }),
        body: (messages, systemPrompt) => ({
            model: CONFIG.llmModel,
            messages: [{ role: 'system', content: systemPrompt }, ...messages],
        }),
        parse: (data) => data.choices?.[0]?.message?.content || '',
    },
    gemini: {
        endpoint: () => `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.llmModel}:generateContent?key=${CONFIG.llmApiKey}`,
        headers: () => ({ 'Content-Type': 'application/json' }),
        body: (messages, systemPrompt) => ({
            system_instruction: { parts: [{ text: systemPrompt }] },
            contents: messages.map(m => ({
                role: m.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: m.content }],
            })),
        }),
        parse: (data) => data.candidates?.[0]?.content?.parts?.[0]?.text || '',
    },
};

async function callLLM(messages, systemPrompt) {
    const adapter = LLM[CONFIG.llmProvider];
    if (!adapter) throw new Error(`Unknown LLM provider: ${CONFIG.llmProvider}`);

    const endpoint = typeof adapter.endpoint === 'function' ? adapter.endpoint() : adapter.endpoint;
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: adapter.headers(),
        body: JSON.stringify(adapter.body(messages, systemPrompt)),
    });

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        // Strip any API keys that might appear in error responses
        const safeText = text.replace(new RegExp(CONFIG.llmApiKey, 'g'), '[REDACTED]')
                             .replace(new RegExp(CONFIG.moltbookApiKey, 'g'), '[REDACTED]');
        throw new Error(`LLM API ${res.status}: ${safeText.slice(0, 200)}`);
    }

    const data = await res.json();
    return adapter.parse(data);
}

// ============================================================
// MOLTBOOK API — All requests use Bearer auth header
// ============================================================

async function moltbookFetch(path, options = {}) {
    const url = `${CONFIG.moltbookApiUrl}${path}`;
    const res = await fetch(url, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${CONFIG.moltbookApiKey}`,
            ...(options.headers || {}),
        },
    });

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        const safeText = text.replace(new RegExp(CONFIG.moltbookApiKey, 'g'), '[REDACTED]');
        throw new Error(`Moltbook API ${res.status} ${path}: ${safeText.slice(0, 200)}`);
    }

    return res.json();
}

async function getNewPosts(since) {
    try {
        // Get posts mentioning the agent or in the configured submolt
        const data = await moltbookFetch(`/posts?submolt=${CONFIG.submolt}&sort=new&limit=20`);
        const posts = data.posts || data || [];
        if (!since) return posts.slice(0, 5); // First run: process last 5
        return posts.filter(p => new Date(p.created_at || p.createdAt) > new Date(since));
    } catch (e) {
        console.error('Poll failed:', e.message);
        return [];
    }
}

async function getNewReplies(since) {
    try {
        const data = await moltbookFetch(`/agents/${CONFIG.agentName}/notifications?limit=20`);
        const notifs = data.notifications || data || [];
        if (!since) return notifs.slice(0, 5);
        return notifs.filter(n => new Date(n.created_at || n.createdAt) > new Date(since));
    } catch (e) {
        // Notifications endpoint may not exist on all Moltbook versions
        return [];
    }
}

async function postReply(postId, content) {
    return moltbookFetch(`/posts/${postId}/comments`, {
        method: 'POST',
        body: JSON.stringify({ content }),
    });
}

async function createPost(title, content) {
    return moltbookFetch('/posts', {
        method: 'POST',
        body: JSON.stringify({
            submolt: CONFIG.submolt,
            title,
            content,
        }),
    });
}

async function getPostsPage(submolt, page = 1, limit = 20) {
    try {
        const data = await moltbookFetch(`/posts?submolt=${submolt}&sort=new&limit=${limit}&page=${page}`);
        return data.posts || data || [];
    } catch (e) {
        console.error(`  Fetch page ${page} of ${submolt} failed: ${e.message}`);
        return [];
    }
}

async function getPostComments(postId) {
    try {
        const data = await moltbookFetch(`/posts/${postId}/comments?limit=50`);
        return data.comments || data || [];
    } catch (e) {
        return [];
    }
}

// ============================================================
// SEED MODE — Read-only ingestion, no LLM needed
// ============================================================

async function seedMode(system) {
    const submolts = ARGS.seedSubmolts || [CONFIG.submolt];
    const pages = ARGS.seedPages;
    
    console.log(`\nSeed mode: reading ${pages} page(s) from ${submolts.length} submolt(s)`);
    console.log(`  Submolts: ${submolts.join(', ')}`);
    console.log(`  No LLM calls. No replies. Just reading.\n`);
    
    let totalPosts = 0;
    let totalIngested = 0;
    
    for (const submolt of submolts) {
        console.log(`── ${submolt} ──`);
        const episode = new Episode(`Seed: ${submolt}`);
        let postCount = 0;
        
        for (let page = 1; page <= pages; page++) {
            const posts = await getPostsPage(submolt, page);
            if (posts.length === 0) {
                console.log(`  Page ${page}: empty, done with ${submolt}`);
                break;
            }
            
            for (const post of posts) {
                const title = post.title || '';
                const body = post.content || post.body || '';
                const author = post.author?.name || post.agent_name || 'unknown';
                const text = `${title} ${body}`.trim();
                
                if (!text || text.length < 10) continue;
                
                // Ingest the post as a neighborhood in this episode
                const tokens = tokenize(text);
                if (tokens.length > 0) {
                    const neighborhood = Neighborhood.fromTokens(tokens, null, text);
                    episode.addNeighborhood(neighborhood);
                    postCount++;
                }
                
                // Also ingest comments/replies on this post — that's where the conversation lives
                const postId = post.id || post._id;
                if (postId) {
                    const comments = await getPostComments(postId);
                    for (const comment of comments) {
                        const cText = comment.content || comment.body || '';
                        if (cText.length < 10) continue;
                        const cTokens = tokenize(cText);
                        if (cTokens.length > 0) {
                            const cNeighborhood = Neighborhood.fromTokens(cTokens, null, cText);
                            episode.addNeighborhood(cNeighborhood);
                            postCount++;
                        }
                    }
                }
            }
            
            console.log(`  Page ${page}: ${posts.length} posts fetched`);
        }
        
        if (episode.neighborhoods.length > 0) {
            system.addEpisode(episode);
            totalIngested += episode.count;
            console.log(`  → Episode "${episode.name}": ${episode.neighborhoods.length} neighborhoods, ${episode.count} occurrences`);
        } else {
            console.log(`  → Nothing to ingest from ${submolt}`);
        }
        
        totalPosts += postCount;
    }
    
    return { totalPosts, totalIngested };
}

// ============================================================
// DAE PROCESSING PIPELINE
// ============================================================

function processExchange(system, queryEngine, query, conversationHistory) {
    // 1. Query activation
    const { activation, interference, surface } = queryEngine.processQuery(query);

    // 2. Compose memory context
    const { context, metrics } = composeContext(system, surface, activation, interference);
    const systemPrompt = DAE_SYSTEM_PROMPT(context);

    // 3. Build conversation window
    const win = conversationHistory.slice(-CONFIG.conversationWindow * 2);

    return { systemPrompt, win, metrics, activation };
}

function processResponse(system, queryEngine, reply) {
    // 1. Extract salient tags
    const salientCount = extractSalient(system, reply);

    // 2. Response activation — the LLM's words query existing memories
    const responseActivation = queryEngine.activate(reply);

    // 3. Response drift (weight-filtered for performance)
    const totalNbhd = system.episodes.reduce((s, ep) => s + ep.neighborhoods.length, 0)
        + system.consciousEpisode.neighborhoods.length;
    const responseWeightFloor = 1 / Math.max(1, Math.floor(totalNbhd * 0.1));

    const driftSub = responseActivation.subconscious.filter(occ =>
        system.getWordWeight(occ.word) >= responseWeightFloor
    );
    const driftCon = responseActivation.conscious.filter(occ =>
        system.getWordWeight(occ.word) >= responseWeightFloor
    );

    queryEngine.driftAndConsolidate(driftSub);
    queryEngine.driftAndConsolidate(driftCon);

    // 4. Response interference (Kuramoto coupling)
    queryEngine.computeInterference(responseActivation.subconscious, responseActivation.conscious);

    return { salientCount, responseActivation };
}

// ============================================================
// MAIN AGENT LOOP
// ============================================================

async function main() {
    console.log('DAE Moltbook Agent v0.7.2 — Created by smaxforn');
    console.log('='.repeat(50));

    validateConfig();

    // Load or initialize state
    const saved = loadState();
    let system, queryEngine, conversationHistory, conversationBuffer, meta;

    if (saved) {
        system = saved.system;
        queryEngine = new QueryEngine(system);
        conversationHistory = saved.conversationHistory;
        conversationBuffer = saved.conversationBuffer;
        meta = saved.meta;
        console.log(`State loaded: N=${system.N}, Episodes=${system.episodes.length}, Conscious=${system.consciousEpisode.count}`);
    } else {
        system = new DAESystem();
        system.agentName = CONFIG.agentName;
        queryEngine = new QueryEngine(system);
        conversationHistory = [];
        conversationBuffer = [];
        meta = { lastPollTime: null, totalExchanges: 0, pollCount: 0 };
        console.log('Fresh start — no prior state.');
    }

    // ── SEED MODE ──
    if (ARGS.seed) {
        const { totalPosts, totalIngested } = await seedMode(system);
        
        saveState(system, conversationHistory, conversationBuffer, meta);
        
        console.log(`\nSeed complete.`);
        console.log(`  Posts+comments read: ${totalPosts}`);
        console.log(`  Occurrences ingested: ${totalIngested}`);
        console.log(`  Total N: ${system.N}`);
        console.log(`  Episodes: ${system.episodes.length}`);
        console.log(`  State saved to ${CONFIG.stateDir}/`);
        console.log(`\nRun without --seed to start the agent loop.`);
        return;
    }

    // ── AGENT MODE ──
    let pollCount = meta.pollCount || 0;

    // Strip salient tags from display text (not needed in Moltbook posts)
    function cleanReply(text) {
        return text.replace(/<\/?salient>/g, '').trim();
    }

    async function poll() {
        pollCount++;
        const since = meta.lastPollTime;

        try {
            // Get new posts and replies
            const [posts, replies] = await Promise.all([
                getNewPosts(since),
                getNewReplies(since),
            ]);

            // Merge and deduplicate interactions
            const interactions = [];
            for (const post of posts) {
                const id = post.id || post._id;
                const text = post.content || post.body || '';
                const title = post.title || '';
                const author = post.author?.name || post.agent_name || 'unknown';
                if (text && author !== CONFIG.agentName) {
                    interactions.push({ type: 'post', id, query: `${title} ${text}`.trim(), author, postId: id });
                }
            }
            for (const notif of replies) {
                const text = notif.content || notif.body || notif.comment?.content || '';
                const postId = notif.post_id || notif.postId || notif.comment?.post_id;
                const author = notif.author?.name || notif.agent_name || 'unknown';
                if (text && author !== CONFIG.agentName) {
                    interactions.push({ type: 'reply', id: notif.id, query: text, author, postId });
                }
            }

            if (interactions.length > 0) {
                console.log(`\n[Poll ${pollCount}] ${interactions.length} new interaction(s)`);
            }

            for (const interaction of interactions) {
                try {
                    console.log(`  Processing ${interaction.type} from ${interaction.author}: "${interaction.query.slice(0, 80)}..."`);

                    // DAE query processing
                    const { systemPrompt, win, metrics } = processExchange(
                        system, queryEngine, interaction.query, conversationHistory
                    );

                    // Add this query to conversation window
                    const messages = [...win, { role: 'user', content: interaction.query }];

                    // Call LLM
                    const reply = await callLLM(messages, systemPrompt);

                    // DAE response processing
                    const { salientCount } = processResponse(system, queryEngine, reply);

                    // Update conversation state
                    conversationHistory.push(
                        { role: 'user', content: interaction.query },
                        { role: 'assistant', content: reply }
                    );

                    conversationBuffer.push([interaction.query, reply]);

                    // Episode creation at threshold
                    if (conversationBuffer.length >= CONFIG.episodeThreshold) {
                        const ep = new Episode(`Moltbook ${system.episodes.length + 1}`);
                        conversationBuffer.forEach(([userMsg, asstMsg]) => {
                            const combined = userMsg + ' ' + asstMsg;
                            const tokens = tokenize(combined);
                            const neighborhood = Neighborhood.fromTokens(tokens, null, combined);
                            ep.addNeighborhood(neighborhood);
                        });
                        system.addEpisode(ep);
                        conversationBuffer = [];
                        console.log(`  >>> New episode: ${ep.name} (N=${system.N})`);
                    }

                    // Post response to Moltbook
                    const cleaned = cleanReply(reply);
                    if (interaction.postId) {
                        await postReply(interaction.postId, cleaned);
                    }

                    meta.totalExchanges = (meta.totalExchanges || 0) + 1;
                    const summary = `con:${metrics.conscious} sub:${metrics.subconscious} novel:${metrics.novel}`;
                    console.log(`  Responded [${summary}${salientCount > 0 ? ` +${salientCount} salient` : ''}]`);

                } catch (e) {
                    console.error(`  Error processing interaction: ${e.message}`);
                }
            }

            // Update poll time
            meta.lastPollTime = new Date().toISOString();
            meta.pollCount = pollCount;

            // Save state after processing
            if (interactions.length > 0) {
                saveState(system, conversationHistory, conversationBuffer, meta);
                console.log('  State saved.');
            }

            // Heartbeat post
            if (CONFIG.heartbeatEvery > 0 && pollCount % CONFIG.heartbeatEvery === 0) {
                const N = system.N;
                const eps = system.episodes.length;
                const con = system.consciousEpisode.neighborhoods.length;
                const exchanges = meta.totalExchanges || 0;
                console.log(`  [Heartbeat] N=${N}, Episodes=${eps}, Conscious=${con}, Exchanges=${exchanges}`);
            }

        } catch (e) {
            console.error(`Poll error: ${e.message}`);
        }
    }

    // Graceful shutdown
    let running = true;
    process.on('SIGINT', () => {
        console.log('\nShutting down...');
        saveState(system, conversationHistory, conversationBuffer, meta);
        console.log('State saved. Goodbye.');
        running = false;
        process.exit(0);
    });
    process.on('SIGTERM', () => {
        saveState(system, conversationHistory, conversationBuffer, meta);
        process.exit(0);
    });

    // Initial poll then interval
    await poll();
    const interval = setInterval(async () => {
        if (running) await poll();
    }, CONFIG.pollIntervalMs);

    console.log(`\nAgent running. Polling every ${CONFIG.pollIntervalMs / 1000}s. Ctrl+C to stop.`);
}

main().catch(e => {
    console.error('Fatal:', e.message);
    process.exit(1);
});
