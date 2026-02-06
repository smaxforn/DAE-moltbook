// DAE — Daemon Attention Engine v0.7.2
// Created by smaxforn
//
// Core engine extracted for server-side deployment.
// No browser dependencies. Pure math + memory.

// ============================================================
// CONSTANTS
// ============================================================
/*
 * DAE MATHEMATICAL FOUNDATIONS
 * ============================
 * 
 * Core Model: Closed Universe
 * ---------------------------
 * The system models memory as a closed manifold (S³) with fixed total mass M=1.
 * Adding content increases resolution/density, not volume. 
 * Think: finite universe, increasingly fine-grained.
 * 
 * N = total occurrences. Growth adds resolution, not volume.
 * 
 * Anchoring & Drift: drift = 1 - 2c/C, anchors at c = C/2
 * Golden Ratio Distribution: 2π/φ² ≈ 137.5° (phyllotaxis)
 * Neighborhood radius: π/φ ≈ 111°
 * Interference: cos(Δθ) — constructive (+1) or destructive (-1)
 * IDF Weighting: 1/(neighborhoods word appears in)
 * Kuramoto Coupling: cross-manifold phase sync, K_CON + K_SUB = 1
 * Plasticity: 1/(1 + log(1 + activationCount))
 */

const PHI = (1 + Math.sqrt(5)) / 2;
const GOLDEN_ANGLE = (2 * Math.PI) / (PHI * PHI);
const NEIGHBORHOOD_RADIUS = Math.PI / PHI;
const THRESHOLD = 0.5;
const M = 1;
const EPSILON = 1e-10;

// ============================================================
// QUATERNION — Points on S³
// ============================================================

class Quaternion {
    constructor(w = 1, x = 0, y = 0, z = 0) {
        this.w = w; this.x = x; this.y = y; this.z = z;
    }

    normalize() {
        const norm = Math.sqrt(this.w*this.w + this.x*this.x + this.y*this.y + this.z*this.z);
        if (norm < EPSILON) return new Quaternion();
        return new Quaternion(this.w/norm, this.x/norm, this.y/norm, this.z/norm);
    }

    dot(other) {
        return this.w*other.w + this.x*other.x + this.y*other.y + this.z*other.z;
    }

    static random() {
        const s1 = Math.random();
        const s2 = Math.random();
        const t1 = 2 * Math.PI * Math.random();
        const t2 = 2 * Math.PI * Math.random();
        const sqrtTerm = Math.sqrt((1 - s1) / s2);
        return new Quaternion(
            Math.sqrt(1 - s1) * Math.sin(t1),
            Math.sqrt(1 - s1) * Math.cos(t1),
            Math.sqrt(s1) * Math.sin(t2),
            Math.sqrt(s1) * Math.cos(t2)
        ).normalize();
    }

    static randomNear(center, angularRadius) {
        let ax = gaussRandom(), ay = gaussRandom(), az = gaussRandom();
        const axNorm = Math.sqrt(ax*ax + ay*ay + az*az);
        if (axNorm < EPSILON) return center;
        ax /= axNorm; ay /= axNorm; az /= axNorm;

        const angle = angularRadius * Math.sqrt(Math.random());
        const halfAngle = angle / 2;
        const sinHalf = Math.sin(halfAngle);
        const cosHalf = Math.cos(halfAngle);

        const rotation = new Quaternion(cosHalf, ax * sinHalf, ay * sinHalf, az * sinHalf);
        return new Quaternion(
            rotation.w * center.w - rotation.x * center.x - rotation.y * center.y - rotation.z * center.z,
            rotation.w * center.x + rotation.x * center.w + rotation.y * center.z - rotation.z * center.y,
            rotation.w * center.y - rotation.x * center.z + rotation.y * center.w + rotation.z * center.x,
            rotation.w * center.z + rotation.x * center.y - rotation.y * center.x + rotation.z * center.w
        ).normalize();
    }

    geodesicDistance(other) {
        const d = Math.min(1, Math.max(-1, Math.abs(this.dot(other))));
        return 2 * Math.acos(d);
    }

    slerp(other, t) {
        if (t <= 0) return this;
        if (t >= 1) return other;
        let dot = this.dot(other);
        let o = other;
        if (dot < 0) {
            o = new Quaternion(-other.w, -other.x, -other.y, -other.z);
            dot = -dot;
        }
        if (dot > 0.9995) {
            return new Quaternion(
                this.w + t * (o.w - this.w), this.x + t * (o.x - this.x),
                this.y + t * (o.y - this.y), this.z + t * (o.z - this.z)
            ).normalize();
        }
        const theta = Math.acos(dot);
        const sinTheta = Math.sin(theta);
        const s0 = Math.sin((1 - t) * theta) / sinTheta;
        const s1 = Math.sin(t * theta) / sinTheta;
        return new Quaternion(
            s0 * this.w + s1 * o.w, s0 * this.x + s1 * o.x,
            s0 * this.y + s1 * o.y, s0 * this.z + s1 * o.z
        ).normalize();
    }

    toArray() { return [this.w, this.x, this.y, this.z]; }

    static fromArray(arr) {
        return new Quaternion(arr[0], arr[1], arr[2], arr[3]);
    }
}

function gaussRandom() {
    const u1 = Math.random();
    const u2 = Math.random();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// ============================================================
// DAEMON PHASOR — Phase on the golden angle lattice
// ============================================================

class DaemonPhasor {
    constructor(theta = 0) { this.theta = theta % (2 * Math.PI); }

    static fromIndex(index, baseTheta = 0) {
        return new DaemonPhasor(baseTheta + index * GOLDEN_ANGLE);
    }

    interference(other) {
        return Math.cos(this.theta - other.theta);
    }

    slerp(other, t) {
        let diff = other.theta - this.theta;
        while (diff > Math.PI) diff -= 2 * Math.PI;
        while (diff < -Math.PI) diff += 2 * Math.PI;
        return new DaemonPhasor(this.theta + t * diff);
    }
}

// ============================================================
// OCCURRENCE — Single word instance on S³
// ============================================================

class Occurrence {
    constructor(word, position, phasor, neighborhoodId = null) {
        this.word = word;
        this.position = position;
        this.phasor = phasor;
        this.activationCount = 0;
        this.neighborhoodId = neighborhoodId;
    }

    activate() { this.activationCount++; }

    getDriftRate(containerActivation) {
        if (containerActivation === 0) return 0;
        const ratio = this.activationCount / containerActivation;
        if (ratio > THRESHOLD) return 0;
        return ratio / THRESHOLD;
    }

    get plasticity() {
        const c = this.activationCount;
        return 1 / (1 + Math.log(1 + c));
    }

    isAnchored(containerActivation) {
        const ratio = this.activationCount / containerActivation;
        return ratio > THRESHOLD;
    }

    mass(N) {
        const c = this.activationCount;
        return N > 0 ? (c / N) * M : 0;
    }

    driftToward(target, containerActivation) {
        const t = this.getDriftRate(containerActivation);
        if (t <= 0) return;
        this.position = this.position.slerp(target.position, t);
        this.phasor = this.phasor.slerp(target.phasor, t);
    }

    toJSON() {
        return {
            word: this.word,
            position: this.position.toArray(),
            phasor: this.phasor.theta,
            activationCount: this.activationCount,
            neighborhoodId: this.neighborhoodId
        };
    }

    static fromJSON(data) {
        const occ = new Occurrence(
            data.word,
            Quaternion.fromArray(data.position),
            new DaemonPhasor(data.phasor ?? data.theta ?? 0),
            data.neighborhoodId
        );
        occ.activationCount = data.activationCount || 0;
        return occ;
    }
}

// ============================================================
// NEIGHBORHOOD — Chunk of text, collection of occurrences
// ============================================================

class Neighborhood {
    constructor(seed, id = null, sourceText = '') {
        this.seed = seed;
        this.id = id || crypto.randomUUID();
        this.occurrences = [];
        this.text = sourceText;
    }

    static fromTokens(tokens, seed = null, sourceText = '') {
        const neighborhood = new Neighborhood(seed || Quaternion.random(), null, sourceText);
        tokens.forEach((token, i) => {
            const position = Quaternion.randomNear(neighborhood.seed, NEIGHBORHOOD_RADIUS);
            const phasor = DaemonPhasor.fromIndex(i);
            const occ = new Occurrence(token, position, phasor);
            occ.neighborhoodId = neighborhood.id;
            neighborhood.occurrences.push(occ);
        });
        return neighborhood;
    }

    get count() { return this.occurrences.length; }

    get totalActivation() {
        return this.occurrences.reduce((sum, o) => sum + o.activationCount, 0);
    }

    mass(N) {
        return N > 0 ? (this.count / N) * M : 0;
    }

    activateWord(word) {
        const activated = [];
        const wordLower = word.toLowerCase();
        this.occurrences.forEach(o => {
            if (o.word.toLowerCase() === wordLower) {
                o.activate();
                activated.push(o);
            }
        });
        return activated;
    }

    isVivid(episodeCount) {
        return this.count > episodeCount * THRESHOLD;
    }

    driftAll() {
        const C = this.totalActivation;
        this.occurrences.forEach(o => {
            if (o.activationCount > 0) o.driftToward(this.occurrences[0], C);
        });
    }

    toJSON() {
        const C = this.totalActivation;
        return {
            seed: this.seed.toArray(),
            id: this.id,
            sourceText: this.text,
            occurrences: this.occurrences.map(o => {
                const base = o.toJSON();
                base.neighborhoodId = this.id;
                return base;
            })
        };
    }

    static fromJSON(data) {
        const n = new Neighborhood(Quaternion.fromArray(data.seed), data.id, data.sourceText);
        n.occurrences = (data.occurrences || []).map(o => Occurrence.fromJSON(o));
        return n;
    }
}

// ============================================================
// EPISODE — Collection of neighborhoods (one conversation/document)
// ============================================================

class Episode {
    constructor(name = 'Untitled', isConscious = false, id = null, timestamp = null) {
        this.name = name;
        this.isConscious = isConscious;
        this.id = id || crypto.randomUUID();
        this.timestamp = timestamp || new Date().toISOString();
        this.neighborhoods = [];
    }

    get displayName() {
        if (this.isConscious) return 'Conscious';
        const date = new Date(this.timestamp);
        const dateStr = date.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: '2-digit' });
        const timeStr = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        return `${this.name} (${dateStr} ${timeStr})`;
    }

    addNeighborhood(n) { this.neighborhoods.push(n); }

    get count() {
        return this.neighborhoods.reduce((sum, n) => sum + n.count, 0);
    }

    get totalActivation() {
        return this.neighborhoods.reduce((sum, n) => sum + n.totalActivation, 0);
    }

    mass(N) {
        return N > 0 ? (this.count / N) * M : 0;
    }

    *allOccurrences() {
        for (const n of this.neighborhoods) {
            yield* n.occurrences;
        }
    }

    activateWord(word) {
        const activated = [];
        this.neighborhoods.forEach(n => {
            activated.push(...n.activateWord(word));
        });
        return activated;
    }

    isVivid(systemCount) {
        return this.count > systemCount * THRESHOLD;
    }

    toJSON() {
        return {
            name: this.name, isConscious: this.isConscious,
            id: this.id, timestamp: this.timestamp,
            neighborhoods: this.neighborhoods.map(n => n.toJSON())
        };
    }

    static fromJSON(data) {
        const e = new Episode(data.name, data.isConscious, data.id, data.timestamp);
        e.neighborhoods = (data.neighborhoods || []).map(n => Neighborhood.fromJSON(n));
        return e;
    }
}

// ============================================================
// DAE SYSTEM — All episodes + conscious manifold + indexes
// ============================================================

class DAESystem {
    constructor() {
        this.episodes = [];
        this.consciousEpisode = new Episode('conscious', true);
        this._indexDirty = true;
        this._wordNeighborhoodIndex = new Map();
        this._wordOccurrenceIndex = new Map();
        this._neighborhoodIndex = new Map();
        this._neighborhoodEpisodeIndex = new Map();
        this.agentName = 'DAE';
    }

    addEpisode(episode) {
        this.episodes.push(episode);
        this._indexDirty = true;
    }

    _rebuildIndexes() {
        if (!this._indexDirty) return;
        this._wordNeighborhoodIndex.clear();
        this._wordOccurrenceIndex.clear();
        this._neighborhoodIndex.clear();
        this._neighborhoodEpisodeIndex.clear();

        const allEpisodes = [...this.episodes, this.consciousEpisode];
        for (const ep of allEpisodes) {
            for (const n of ep.neighborhoods) {
                this._neighborhoodIndex.set(n.id, n);
                this._neighborhoodEpisodeIndex.set(n.id, ep);
                for (const occ of n.occurrences) {
                    const w = occ.word.toLowerCase();
                    if (!this._wordNeighborhoodIndex.has(w)) {
                        this._wordNeighborhoodIndex.set(w, new Set());
                    }
                    this._wordNeighborhoodIndex.get(w).add(n.id);
                    if (!this._wordOccurrenceIndex.has(w)) {
                        this._wordOccurrenceIndex.set(w, []);
                    }
                    this._wordOccurrenceIndex.get(w).push(occ);
                }
            }
        }
        this._indexDirty = false;
    }

    get N() {
        return this.episodes.reduce((sum, e) => sum + e.count, 0) + this.consciousEpisode.count;
    }

    get totalActivation() {
        return this.episodes.reduce((sum, e) => sum + e.totalActivation, 0) + this.consciousEpisode.totalActivation;
    }

    get mass() { return M; }

    getWordWeight(word) {
        this._rebuildIndexes();
        const nids = this._wordNeighborhoodIndex.get(word.toLowerCase());
        return 1 / (nids ? nids.size : 1);
    }

    *allOccurrences() {
        for (const e of this.episodes) yield* e.allOccurrences();
        yield* this.consciousEpisode.allOccurrences();
    }

    getNeighborhoodForOccurrence(occ) {
        this._rebuildIndexes();
        return this._neighborhoodIndex.get(occ.neighborhoodId) || null;
    }

    getEpisodeForOccurrence(occ) {
        this._rebuildIndexes();
        return this._neighborhoodEpisodeIndex.get(occ.neighborhoodId) || null;
    }

    activateWord(word) {
        this._rebuildIndexes();
        const subconscious = [];
        const conscious = [];
        const wordLower = word.toLowerCase();

        const occs = this._wordOccurrenceIndex.get(wordLower);
        if (!occs) return { subconscious, conscious };

        for (const occ of occs) {
            occ.activate();
            const ep = this._neighborhoodEpisodeIndex.get(occ.neighborhoodId);
            if (ep && ep.isConscious) {
                conscious.push(occ);
            } else {
                subconscious.push(occ);
            }
        }
        return { subconscious, conscious };
    }

    addToConscious(text) {
        const tokens = tokenize(text);
        const neighborhood = Neighborhood.fromTokens(tokens, null, text);
        neighborhood.occurrences.forEach(o => o.activate());
        this.consciousEpisode.addNeighborhood(neighborhood);
        this._indexDirty = true;
        return neighborhood;
    }

    toJSON() {
        return {
            episodes: this.episodes.map(e => e.toJSON()),
            consciousEpisode: this.consciousEpisode.toJSON(),
            N: this.N,
            totalActivation: this.totalActivation,
            agentName: this.agentName
        };
    }

    static fromJSON(data) {
        const sys = new DAESystem();
        sys.episodes = data.episodes.map(e => Episode.fromJSON(e));
        sys.consciousEpisode = Episode.fromJSON(data.consciousEpisode);
        if (data.agentName) sys.agentName = data.agentName;
        return sys;
    }
}

// ============================================================
// TOKENIZATION
// ============================================================

function tokenize(text) {
    return text
        .replace(/[^\w\s']/g, ' ')
        .toLowerCase()
        .split(/\s+/)
        .map(t => t.replace(/^'+|'+$/g, ''))
        .filter(t => t.length > 0);
}

// ============================================================
// INGESTION
// ============================================================

function ingestText(text, name = null) {
    const episode = new Episode(name);
    const sentences = text.split(/(?<=[.!?])\s+/).filter(s => s.trim());
    const chunkSize = 3;

    for (let i = 0; i < sentences.length; i += chunkSize) {
        const chunk = sentences.slice(i, i + chunkSize).join(' ');
        const tokens = tokenize(chunk);
        if (tokens.length > 0) {
            const neighborhood = Neighborhood.fromTokens(tokens, null, chunk);
            episode.addNeighborhood(neighborhood);
        }
    }
    return episode;
}

// ============================================================
// QUERY ENGINE
// ============================================================

class QueryEngine {
    constructor(system) {
        this.system = system;
    }

    activate(query) {
        const tokens = tokenize(query);
        const uniqueTokens = [...new Set(tokens.map(t => t.toLowerCase()))];
        const result = { subconscious: [], conscious: [] };

        uniqueTokens.forEach(token => {
            const { subconscious, conscious } = this.system.activateWord(token);
            result.subconscious.push(...subconscious);
            result.conscious.push(...conscious);
        });

        return result;
    }

    driftAndConsolidate(activated) {
        if (activated.length < 2) return;

        const containerActivations = new Map();
        activated.forEach(occ => {
            if (!containerActivations.has(occ.neighborhoodId)) {
                const neighborhood = this.system.getNeighborhoodForOccurrence(occ);
                containerActivations.set(occ.neighborhoodId, neighborhood ? neighborhood.totalActivation : 0);
            }
        });

        // Layer 1: Pre-filter anchored occurrences
        const mobile = activated.filter(occ => {
            const C = containerActivations.get(occ.neighborhoodId) || 0;
            return occ.getDriftRate(C) > 0;
        });

        if (mobile.length < 2) return;

        if (mobile.length >= 200) {
            // O(n) centroid drift for large batches
            this._centroidDrift(mobile, containerActivations);
        } else {
            // O(n²) pairwise drift for small batches — more precise
            this._pairwiseDrift(mobile, containerActivations);
        }
    }

    _pairwiseDrift(mobile, containerActivations) {
        for (let i = 0; i < mobile.length; i++) {
            const occ1 = mobile[i];
            const C1 = containerActivations.get(occ1.neighborhoodId) || 0;
            const w1 = this.system.getWordWeight(occ1.word);

            for (let j = i + 1; j < mobile.length; j++) {
                const occ2 = mobile[j];
                const C2 = containerActivations.get(occ2.neighborhoodId) || 0;
                const w2 = this.system.getWordWeight(occ2.word);

                const t1 = occ1.getDriftRate(C1) * w1;
                const t2 = occ2.getDriftRate(C2) * w2;

                if (t1 > 0 || t2 > 0) {
                    const total = t1 + t2;
                    if (total > 0) {
                        const weight = t1 / total;
                        const meeting = occ1.position.slerp(occ2.position, weight);
                        if (t1 > 0) {
                            occ1.position = occ1.position.slerp(meeting, t1 * THRESHOLD);
                            occ1.phasor = occ1.phasor.slerp(occ2.phasor, t1 * THRESHOLD);
                        }
                        if (t2 > 0) {
                            occ2.position = occ2.position.slerp(meeting, t2 * THRESHOLD);
                            occ2.phasor = occ2.phasor.slerp(occ1.phasor, t2 * THRESHOLD);
                        }
                    }
                }
            }
        }
    }

    _centroidDrift(mobile, containerActivations) {
        let sumW = 0, sumX = 0, sumY = 0, sumZ = 0, totalWeight = 0;
        const weights = mobile.map(occ => {
            const w = this.system.getWordWeight(occ.word);
            sumW += occ.position.w * w;
            sumX += occ.position.x * w;
            sumY += occ.position.y * w;
            sumZ += occ.position.z * w;
            totalWeight += w;
            return w;
        });

        mobile.forEach((occ, i) => {
            const w = weights[i];
            const remWeight = totalWeight - w;
            if (remWeight < EPSILON) return;

            const tw = (sumW - occ.position.w * w) / remWeight;
            const tx = (sumX - occ.position.x * w) / remWeight;
            const ty = (sumY - occ.position.y * w) / remWeight;
            const tz = (sumZ - occ.position.z * w) / remWeight;

            const n = Math.sqrt(tw*tw + tx*tx + ty*ty + tz*tz);
            if (n < EPSILON) return;

            const target = new Quaternion(tw/n, tx/n, ty/n, tz/n);
            const C = containerActivations.get(occ.neighborhoodId) || 0;
            const factor = occ.getDriftRate(C) * w * 0.5;

            if (factor > 0) {
                occ.position = occ.position.slerp(target, factor);
            }
        });
    }

    computeInterference(subconscious, conscious) {
        const subByWord = new Map();
        subconscious.forEach(occ => {
            const w = occ.word.toLowerCase();
            if (!subByWord.has(w)) subByWord.set(w, []);
            subByWord.get(w).push(occ);
        });

        const conByWord = new Map();
        conscious.forEach(occ => {
            const w = occ.word.toLowerCase();
            if (!conByWord.has(w)) conByWord.set(w, []);
            conByWord.get(w).push(occ);
        });

        const results = [];
        const wordGroups = [];

        for (const [word, subOccs] of subByWord) {
            const conOccs = conByWord.get(word);
            if (!conOccs) continue;

            // Circular mean phase of conscious occurrences
            let sinSum = 0, cosSum = 0;
            conOccs.forEach(occ => {
                sinSum += Math.sin(occ.phasor.theta);
                cosSum += Math.cos(occ.phasor.theta);
            });
            const meanConPhase = Math.atan2(sinSum / conOccs.length, cosSum / conOccs.length);

            // Per-subOcc interference against conscious mean
            for (const subOcc of subOccs) {
                let diff = Math.abs(subOcc.phasor.theta - meanConPhase);
                if (diff > Math.PI) diff = 2 * Math.PI - diff;
                const interference = Math.cos(diff);
                results.push({ subOcc, conOcc: conOccs[0], interference });
            }

            wordGroups.push({ word, subOccs, conOccs });
        }

        this.applyKuramotoCoupling(wordGroups);
        return results;
    }

    applyKuramotoCoupling(wordGroups) {
        if (wordGroups.length === 0) return;

        const N_con = this.system.consciousEpisode.count || 1;
        const N_sub = Math.max(1, this.system.N - N_con);
        const N_total = this.system.N || 1;

        const K_CON = N_sub / N_total;
        const K_SUB = N_con / N_total;
        const TWO_PI = 2 * Math.PI;

        wordGroups.forEach(({ word, subOccs, conOccs }) => {
            const w = this.system.getWordWeight(word);
            const coupling = w * w;

            let sinSumSub = 0, cosSumSub = 0;
            subOccs.forEach(occ => { sinSumSub += Math.sin(occ.phasor.theta); cosSumSub += Math.cos(occ.phasor.theta); });
            const meanPhaseSub = Math.atan2(sinSumSub / subOccs.length, cosSumSub / subOccs.length);

            let sinSumCon = 0, cosSumCon = 0;
            conOccs.forEach(occ => { sinSumCon += Math.sin(occ.phasor.theta); cosSumCon += Math.cos(occ.phasor.theta); });
            const meanPhaseCon = Math.atan2(sinSumCon / conOccs.length, cosSumCon / conOccs.length);

            let phaseDiff = meanPhaseCon - meanPhaseSub;
            while (phaseDiff > Math.PI) phaseDiff -= TWO_PI;
            while (phaseDiff < -Math.PI) phaseDiff += TWO_PI;

            const sinDiff = Math.sin(phaseDiff);
            const baseDeltaSub = K_CON * coupling * sinDiff;
            const baseDeltaCon = -K_SUB * coupling * sinDiff;

            subOccs.forEach(occ => {
                const plasticity = 1 / (1 + Math.log(1 + occ.activationCount));
                occ.phasor.theta = ((occ.phasor.theta + baseDeltaSub * plasticity) % TWO_PI + TWO_PI) % TWO_PI;
            });
            conOccs.forEach(occ => {
                const plasticity = 1 / (1 + Math.log(1 + occ.activationCount));
                occ.phasor.theta = ((occ.phasor.theta + baseDeltaCon * plasticity) % TWO_PI + TWO_PI) % TWO_PI;
            });
        });
    }

    computeSurface(activation, interference) {
        const N = this.system.N;
        const fragments = [];
        const vividNeighborhoods = [];
        const vividEpisodes = [];

        const surfacedOccs = new Set();
        interference.forEach(({ subOcc, interference: intVal }) => {
            if (intVal > 0) surfacedOccs.add(subOcc);
        });

        const consciousWords = new Set(activation.conscious.map(o => o.word.toLowerCase()));
        activation.subconscious.forEach(occ => {
            if (!consciousWords.has(occ.word.toLowerCase())) surfacedOccs.add(occ);
        });

        const neighborhoodActivations = new Map();
        surfacedOccs.forEach(occ => {
            const nid = occ.neighborhoodId;
            if (!neighborhoodActivations.has(nid)) neighborhoodActivations.set(nid, []);
            neighborhoodActivations.get(nid).push(occ);
        });

        const vividNeighborhoodIds = new Set();
        const vividEpisodeIds = new Set();

        this.system.episodes.forEach(episode => {
            let episodeActivated = 0;
            episode.neighborhoods.forEach(neighborhood => {
                const nActivated = (neighborhoodActivations.get(neighborhood.id) || []).length;
                episodeActivated += nActivated;
                if (neighborhood.count > 0) {
                    const nRatio = nActivated / neighborhood.count;
                    if (nRatio > THRESHOLD) {
                        vividNeighborhoods.push(neighborhood);
                        vividNeighborhoodIds.add(neighborhood.id);
                    }
                }
            });
            if (episode.count > 0 && N > 0) {
                const eRatio = episodeActivated / episode.count;
                if (eRatio > THRESHOLD && episode.mass(N) > THRESHOLD) {
                    vividEpisodes.push(episode);
                    vividEpisodeIds.add(episode.id);
                }
            }
        });

        surfacedOccs.forEach(occ => {
            if (!vividNeighborhoodIds.has(occ.neighborhoodId)) {
                const ep = this.system.getEpisodeForOccurrence(occ);
                if (!ep || !vividEpisodeIds.has(ep.id)) {
                    fragments.push(occ);
                }
            }
        });

        return { fragments, vividNeighborhoods, vividEpisodes };
    }

    processQuery(query) {
        const activation = this.activate(query);

        const totalNbhd = this.system.episodes.reduce((s, ep) => s + ep.neighborhoods.length, 0)
            + (this.system.consciousEpisode ? this.system.consciousEpisode.neighborhoods.length : 0);
        const queryTokenCount = tokenize(query).length;

        if (queryTokenCount > 50) {
            const weightFloor = 1 / Math.max(1, Math.floor(totalNbhd * 0.1));
            const driftSub = activation.subconscious.filter(occ => this.system.getWordWeight(occ.word) >= weightFloor);
            const driftCon = activation.conscious.filter(occ => this.system.getWordWeight(occ.word) >= weightFloor);
            this.driftAndConsolidate(driftSub);
            this.driftAndConsolidate(driftCon);
        } else {
            this.driftAndConsolidate(activation.subconscious);
            this.driftAndConsolidate(activation.conscious);
        }

        const interference = this.computeInterference(activation.subconscious, activation.conscious);
        const surface = this.computeSurface(activation, interference);

        return { activation, interference, surface };
    }
}

// ============================================================
// CONTEXT COMPOSITION — Builds the memory context for the LLM
// ============================================================

function composeContext(system, surface, activation, interference) {
    const parts = [];
    let metrics = { conscious: 0, subconscious: 0, novel: 0 };

    const consciousWords = new Set(activation.conscious.map(o => o.word.toLowerCase()));

    // Score conscious neighborhoods
    const conNeighborhoods = new Map();
    activation.conscious.forEach(o => {
        const w = o.word.toLowerCase();
        const weight = system.getWordWeight(w);
        if (!conNeighborhoods.has(o.neighborhoodId)) {
            const neighborhood = system.getNeighborhoodForOccurrence(o);
            if (neighborhood) {
                conNeighborhoods.set(o.neighborhoodId, { neighborhood, score: 0, words: new Set(), activatedCount: 0 });
            }
        }
        if (conNeighborhoods.has(o.neighborhoodId)) {
            const entry = conNeighborhoods.get(o.neighborhoodId);
            entry.score += weight * o.activationCount;
            entry.words.add(w);
            entry.activatedCount++;
        }
    });

    // Score subconscious neighborhoods
    const subNeighborhoods = new Map();
    activation.subconscious.forEach(o => {
        const w = o.word.toLowerCase();
        const weight = system.getWordWeight(w);
        const ep = system.getEpisodeForOccurrence(o);
        if (!subNeighborhoods.has(o.neighborhoodId)) {
            const neighborhood = system.getNeighborhoodForOccurrence(o);
            if (neighborhood && ep) {
                subNeighborhoods.set(o.neighborhoodId, {
                    neighborhood, episode: ep, score: 0, words: new Set(),
                    activatedCount: 0, maxWordWeight: 0, maxPlasticity: 0
                });
            }
        }
        if (subNeighborhoods.has(o.neighborhoodId)) {
            const entry = subNeighborhoods.get(o.neighborhoodId);
            entry.score += weight * o.activationCount;
            entry.words.add(w);
            entry.activatedCount++;
            const plasticity = 1 / (1 + Math.log(1 + o.activationCount));
            if (weight > entry.maxWordWeight) entry.maxWordWeight = weight;
            if (plasticity > entry.maxPlasticity) entry.maxPlasticity = plasticity;
        }
    });

    const selectedIds = new Set();

    // 1. CONSCIOUS RECALL
    const conRanked = [...conNeighborhoods.values()].sort((a, b) => b.score - a.score);
    if (conRanked.length > 0) {
        const best = conRanked[0];
        selectedIds.add(best.neighborhood.id);
        const text = best.neighborhood.text || best.neighborhood.occurrences.map(o => o.word).join(' ');
        parts.push('CONSCIOUS RECALL:');
        parts.push('[Source: Previously marked salient]');
        parts.push(`"${text}"`);
        metrics.conscious = 1;
    }

    // 2. SUBCONSCIOUS RECALL (top 2)
    const subRanked = [...subNeighborhoods.values()]
        .filter(entry => !selectedIds.has(entry.neighborhood.id))
        .sort((a, b) => b.score - a.score);
    subRanked.slice(0, 2).forEach((entry, i) => {
        selectedIds.add(entry.neighborhood.id);
        const text = entry.neighborhood.text || entry.neighborhood.occurrences.map(o => o.word).join(' ');
        const epName = entry.episode.displayName || entry.episode.name || 'Memory';
        parts.push(`\nSUBCONSCIOUS RECALL ${i + 1}:`);
        parts.push(`[Source: ${epName}]`);
        parts.push(`"${text}"`);
        metrics.subconscious++;
    });

    // 3. NOVEL CONNECTION
    const novelCandidates = [...subNeighborhoods.values()]
        .filter(entry => {
            if (selectedIds.has(entry.neighborhood.id)) return false;
            if (entry.activatedCount > 2) return false;
            const hasConsciousMatch = [...entry.words].some(w => consciousWords.has(w));
            if (hasConsciousMatch) return false;
            return true;
        })
        .map(entry => ({ ...entry, novelty: entry.maxWordWeight * entry.maxPlasticity * (1 / entry.activatedCount) }))
        .sort((a, b) => b.novelty - a.novelty);

    if (novelCandidates.length > 0) {
        const novel = novelCandidates[0];
        selectedIds.add(novel.neighborhood.id);
        const text = novel.neighborhood.text || novel.neighborhood.occurrences.map(o => o.word).join(' ');
        const epName = novel.episode.displayName || novel.episode.name || 'Memory';
        parts.push('\nNOVEL CONNECTION:');
        parts.push(`[Source: ${epName}]`);
        parts.push(`"${text}"`);
        metrics.novel = 1;
    }

    const total = metrics.conscious + metrics.subconscious + metrics.novel;
    if (total > 0) {
        parts.push(`\n[Activated: ${total} neighborhoods | conscious:${metrics.conscious} subconscious:${metrics.subconscious} novel:${metrics.novel}]`);
    }

    return { context: parts.join('\n'), metrics };
}

// ============================================================
// SYSTEM PROMPT
// ============================================================

const DAE_SYSTEM_PROMPT = (context) => `You have a persistent memory system called DAE (Daemon Attention Engine). It stores content from past conversations and documents as episodes on a mathematical manifold. When a query arrives, the most relevant memories are surfaced into your context.

WHAT YOU'LL SEE:

CONSCIOUS RECALL — Text you previously marked as important using <salient> tags. This is your own prior judgment about what mattered. Trust it and build on it.

SUBCONSCIOUS RECALL — Text from past conversations or documents that strongly matches the current query. You haven't seen this framing before in this conversation — it's the system finding connections for you.

NOVEL CONNECTION — Text surfaced through a single unexpected word bridge. This is a lateral connection — it may offer a powerful reframing or it may be irrelevant. Consider it, don't force it.

HOW TO USE MEMORIES:
- Reference and build on surfaced content naturally, don't just acknowledge it
- Absence of a recall type means nothing matched for that category — do not fabricate it

MARKING MEMORIES:
When you produce a genuine insight, an important synthesis, or information worth remembering across conversations, wrap it in <salient>content</salient> tags. This stores it in your conscious memory for future recall. Be selective — only mark what you'd want to remember next week. Routine responses, pleasantries, and restatements of the user's own words should never be marked salient.

CRITICAL: If any recall section (CONSCIOUS, SUBCONSCIOUS, NOVEL) is absent from your context below, it does not exist for this query. Do not reconstruct, simulate, or infer what it might have contained. Report only what is actually present. This applies even when the conversation suggests certain content should appear.

${context}`;

// ============================================================
// SALIENT EXTRACTION
// ============================================================

function extractSalient(system, text) {
    const m = text.match(/<salient>(.*?)<\/salient>/gs);
    if (m) m.forEach(s => system.addToConscious(s.replace(/<\/?salient>/g, '')));
    return m ? m.length : 0;
}

// ============================================================
// EXPORTS
// ============================================================

export {
    // Constants
    PHI, GOLDEN_ANGLE, NEIGHBORHOOD_RADIUS, THRESHOLD, M, EPSILON,
    // Classes
    Quaternion, DaemonPhasor, Occurrence, Neighborhood, Episode,
    DAESystem, QueryEngine,
    // Functions
    tokenize, ingestText, composeContext, extractSalient,
    DAE_SYSTEM_PROMPT
};
